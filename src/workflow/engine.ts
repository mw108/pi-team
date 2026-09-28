import { appendFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { projectRootSync } from "../config/project.ts";
import {
  loadConfig,
  snapshotDefinition,
  type TeamDefinition,
} from "../config/loader.ts";
import type { AgentRunner } from "../agents/runner.ts";
import {
  parseResult,
  contractSchema,
  type Role,
  type Question,
} from "../agents/schemas.ts";
import {
  assertRelative,
  assertWithin,
  contractPaths,
} from "../agents/permissions.ts";
import {
  discoverCommands,
  commandKey,
  effectiveConfig,
} from "../agents/discovery.ts";
import type { TeamConfig } from "../config/schema.ts";
import { StateStore } from "./persistence.ts";
import {
  baseline,
  git,
  head,
  hashes,
  dirtyPaths,
  prepareCommit,
  createCommit,
} from "./git.ts";
import {
  record,
  block,
  newState,
  type WorkflowState,
  type Phase,
  type ApprovalRequest,
} from "./state.ts";
import { transition } from "./router.ts";
const phaseRoles: Partial<Record<Phase, Role[]>> = {
  ORCHESTRATE: ["orchestrator"],
  RESEARCH: ["researcher"],
  SOLVE: ["solver1", "solver2", "solver3"],
  CRITIQUE: ["critic"],
  REVIEW: ["reviewer"],
  IMPLEMENT: ["implementor"],
  CODE_REVIEW: ["codeReviewer"],
  PENTEST: ["pentester"],
  SECURITY_REVIEW: ["securityReviewer"],
  TEST: ["tester"],
  COMMIT: ["commitAgent"],
};
const mutatingRoles: Role[] = [
  "implementor",
  "tester",
  "pentester",
  "commitAgent",
];
export interface EngineUI {
  progress(state: WorkflowState): void;
  ask(question: Question): Promise<string | undefined>;
  approve?(request: ApprovalRequest): Promise<string[] | undefined>;
}
export class WorkflowEngine {
  readonly store: StateStore;
  constructor(
    readonly cwd: string,
    readonly runner: AgentRunner,
    readonly ui: EngineUI,
  ) {
    this.cwd = projectRootSync(cwd);
    this.store = new StateStore(this.cwd);
  }
  async start(task: string, config: TeamConfig, definition?: TeamDefinition) {
    const root = (await git(this.cwd, ["rev-parse", "--show-toplevel"])).trim();
    if (root !== this.cwd)
      throw new Error("Run /team from the repository root");
    const snapshot = await snapshotDefinition(
      this.cwd,
      config,
      definition?.path,
    );
    if (
      definition &&
      (snapshot.configHash !== definition.configHash ||
        JSON.stringify(snapshot.agentPromptHashes) !==
          JSON.stringify(definition.agentPromptHashes))
    )
      throw new Error(
        "Project team definition changed during workflow startup",
      );
    // Exclude only cache files; project team YAML and prompts are versionable.
    const exclude = resolve(
      this.cwd,
      (await git(this.cwd, ["rev-parse", "--git-path", "info/exclude"])).trim(),
    );
    const patterns = ["/.serena/"];
    const current = await readFile(exclude, "utf8").catch(() => "");
    const missing = patterns.filter((p) => !current.split("\n").includes(p));
    if (missing.length)
      await appendFile(
        exclude,
        `\n# Pi Team Serena cache\n${missing.join("\n")}\n`,
      );
    const state = newState(this.cwd, task, config, await baseline(this.cwd));
    state.teamConfigPath = snapshot.path;
    state.teamConfigHash = snapshot.configHash;
    state.agentPromptHashes = snapshot.agentPromptHashes;
    record(state, "started");
    await this.store.save(state);
    return state;
  }
  async invoke(role: Role, s: WorkflowState, signal?: AbortSignal) {
    let failures = 0;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return {
          result: parseResult(role, await this.runner.run(role, s, signal)),
          failures,
        };
      } catch (e) {
        if (signal?.aborted) throw e;
        failures++;
        const transient =
          /429|503|timeout|timed out|ECONN|fetch failed|network|rate limit/i.test(
            String(e),
          );
        if (
          s.agentFailures + failures >= s.config.workflow.maxAgentFailures ||
          attempt === 1 ||
          mutatingRoles.includes(role) ||
          !transient
        ) {
          const error = new Error(String(e));
          Object.assign(error, { failures });
          throw error;
        }
      }
    }
    throw new Error("Agent failed");
  }
  async recover(s: WorkflowState) {
    if (s.cwd !== this.cwd)
      throw new Error("Workflow belongs to a different repository");
    if (s.inFlight) {
      const unsafe = s.inFlight.roles.some((r) => mutatingRoles.includes(r));
      if (unsafe) {
        block(
          s,
          `Interrupted ${s.inFlight.phase}; inspect repository effects before recovery. Automatic replay of mutating work is disabled.`,
        );
        delete s.inFlight;
        await this.store.save(s);
        return;
      }
      record(s, "recovered", s.inFlight.phase);
      delete s.inFlight;
      await this.store.save(s);
    }
  }
  async resumeReadonly(s: WorkflowState) {
    if (
      s.phase !== "BLOCKED" ||
      !s.blocker?.startsWith("Agent execution failed:")
    )
      return;
    const phase = s.history.findLast((e) => e.event === "blocked")?.phase;
    const roles = phase ? phaseRoles[phase] : undefined;
    // A failed Tester assertion with zero executed commands and no write tools
    // proves there are no command/source side effects to replay.
    const emptyReadOnlyTest =
      phase === "TEST" &&
      !s.config.tester.mayModifyTests &&
      s.blocker.includes("Tester produced no executed validation commands");
    if (
      !phase ||
      !roles ||
      (roles.some((r) => mutatingRoles.includes(r)) && !emptyReadOnlyTest) ||
      s.agentFailures >= s.config.workflow.maxAgentFailures
    )
      return;
    record(s, "explicit_resume", phase);
    s.phase = phase;
    delete s.blocker;
    await this.store.save(s);
  }
  async run(s: WorkflowState, signal?: AbortSignal) {
    const unlock = await this.store.lock();
    try {
      await this.recover(s);
      while (!["DONE", "BLOCKED"].includes(s.phase)) {
        if (signal?.aborted) {
          record(s, "interrupted");
          await this.store.save(s);
          break;
        }
        this.ui.progress(s);
        if (s.pendingApproval?.kind !== "configDrift") {
          if (!s.teamConfigHash || !s.agentPromptHashes || !s.teamConfigPath) {
            block(
              s,
              "Legacy workflow lacks project configuration and prompt hashes; start a new workflow after /team-init --from-global.",
            );
            break;
          }
          const current = await loadConfig(this.cwd);
          const changed: string[] = [];
          if (
            current.path !== s.teamConfigPath ||
            current.configHash !== s.teamConfigHash
          )
            changed.push("team.yaml");
          for (const [slot, hash] of Object.entries(current.agentPromptHashes))
            if (s.agentPromptHashes[slot] !== hash)
              changed.push(current.config.agents[slot as Role].prompt);
          if (changed.length) {
            s.driftCandidate = {
              configPath: current.path,
              configHash: current.configHash,
              agentPromptHashes: current.agentPromptHashes,
              changed,
            };
            s.pendingApproval = {
              kind: "configDrift",
              title: "Project team definition changed",
              prompt: `Review changed project team files before continuing: ${changed.join(", ")}. Abort is the safe default. Resuming restarts reasoning with the new team definition and original cycle limits; after implementation it is unavailable.`,
              options: [
                {
                  value: "resume",
                  label: "Resume with new config",
                  description:
                    "Restart reasoning before implementation with refreshed project prompts and config",
                },
                {
                  value: "abort",
                  label: "Abort this workflow",
                  description: "Preserve state and repository for inspection",
                },
              ],
            };
            s.phase = "WAITING_USER";
            record(s, "configuration_drift", changed.join(", "));
            await this.store.save(s);
            continue;
          }
        }
        if (s.phase === "WAITING_USER") {
          if (s.pendingApproval) {
            if (s.questionCount >= s.config.workflow.maxQuestions) {
              block(s, "User-question limit reached");
              break;
            }
            const request = s.pendingApproval;
            const selected = await this.ui.approve?.(request);
            if (selected === undefined) {
              await this.store.save(s);
              break;
            }
            if (
              new Set(selected).size !== selected.length ||
              selected.some((v) => !request.options.some((o) => o.value === v))
            )
              throw new Error(
                "Approval contains an unknown or duplicate option",
              );
            s.questionCount++;
            record(
              s,
              "approval_submitted",
              JSON.stringify({ kind: request.kind, selected }),
            );
            if (request.kind === "commands") {
              const commands = s.discoveredCommands
                .filter((c) => selected.includes(c.command.id))
                .map((c) => c.command);
              s.approvedCommands = [...s.approvedCommands, ...commands].filter(
                (c, i, all) =>
                  all.findIndex(
                    (other) => commandKey(other) === commandKey(c),
                  ) === i,
              );
              s.commandApprovalComplete = true;
              if (
                !effectiveConfig(s).commands.some((c) =>
                  ["test", "static"].includes(c.purpose),
                ) &&
                s.config.qualityGates.testing.enabled
              )
                block(
                  s,
                  "No validation commands approved; configure trusted commands and start a new workflow",
                );
            } else if (request.kind === "dirtyPaths") {
              for (const path of selected) {
                assertRelative(path);
                if (
                  !s.baseline.dirtyPaths.includes(path) ||
                  !contractPaths(
                    contractSchema.parse(s.results.reviewer),
                  ).includes(path)
                )
                  throw new Error(
                    "Dirty-path approval is outside the contract/baseline",
                  );
              }
              s.approvedDirtyPaths = [
                ...new Set([...s.approvedDirtyPaths, ...selected]),
              ];
              if (request.options.some((o) => !selected.includes(o.value)))
                block(
                  s,
                  "Contract touches pre-existing user changes: dirty file approval denied",
                );
            } else if (request.kind === "configDrift") {
              if (selected.length !== 1 || selected[0] !== "resume") {
                block(
                  s,
                  "Configuration drift was not approved; state and repository preserved.",
                );
              } else {
                const candidate = s.driftCandidate,
                  current = await loadConfig(this.cwd);
                if (
                  !candidate ||
                  candidate.configPath !== current.path ||
                  candidate.configHash !== current.configHash ||
                  JSON.stringify(candidate.agentPromptHashes) !==
                    JSON.stringify(current.agentPromptHashes)
                )
                  block(
                    s,
                    "Team definition changed again during approval; inspect and start a new workflow.",
                  );
                else if (s.results.implementor || s.commitIntent || s.commit)
                  block(
                    s,
                    "Project team changed after implementation; inspect repository effects and start a new workflow.",
                  );
                else if (
                  Object.keys(s.results).length &&
                  s.fullCycle >= s.config.workflow.maxFullCycles
                )
                  block(
                    s,
                    "Full design cycle limit reached before configuration refresh",
                  );
                else {
                  if (Object.keys(s.results).length) s.fullCycle++;
                  for (const role of Object.keys(phaseRoles).flatMap(
                    (phase) => phaseRoles[phase as Phase] ?? [],
                  ))
                    delete s.results[role];
                  s.config = current.config;
                  s.teamConfigPath = current.path;
                  s.teamConfigHash = current.configHash;
                  s.agentPromptHashes = current.agentPromptHashes;
                  s.phase = "ORCHESTRATE";
                  delete s.pendingQuestion;
                  delete s.resumePhase;
                  delete s.gateHashes;
                  record(
                    s,
                    "configuration_refresh",
                    "Reasoning restarted with project definition",
                  );
                }
              }
              delete s.driftCandidate;
            } else
              block(
                s,
                "Manual commit required: inspect and stage approved dirty files yourself. Automatic commit is disabled because hunk ownership cannot be established.",
              );
            if ((s.phase as Phase) === "WAITING_USER")
              s.phase = s.resumePhase ?? "RESEARCH";
            else if (
              (s.phase as Phase) !== "BLOCKED" &&
              request.kind !== "configDrift"
            )
              s.phase = s.resumePhase ?? "RESEARCH";
            delete s.pendingApproval;
            delete s.resumePhase;
            await this.store.save(s);
            continue;
          }
          if (!s.pendingQuestion) {
            block(s, "Missing pending question");
            break;
          }
          if (s.questionCount >= s.config.workflow.maxQuestions) {
            block(s, "User-question limit reached");
            break;
          }
          const answer = await this.ui.ask(s.pendingQuestion);
          if (!answer) {
            await this.store.save(s);
            break;
          }
          s.questionCount++;
          s.answers.push({ question: s.pendingQuestion.question, answer });
          record(s, "user_answer");
          if (s.resumePhase === "ORCHESTRATE" && s.results.researcher) {
            if (s.fullCycle >= s.config.workflow.maxFullCycles) {
              block(
                s,
                "Full design cycle limit reached after requirement clarification",
              );
              await this.store.save(s);
              break;
            }
            s.fullCycle++;
          }
          s.phase = s.resumePhase ?? "ORCHESTRATE";
          delete s.pendingQuestion;
          delete s.resumePhase;
          await this.store.save(s);
          continue;
        }
        if (s.agentFailures >= s.config.workflow.maxAgentFailures) {
          block(s, "Agent failure limit reached");
          break;
        }
        if ((await head(this.cwd)) !== s.baseline.head) {
          block(s, "Git HEAD changed during workflow");
          break;
        }
        if (s.phase !== "ORCHESTRATE" && !s.commandApprovalComplete) {
          s.discoveredCommands = await discoverCommands(this.cwd);
          const candidates = s.discoveredCommands.filter(
            (c) =>
              !s.config.commands.some(
                (known) => commandKey(known) === commandKey(c.command),
              ),
          );
          if (candidates.length) {
            await this.requestApproval(s, {
              kind: "commands",
              title: "Approve repository validation commands",
              prompt:
                "Select commands to approve for this workflow only. Select none to reject all. Repository scripts execute local code; inspect the listed sources before approving.",
              options: candidates.map((c) => ({
                value: c.command.id,
                label: JSON.stringify([
                  c.command.executable,
                  ...c.command.args,
                ]),
                description: `${c.category}; ${c.source}; confidence ${c.confidence}`,
              })),
            });
            continue;
          }
          s.commandApprovalComplete = true;
          if (
            s.config.qualityGates.testing.enabled &&
            !effectiveConfig(s).commands.some((command) =>
              ["test", "static"].includes(command.purpose),
            )
          ) {
            block(
              s,
              "No validation commands discovered or configured; configure trusted argv commands and start a new workflow",
            );
            break;
          }
        }
        if (s.phase === "IMPLEMENT") {
          const paths = contractPaths(contractSchema.parse(s.results.reviewer));
          for (const path of paths) {
            assertRelative(path);
            await assertWithin(this.cwd, path);
          }
          const overlap = paths.filter(
            (path) =>
              s.baseline.dirtyPaths.includes(path) &&
              !s.approvedDirtyPaths.includes(path),
          );
          if (overlap.length) {
            await this.requestApproval(s, {
              kind: "dirtyPaths",
              title: "Allow editing pre-existing user changes?",
              prompt:
                "These exact files already contain user changes. Selected files may be edited using their existing content. They cannot be automatically committed; manual inspection/staging will be required. Select none to deny.",
              options: overlap.map((path) => ({
                value: path,
                label: path,
                description:
                  "Approve editing this exact path for this workflow only",
              })),
            });
            continue;
          }
        }
        if (s.phase === "PENTEST") {
          if (s.pentestCycle >= s.config.workflow.maxPentestCycles) {
            block(s, "Pentest cycle limit reached");
            break;
          }
          s.pentestCycle++;
        }
        // Bind all quality gates to the same file contents. Commands may produce output,
        // but any source change invalidates review rather than silently passing to commit.
        if (
          [
            "CODE_REVIEW",
            "PENTEST",
            "SECURITY_REVIEW",
            "TEST",
            "COMMIT",
          ].includes(s.phase)
        ) {
          const paths = await dirtyPaths(this.cwd),
            snapshot = await hashes(this.cwd, paths);
          if (
            s.gateHashes &&
            JSON.stringify(snapshot) !== JSON.stringify(s.gateHashes)
          ) {
            block(s, "Repository changed after a quality gate; rerun review");
            break;
          }
          s.gateHashes = snapshot;
        }
        if (s.phase === "COMMIT") {
          const overlap = contractPaths(
            contractSchema.parse(s.results.reviewer),
          ).filter((path) => s.baseline.dirtyPaths.includes(path));
          if (overlap.length) {
            await this.requestApproval(s, {
              kind: "manualCommit",
              title: "Manual commit inspection required",
              prompt: `Automatic staging cannot separate original user hunks from workflow hunks in: ${overlap.join(", ")}. Inspect the diff and stage/commit manually after this workflow stops. No automatic commit will be attempted.`,
              options: [
                {
                  value: "acknowledge",
                  label: "I will inspect and commit manually",
                  description:
                    "Stop with state and working-tree content preserved",
                },
              ],
            });
            continue;
          }
        }
        const allRoles = phaseRoles[s.phase];
        if (!allRoles) {
          block(s, "Unknown workflow phase");
          break;
        }
        const runRoles = allRoles.filter(
          (r) => s.phase !== "SOLVE" || !s.results[r],
        );
        s.inFlight = { phase: s.phase, roles: runRoles };
        record(s, "phase_started", runRoles.join(", "));
        await this.store.save(s);
        // Use isolated snapshots. A solver can never observe a sibling's initial output.
        const results = await Promise.allSettled(
          runRoles.map(async (role) => ({
            role,
            ...(await this.invoke(role, structuredClone(s), signal)),
          })),
        );
        // Failure accounting belongs to the authoritative parent, not the isolated snapshots.
        let error: string | undefined;
        let pending: Question | undefined;
        for (let i = 0; i < results.length; i++) {
          const item = results[i];
          if (item.status === "rejected") {
            s.agentFailures += item.reason?.failures ?? 1;
            record(
              s,
              "agent_failure",
              `${runRoles[i]}: ${String(item.reason)}`,
            );
            error = String(item.reason);
            continue;
          }
          const { role, result, failures } = item.value;
          s.agentFailures += failures;
          if (failures)
            record(
              s,
              "agent_recovered",
              `${role}: ${failures} transient failure(s)`,
            );
          if (result.type === "QUESTION_REQUEST") {
            pending = pending
              ? {
                  ...pending,
                  question: `${pending.question}\n${result.question}`,
                  reason: `${pending.reason}\n${result.reason}`,
                }
              : result;
          } else {
            s.results[role] = result;
            record(s, "agent_completed", role);
          }
        }
        delete s.inFlight;
        if (signal?.aborted) {
          record(s, "interrupted");
          if (runRoles.some((r) => mutatingRoles.includes(r)))
            block(
              s,
              "Interrupted mutating phase; inspect effects before recovery",
            );
          await this.store.save(s);
          break;
        }
        if (error) {
          block(s, `Agent execution failed: ${error}`);
          await this.store.save(s);
          break;
        }
        if (pending) {
          record(s, "question_requested", pending.question);
          s.pendingQuestion = pending;
          s.resumePhase = s.phase;
          s.phase = "WAITING_USER";
          await this.store.save(s);
          continue;
        }
        if (s.phase === "REVIEW") {
          const contract = contractSchema.parse(s.results.reviewer);
          for (const path of contractPaths(contract)) {
            assertRelative(path);
            await assertWithin(this.cwd, path);
          }
          if (
            new Set(contractPaths(contract)).size !==
            contractPaths(contract).length
          )
            throw new Error("Contract file lists overlap");
        }
        if (s.phase === "SOLVE")
          for (const role of ["solver1", "solver2", "solver3"])
            if ((s.results[role] as any)?.solverId !== role)
              throw new Error(`Solver identity mismatch: ${role}`);
        if (
          s.phase === "TEST" &&
          s.gateHashes &&
          JSON.stringify(await hashes(this.cwd, await dirtyPaths(this.cwd))) !==
            JSON.stringify(s.gateHashes)
        )
          throw new Error("Validation changed reviewed files");
        if (s.phase === "COMMIT") {
          const result = s.results.commitAgent as any;
          s.commitIntent = await prepareCommit(s, result.files, result.message);
          // Persist intent before a non-idempotent operation. Interrupted commits require inspection.
          s.inFlight = { phase: "COMMIT", roles: ["commitAgent"] };
          await this.store.save(s);
          s.commit = await createCommit(s);
          delete s.inFlight;
        }
        transition(s);
        record(s, "phase_completed");
        await this.store.save(s);
      }
      await this.store.save(s);
      this.ui.progress(s);
      return s;
    } catch (e) {
      block(s, String(e));
      await this.store.save(s);
      this.ui.progress(s);
      return s;
    } finally {
      await unlock();
    }
  }
  async requestApproval(s: WorkflowState, request: ApprovalRequest) {
    s.pendingApproval = request;
    s.resumePhase = s.phase;
    s.phase = "WAITING_USER";
    record(s, "approval_requested", request.kind);
    await this.store.save(s);
  }
}
