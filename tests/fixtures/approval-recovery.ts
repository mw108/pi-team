import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import YAML from "yaml";
import { FixtureRunner, repository, config } from "../helpers.ts";
import { WorkflowEngine } from "../../src/workflow/engine.ts";
import { gateSnapshot, repositorySnapshot } from "../../src/workflow/git.ts";
import { normalizedRuntimeCommand } from "../../src/agents/runtime-commands.ts";
import { validateState } from "../../src/workflow/state.ts";

// The incident's lifecycle/IDs are retained; repository, config, commands, and
// snapshots are synthetic. No customer paths, tokens, or command bodies copied.
export async function approvalRecoveryFixture(
  decision: string | null = "allow_workflow",
) {
  const cwd = await repository();
  const cfg = config();
  cfg.qualityGates.pentest.enabled = true;
  cfg.qualityGates.commit.enabled = false;
  cfg.logging.agentLogs.level = "off";
  await writeFile(join(cwd, ".pi/team/team.yaml"), YAML.stringify(cfg));
  const runner = new FixtureRunner();
  const engine = new WorkflowEngine(cwd, runner, {
    progress() {},
    ask: async () => undefined,
  });
  const base = await engine.start("Synthetic approval recovery", cfg);
  await engine.run(base);
  if (base.phase !== "DONE") throw new Error(base.blocker);
  const incident = JSON.parse(
    await readFile(
      new URL("./resolved-command-approval.json", import.meta.url),
      "utf8",
    ),
  );
  const command = normalizedRuntimeCommand(
    {
      executable: "php",
      args: ["tinker", "--execute=", "$token='synthetic-value';"],
      purpose: "Synthetic authentication inspection",
      category: "pentest",
    },
    "pentester",
  ).command;
  for (const event of incident.history)
    event.detail = event.detail.replaceAll("detected-61c1f5e4d00a", command.id);
  const state = validateState({
    ...base,
    ...incident,
    history: [
      ...base.history.filter((e) =>
        [
          "ORCHESTRATE",
          "RESEARCH",
          "SOLVE",
          "CRITIQUE",
          "REVIEW",
          "IMPLEMENT",
          "CODE_REVIEW",
        ].includes(e.phase),
      ),
      ...incident.history
        .filter(
          (e: any) =>
            decision !== null || e.event !== "command_approval_decided",
        )
        .map((e: any) =>
          e.event === "command_approval_decided"
            ? { ...e, detail: `pentester ${decision} ${command.id}` }
            : e,
        ),
    ],
  });
  for (const role of [
    "pentester",
    "securityReviewer",
    "tester",
    "commitAgent",
    "reporter",
  ])
    delete state.results[role];
  delete state.reportInput;
  delete state.commitOutcome;
  delete state.commitSelection;
  delete state.inFlight;
  delete state.manualRetry;
  state.gateHashes = await gateSnapshot(state);
  state.gateRepositorySnapshot = await repositorySnapshot(cwd);
  state.gateRepositorySnapshot.capturedAt = "2026-11-17T14:28:00.000Z";
  if (decision === null)
    state.pendingRuntimeCommands.push({
      workflowId: state.id,
      agentId: "pentester",
      run: 1,
      requestId: "d1fd31fc-c5ee-4d8d-bdf3-12d297fb7bcb",
      command,
      purpose: "Synthetic authentication inspection",
    });
  if (decision === "allow_workflow")
    state.runtimeCommandApprovals.push({ role: "pentester", command });
  await engine.store.save(state);
  return { cwd, state, engine, runner, command };
}
