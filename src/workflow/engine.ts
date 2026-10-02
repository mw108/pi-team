import { appendFile, readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
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
  contractPaths,
  validateContractPaths,
} from "../agents/permissions.ts";
import {
  discoverCommands,
  commandKey,
  effectiveConfig,
} from "../agents/discovery.ts";
import type { TeamConfig, Command } from "../config/schema.ts";
import {
  normalizedRuntimeCommand,
  proposeSimilarRule,
  ruleMatches,
  type RuntimeCommandRequest,
} from "../agents/runtime-commands.ts";
import { getAgentDisplayName } from "../ui/agent-name.ts";
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
import { phaseRoles, getPhaseRoles, transition } from "./router.ts";
import {
  getActiveSolverIds,
  getRequiredSuccessfulSolverCount,
  getFailureBudgetUsed,
  inactiveSolverError,
} from "../config/solvers.ts";
import { solverIds } from "../agents/schemas.ts";
import { getWorkflowRecoveryPlan } from "./recovery.ts";
import {
  analyzeConfigDrift,
  acceptConfigDrift,
  driftSummary,
} from "../config/drift.ts";
import { getErrorMessage } from "../agents/error-message.ts";
import { toolCallSummary } from "../agents/tool-summary.ts";
import {
  commandSummary,
  formatCommandLine,
} from "../agents/command-observability.ts";
import { approvedCommandsForRole } from "../agents/commands.ts";
import type { AgentEvent } from "../ui/runtime.ts";
import {
  AgentAbortedByUserError,
  AgentSupersededForRetryError,
  AgentDoomLoopError,
  AgentTimeoutError,
  classifyFailure,
  explainFailure,
  getAgentTimeoutMs,
  safeFailureLabel,
} from "../agents/errors.ts";
import { ActiveSessionRegistry } from "../agents/active-sessions.ts";
import {
  AgentLogStore,
  AttemptLogger,
  redactVisibleText,
} from "./agent-logs.ts";
import { classifyToolActivity } from "../ui/activity.ts";
import {
  containsTerminated,
  firstErrorCode,
  serializeErrorDiagnostics,
} from "../agents/error-diagnostics.ts";
import type { ProviderRequestEvent } from "../agents/network-retry.ts";
import {
  buildCompletionReportInput,
  finalizeReport,
  fallbackReport,
  type CompletionReportInput,
} from "./report.ts";
const mutatingRoles: Role[] = [
  "implementor",
  "tester",
  "pentester",
  "commitAgent",
];
type AttemptControl = {
  workflowId: string;
  controller: AbortController;
  attempt: number;
  intention?: "abort" | "retry" | "superseded";
  settled?: boolean;
};
export interface EngineUI {
  progress(state: WorkflowState): void;
  ask(question: Question): Promise<string | undefined>;
  askResearchQuestions?(
    questions: string[],
  ): Promise<{ question: string; answer: string }[] | undefined>;
  approve?(request: ApprovalRequest): Promise<string[] | undefined>;
  agentEvent?(event: AgentEvent): void;
}
export class WorkflowEngine {
  readonly store: StateStore;
  readonly logs: AgentLogStore;
  readonly sessions = new ActiveSessionRegistry();
  private readonly activeAttempts = new Map<Role, AttemptControl>();
  private readonly retryRequests = new Set<Role>();
  private readonly manualReruns = new Set<Role>();
  private pendingRewind?: { workflowId: string; role: Role; phase: Phase };
  private running = false;
  private runningWorkflowId?: string;
  private continuingPhase?: Phase;
  private historyWrite = Promise.resolve();
  private commandApprovalQueue = Promise.resolve();
  private runtimeApprovalPrompt(
    s: WorkflowState,
    role: Role,
    command: Command,
    purpose: string,
  ): ApprovalRequest {
    const rule = proposeSimilarRule(command);
    const line = formatCommandLine(command);
    const label = getAgentDisplayName(s.config, role);
    const ruleLine = rule
      ? [rule.executable, ...rule.argsPrefix, "*"].join(" ")
      : "";
    const examples = rule
      ? [
          [rule.executable, ...rule.argsPrefix].join(" "),
          [rule.executable, ...rule.argsPrefix, "--filter=OtherTest"].join(" "),
          [
            rule.executable,
            ...rule.argsPrefix,
            "tests/Feature/AuthTest.php",
          ].join(" "),
        ].join("\n")
      : "";
    const discovered = s.discoveredCommands.find(
      (item) => commandKey(item.command) === commandKey(command),
    );
    const metadata = discovered
      ? `\nSource: ${redactVisibleText(discovered.source)}\nConfidence: ${discovered.confidence}`
      : "";
    return {
      kind: "runtimeCommand",
      title: `${label} requests command approval`,
      prompt: `${label} wants to run:\n${line}\n\nPurpose: ${discovered?.command.purpose ?? redactVisibleText(purpose)}${metadata}${discovered ? `\nReason: ${redactVisibleText(purpose)}` : ""}${rule ? `\n\nAllow similar rule: ${ruleLine}\nThis would also allow:\n${examples}\nIt would NOT allow:\nphp artisan migrate:fresh` : ""}`,
      options: [
        {
          value: "allow_once",
          label: "Allow once",
          description: "Execute this exact command one time",
        },
        {
          value: "allow_workflow",
          label: "Allow for workflow",
          description: "Approve this exact argv for this workflow",
        },
        ...(rule
          ? [
              {
                value: "allow_similar",
                label: "Allow similar",
                description: `Approve the displayed prefix rule: ${ruleLine}`,
              },
            ]
          : []),
        {
          value: "deny",
          label: "Deny",
          description: "Do not execute this command",
        },
      ],
    };
  }
  private saveRuntimeApproval(
    s: WorkflowState,
    command: Command,
    choice: string,
  ) {
    if (choice === "allow_workflow" || choice === "allow_similar") {
      if (
        !s.approvedCommands.some(
          (item) => commandKey(item) === commandKey(command),
        )
      )
        s.approvedCommands.push(command);
      if (!s.runtimeApprovedCommandIds.includes(command.id))
        s.runtimeApprovedCommandIds.push(command.id);
      const rule =
        choice === "allow_similar" ? proposeSimilarRule(command) : undefined;
      if (
        rule &&
        !s.similarCommandRules.some(
          (item) => JSON.stringify(item) === JSON.stringify(rule),
        )
      )
        s.similarCommandRules.push(rule);
    }
  }
  private async runtimeCommandApproval(
    s: WorkflowState,
    agentState: WorkflowState,
    role: Role,
    control: AttemptControl,
    command: Command,
    request: RuntimeCommandRequest,
    signal: AbortSignal | undefined,
    log: (event: { type: string; [key: string]: unknown }) => void,
  ): Promise<"allow" | "deny" | "pending"> {
    const current = () =>
      control.workflowId === s.id &&
      this.activeAttempts.get(role) === control &&
      !control.intention &&
      !control.settled &&
      !signal?.aborted;
    if (!current()) return "pending";
    const approved = () =>
      approvedCommandsForRole(role, effectiveConfig(s)).some(
        (item) => commandKey(item) === commandKey(command),
      ) || s.similarCommandRules.some((rule) => ruleMatches(rule, command));
    if (approved()) {
      agentState.approvedCommands = structuredClone(s.approvedCommands);
      agentState.similarCommandRules = structuredClone(s.similarCommandRules);
      this.emitAgentEvent({
        type: "commandApproved",
        role,
        command: commandSummary(command.id, command),
      });
      return "allow";
    }
    const pending = {
      workflowId: s.id,
      agentId: role,
      run: control.attempt,
      requestId: randomUUID(),
      command,
      purpose: request.purpose,
    };
    s.pendingRuntimeCommands.push(pending);
    const safe = commandSummary(command.id, command);
    log({
      type: "command_approval_requested",
      agent: role,
      run: control.attempt,
      requestId: pending.requestId,
      ...safe,
      purpose: redactVisibleText(request.purpose),
    });
    await this.persistAttempt(
      s,
      "command_approval_requested",
      `${role} requested ${command.id}`,
      { agent: role, attempt: control.attempt },
    );
    this.ui.progress(s);
    const decide = async (): Promise<"allow" | "deny" | "pending"> => {
      if (!current()) return "pending";
      if (approved()) {
        s.pendingRuntimeCommands = s.pendingRuntimeCommands.filter(
          (item) => item.requestId !== pending.requestId,
        );
        await this.store.save(s);
        agentState.approvedCommands = structuredClone(s.approvedCommands);
        agentState.similarCommandRules = structuredClone(s.similarCommandRules);
        this.emitAgentEvent({
          type: "commandApproved",
          role,
          command: commandSummary(command.id, command),
        });
        return "allow";
      }
      const approval = this.runtimeApprovalPrompt(
        s,
        role,
        command,
        request.purpose,
      );
      const aborted = new Promise<undefined>((resolve) => {
        if (signal?.aborted) resolve(undefined);
        else
          signal?.addEventListener("abort", () => resolve(undefined), {
            once: true,
          });
      });
      const selected = await Promise.race([
        this.ui.approve?.(approval) ?? Promise.resolve(undefined),
        aborted,
      ]);
      if (
        !current() ||
        !s.pendingRuntimeCommands.some(
          (item) =>
            item.requestId === pending.requestId &&
            item.workflowId === s.id &&
            item.agentId === role &&
            item.run === control.attempt,
        )
      )
        return "pending";
      const choice = selected?.length === 1 ? selected[0] : undefined;
      if (!choice) return "pending";
      if (
        !["allow_once", "allow_workflow", "allow_similar", "deny"].includes(
          choice,
        ) ||
        (choice === "allow_similar" && !proposeSimilarRule(command))
      )
        return "pending";
      this.saveRuntimeApproval(s, command, choice);
      agentState.approvedCommands = structuredClone(s.approvedCommands);
      agentState.similarCommandRules = structuredClone(s.similarCommandRules);
      s.pendingRuntimeCommands = s.pendingRuntimeCommands.filter(
        (item) => item.requestId !== pending.requestId,
      );
      log({
        type: "command_approval_decided",
        agent: role,
        run: control.attempt,
        requestId: pending.requestId,
        decision: choice,
        ...(choice === "allow_similar"
          ? { rule: proposeSimilarRule(command) }
          : {}),
      });
      await this.persistAttempt(
        s,
        "command_approval_decided",
        `${role} ${choice} ${command.id}`,
        { agent: role, attempt: control.attempt },
      );
      if (choice !== "deny")
        this.emitAgentEvent({
          type: "commandApproved",
          role,
          command: commandSummary(command.id, command),
        });
      this.ui.progress(s);
      return choice === "deny" ? "deny" : "allow";
    };
    const turn = this.commandApprovalQueue.then(decide);
    this.commandApprovalQueue = turn.then(
      () => {},
      () => {},
    );
    try {
      return await turn;
    } finally {
      if (!current()) {
        s.pendingRuntimeCommands = s.pendingRuntimeCommands.filter(
          (item) => item.requestId !== pending.requestId,
        );
        await this.store.save(s);
      }
    }
  }
  private async persistAttempt(
    state: WorkflowState,
    event: string,
    detail: string,
    meta: NonNullable<WorkflowState["history"][number]["meta"]>,
  ) {
    record(state, event, detail, meta);
    this.historyWrite = this.historyWrite.then(() => this.store.save(state));
    await this.historyWrite;
  }
  private emitAgentEvent(event: AgentEvent) {
    try {
      this.ui.agentEvent?.(event);
    } catch {
      // Progress is observational; it must not change routing or permissions.
    }
  }
  constructor(
    readonly cwd: string,
    readonly runner: AgentRunner,
    readonly ui: EngineUI,
  ) {
    this.cwd = projectRootSync(cwd);
    this.store = new StateStore(this.cwd);
    this.logs = new AgentLogStore(this.cwd);
  }
  activeAttempt(role: Role) {
    return this.activeAttempts.get(role);
  }
  async steer(state: WorkflowState, role: Role, message: string) {
    this.assertActiveAgent(state, role);
    if (!message.trim()) throw new Error("Steering message is required.");
    const attempt = this.activeAttempts.get(role);
    if (
      !attempt ||
      attempt.workflowId !== state.id ||
      attempt.intention ||
      attempt.settled
    )
      throw new Error(
        `Agent "${getAgentDisplayName(state.config, role)}" (${role}) is not currently running.`,
      );
    const logger = new AttemptLogger(
      this.logs.path(state.id, role, attempt.attempt),
    );
    logger.append({
      type: "agent_steer_requested",
      agent: role,
      attempt: attempt.attempt,
    });
    await logger.flush();
    const entry = await this.sessions.steer(state.id, role, message);
    entry.resetDoomLoop?.();
    logger.append({
      type: "agent_steer",
      agent: role,
      attempt: attempt.attempt,
      message: redactVisibleText(message),
    });
    await logger.flush();
    await this.persistAttempt(
      state,
      "agent_steered",
      `${role} steering message queued`,
      { agent: role, attempt: attempt.attempt },
    );
    this.emitAgentEvent({ type: "steer", role });
    const clearWhenConsumed = () => {
      if (
        this.sessions.get(state.id, role) !== entry ||
        entry.session.getSteeringMessages().length === 0
      ) {
        this.emitAgentEvent({ type: "steerClear", role });
        return;
      }
      setTimeout(clearWhenConsumed, 250).unref?.();
    };
    setTimeout(clearWhenConsumed, 250).unref?.();
  }
  async abortAgent(state: WorkflowState, role: Role) {
    this.assertActiveAgent(state, role);
    const control = this.activeAttempts.get(role);
    if (
      !control ||
      control.workflowId !== state.id ||
      control.intention ||
      control.settled
    )
      throw new Error(
        `Agent "${getAgentDisplayName(state.config, role)}" (${role}) is not currently running.`,
      );
    control.intention = "abort";
    const session = this.sessions.get(state.id, role);
    if (session) session.state = "aborting";
    this.emitAgentEvent({ type: "aborting", role });
    control.controller.abort();
  }
  retryConfirmation(state: WorkflowState, role: Role) {
    if (role === "reporter" && state.reportFailure) return undefined;
    if (
      role === "pentester" &&
      (state.results.pentester as any)?.status === "BLOCKED"
    )
      return undefined;
    const settled = this.activeAttempts.get(role);
    if (
      !state.results[role] &&
      !(settled?.workflowId === state.id && settled.settled)
    )
      return undefined;
    const downstream = this.dependentRoles(role).filter(
      (key) => state.results[key],
    );
    return `${getAgentDisplayName(state.config, role)} (${role}) already completed successfully. Retrying will replace its result${downstream.length ? ` and invalidate ${downstream.map((id) => getAgentDisplayName(state.config, id)).join(", ")}` : ""}. Continue?`;
  }
  async retryAgent(state: WorkflowState, role: Role, confirmed = false) {
    this.assertActiveAgent(state, role);
    const label = getAgentDisplayName(state.config, role);
    if (this.runningWorkflowId && this.runningWorkflowId !== state.id)
      throw new Error("Workflow mismatch for agent retry.");
    const control = this.activeAttempts.get(role);
    if (control && control.workflowId !== state.id)
      throw new Error("Workflow mismatch for agent retry.");
    if (control && control.workflowId === state.id && !control.settled) {
      if (control.intention)
        throw new Error(
          `Agent ${label} (${role}) is already ${control.intention === "retry" ? "restarting" : "aborting"}.`,
        );
      control.intention = "retry";
      this.retryRequests.add(role);
      const session = this.sessions.get(state.id, role);
      if (session) session.state = "retrying";
      this.emitAgentEvent({
        type: "restarting",
        role,
        attempt: control.attempt + 1,
      });
      control.controller.abort();
      return "restarting";
    }
    if (this.retryRequests.has(role))
      throw new Error(`Agent ${label} (${role}) is already restarting.`);
    if (state.manualRetry && state.manualRetry.agent !== role)
      throw new Error(
        `Agent ${getAgentDisplayName(state.config, state.manualRetry.agent)} (${state.manualRetry.agent}) already has a pending manual retry.`,
      );
    if (this.retryConfirmation(state, role) && !confirmed)
      throw new Error(
        `Retrying completed ${label} (${role}) requires confirmation.`,
      );
    const targetPhase = (Object.keys(phaseRoles) as Phase[]).find((phase) =>
      getPhaseRoles(state, phase)?.includes(role),
    );
    if (!targetPhase) throw new Error(`Unknown agent ${role}`);
    if (this.nextAttempt(state, role) === 1 && !state.results[role])
      throw new Error(`Agent ${label} (${role}) has no attempt to retry yet.`);
    if (this.running && state.phase !== targetPhase) {
      if (
        targetPhase === "SOLVE" &&
        state.phase === "CRITIQUE" &&
        !state.inFlight &&
        !state.results.critic &&
        this.activeAttempts.size === 0
      ) {
        this.prepareManualRetry(state, role, targetPhase);
        await this.store.save(state);
        return "queued";
      }
      const currentRoles = getPhaseRoles(state, state.phase) ?? [];
      if (
        this.pendingRewind ||
        !state.inFlight ||
        this.activeAttempts.size === 0 ||
        currentRoles.some((currentRole) =>
          mutatingRoles.includes(currentRole),
        ) ||
        ![
          "ORCHESTRATE",
          "RESEARCH",
          "SOLVE",
          "CRITIQUE",
          "REVIEW",
          "CODE_REVIEW",
          "SECURITY_REVIEW",
        ].includes(state.phase)
      )
        throw new Error(
          `Cannot retry ${label} (${role}) while ${state.phase} is running. Stop the workflow before rewinding this agent.`,
        );
      const order = Object.keys(phaseRoles) as Phase[];
      if (order.indexOf(state.phase) <= order.indexOf(targetPhase))
        throw new Error(
          `Agent ${label} (${role}) is not available in the current workflow phase.`,
        );
      if (
        state.results.implementor ||
        state.history.some(
          (event) =>
            event.phase === "IMPLEMENT" && event.event === "phase_started",
        )
      )
        throw new Error(
          `Cannot rewind ${label} (${role}) after implementation; inspect repository changes and start a new workflow.`,
        );
      this.pendingRewind = { workflowId: state.id, role, phase: targetPhase };
      for (const [activeRole, active] of this.activeAttempts)
        if (active.workflowId === state.id && !active.settled) {
          active.intention = "superseded";
          this.emitAgentEvent({ type: "aborting", role: activeRole });
          active.controller.abort();
        }
      return "queued";
    }
    if (this.running && state.phase === targetPhase) {
      this.retryRequests.add(role);
      this.manualReruns.add(role);
      state.manualRetry = { agent: role, phase: targetPhase };
      await this.persistAttempt(
        state,
        "agent_retry_requested_by_user",
        `${role} manual retry queued`,
        {
          agent: role,
          attempt: Math.max(1, this.nextAttempt(state, role) - 1),
        },
      );
      return "queued";
    }
    this.prepareManualRetry(state, role, targetPhase);
    await this.store.save(state);
    return "prepared";
  }
  private prepareManualRetry(state: WorkflowState, role: Role, phase: Phase) {
    const label = getAgentDisplayName(state.config, role);
    if (role !== "reporter" && (state.commit || state.phase === "DONE"))
      throw new Error(
        "Completed workflow cannot be retried after commit or completion.",
      );
    const order = Object.keys(phaseRoles) as Phase[];
    const current =
      state.phase === "BLOCKED"
        ? state.history.findLast((e) => e.event === "blocked")?.phase
        : state.phase;
    if (
      (!current || order.indexOf(current) < order.indexOf(phase)) &&
      !(role === "reporter" && state.phase === "DONE")
    )
      throw new Error(
        `Agent ${label} (${role}) is not available in the current workflow phase.`,
      );
    if (state.phase === "BLOCKED") {
      const failure = state.history.findLast(
        (e) => e.event === "agent_failure",
      );
      if (state.blocker?.startsWith("Agent execution failed:")) {
        if (failure?.detail.startsWith(`${role}:`))
          state.agentFailures = Math.max(0, state.agentFailures - 1);
        else if (!state.blocker.includes(`Agent ${role} aborted by user`))
          throw new Error(`Cannot clear unrelated blocker: ${state.blocker}`);
      } else if (state.blocker?.startsWith("Command approval pending for ")) {
        const waiting = state.blocker
          .slice("Command approval pending for ".length)
          .split(";", 1)[0]
          .split(", ");
        if (!waiting.includes(role))
          throw new Error(`Cannot clear unrelated blocker: ${state.blocker}`);
      } else if (role === "reporter" && state.reportFailure) {
        // Presentation can be retried after work has completed.
      } else if (
        role === "pentester" &&
        state.blocker?.startsWith("Pentest blocked:")
      ) {
        // An environmental block is a completed result, not an agent failure.
      } else if (!(
        (state.blocker?.startsWith("Insufficient Solver proposals") ||
          state.blocker?.startsWith("Solver quorum not reached")) &&
        role.startsWith("solver")
      ))
        throw new Error(`Cannot clear unrelated blocker: ${state.blocker}`);
    }
    if (
      ["ORCHESTRATE", "RESEARCH", "SOLVE", "CRITIQUE", "REVIEW"].includes(
        phase,
      ) &&
      (state.results.implementor ||
        state.history.some(
          (event) =>
            event.phase === "IMPLEMENT" && event.event === "phase_started",
        ))
    )
      throw new Error(
        `Cannot rewind ${label} (${role}) after implementation; inspect repository changes and start a new workflow.`,
      );
    state.phase = phase;
    delete state.blocker;
    state.manualRetry = { agent: role, phase };
    this.manualReruns.add(role);
    record(state, "agent_retry_requested_by_user", `${role} manual retry`, {
      agent: role,
      attempt: Math.max(1, this.nextAttempt(state, role) - 1),
    });
  }
  private dependentRoles(role: Role): Role[] {
    const all: Role[] = [
      "orchestrator",
      "researcher",
      ...solverIds,
      "critic",
      "reviewer",
      "implementor",
      "codeReviewer",
      "pentester",
      "securityReviewer",
      "tester",
      "commitAgent",
      "reporter",
    ];
    if (role.startsWith("solver")) return all.slice(all.indexOf("critic"));
    return all.slice(all.indexOf(role) + 1);
  }
  private assertActiveAgent(state: WorkflowState, role: Role) {
    if (
      solverIds.includes(role as any) &&
      !getActiveSolverIds(state.config).includes(role as any)
    )
      throw new Error(
        inactiveSolverError(state.config, role) ?? `Unknown agent ${role}`,
      );
  }
  private invalidateDependents(state: WorkflowState, role: Role) {
    for (const dependent of this.dependentRoles(role)) {
      if (state.results[dependent])
        state.results[`previous_${dependent}`] = state.results[dependent];
      delete state.results[dependent];
    }
    delete state.gateHashes;
    delete state.commitIntent;
    record(state, "downstream_invalidated", `After manual retry of ${role}`);
  }
  private nextAttempt(state: WorkflowState, role: Role) {
    return (
      Math.max(
        0,
        ...state.history
          .filter(
            (h) =>
              h.event === "agent_attempt_started" && h.meta?.agent === role,
          )
          .map((h) => h.meta!.attempt),
      ) + 1
    );
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
    state.semanticConfigHash = snapshot.semanticConfigHash;
    state.driftConfigSnapshot = snapshot.config;
    state.agentPromptHashes = snapshot.agentPromptHashes;
    record(state, "started");
    await this.store.save(state);
    return state;
  }
  async invoke(
    role: Role,
    s: WorkflowState,
    signal?: AbortSignal,
    authoritative = s,
    manualStart = false,
  ) {
    let failures = 0;
    let automaticRetries = 0;
    let trigger:
      | "initial"
      | "automatic_retry"
      | "manual_retry"
      | "manual_continue"
      | "user_clarification"
      | "fix_local"
      | "fix_design"
      | "fix_requirements"
      | "pentest_remediation"
      | "security_remediation"
      | "test_remediation" =
      manualStart || authoritative.manualRetry?.agent === role
        ? "manual_retry"
        : role === "researcher" && authoritative.researchClarificationPending
          ? "user_clarification"
          : authoritative.phase === this.continuingPhase
            ? "manual_continue"
            : (() => {
                const lastStart = authoritative.history.findLastIndex(
                  (h) =>
                    h.event === "agent_attempt_started" &&
                    h.meta?.agent === role,
                );
                const returned = authoritative.history
                  .slice(lastStart + 1)
                  .findLast((h) =>
                    ["FIX_LOCAL", "FIX_DESIGN", "FIX_REQUIREMENTS"].includes(
                      h.event,
                    ),
                  );
                if (!returned) return "initial";
                if (returned.detail === "CODE_REVIEW")
                  return returned.event === "FIX_LOCAL"
                    ? "fix_local"
                    : returned.event === "FIX_DESIGN"
                      ? "fix_design"
                      : "fix_requirements";
                if (returned.detail === "SECURITY_REVIEW")
                  return "security_remediation";
                if (returned.detail === "PENTEST") return "pentest_remediation";
                if (returned.detail === "TEST") return "test_remediation";
                return "initial";
              })();
    for (;;) {
      const timeoutMs = getAgentTimeoutMs(s.config, role);
      const timeoutMode = timeoutMs === undefined ? "unlimited" : "limited";
      const prior = authoritative.history
        .filter(
          (h) => h.event === "agent_attempt_started" && h.meta?.agent === role,
        )
        .map((h) => h.meta!.attempt);
      const logged =
        s.config.logging.agentLogs.level === "off"
          ? undefined
          : await this.logs
              .create(s.id, role, Math.max(0, ...prior) + 1)
              .catch(() => undefined);
      const attemptNumber = logged?.attempt ?? Math.max(0, ...prior) + 1;
      const retryNumber =
        authoritative.history.filter(
          (h) =>
            h.event === "agent_attempt_started" &&
            h.meta?.agent === role &&
            (h.meta.trigger === "manual_retry" ||
              h.meta.trigger === "automatic_retry"),
        ).length +
        (trigger === "manual_retry" || trigger === "automatic_retry" ? 1 : 0);
      const control: AttemptControl = {
        workflowId: s.id,
        controller: new AbortController(),
        attempt: attemptNumber,
      };
      if (this.activeAttempts.has(role))
        throw new Error(`${role} already has an active attempt`);
      this.activeAttempts.set(role, control);
      const abortForWorkflow = () => control.controller.abort();
      signal?.addEventListener("abort", abortForWorkflow, { once: true });
      if (signal?.aborted) control.controller.abort();
      this.retryRequests.delete(role);
      this.emitAgentEvent({
        type: "start",
        role,
        attempt: attemptNumber,
        trigger,
        retryNumber,
      });
      const started = Date.now();
      const calls = new Map<string, { name: string; started: number }>();
      const networkHistoryWrites: Promise<void>[] = [];
      let providerRequests = 0;
      let failedRequest:
        (ProviderRequestEvent & Record<string, unknown>) | undefined;
      let networkRetries = 0;
      let networkRetriesExhausted = false;
      try {
        if (trigger === "manual_retry")
          logged?.logger.append({
            type: "agent_retry_requested_by_user",
            agent: role,
            previousAttempt: Math.max(0, attemptNumber - 1),
            nextAttempt: attemptNumber,
          });
        logged?.logger.append({
          type: "agent_start",
          agent: role,
          attempt: attemptNumber,
          timeoutMs: timeoutMs ?? null,
          timeoutMode,
          trigger,
        });
        await this.persistAttempt(
          authoritative,
          "agent_attempt_started",
          `${role} run ${attemptNumber} started`,
          {
            agent: role,
            attempt: attemptNumber,
            retryNumber,
            timeoutMs: timeoutMs ?? null,
            timeoutMode,
            trigger,
          },
        );
        const result = parseResult(
          role,
          await this.runner.run(
            role,
            s,
            control.controller.signal,
            (toolName, toolCallId, innerToolName, success, input) => {
              const key = toolCallId ?? "single";
              let command: ReturnType<typeof commandSummary> | undefined;
              if (toolName) {
                const activity = classifyToolActivity(
                  toolName,
                  s.config,
                  innerToolName,
                );
                const rawName =
                  toolName === "mcp" && innerToolName
                    ? innerToolName
                    : toolName;
                calls.set(key, {
                  name: /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/.test(rawName)
                    ? rawName
                    : "unknown_tool",
                  started: Date.now(),
                });
                const inputSummary = toolCallSummary(rawName, input, s.cwd);
                const commandId =
                  rawName === "team_command" &&
                  typeof inputSummary?.command === "string"
                    ? inputSummary.command
                    : undefined;
                let approved = commandId
                  ? approvedCommandsForRole(role, effectiveConfig(s)).find(
                      (item) => item.id === commandId,
                    )
                  : undefined;
                if (!commandId && rawName === "team_command") {
                  try {
                    const requested = normalizedRuntimeCommand(
                      input,
                      role,
                    ).command;
                    approved = approvedCommandsForRole(
                      role,
                      effectiveConfig(s),
                    ).find(
                      (item) => commandKey(item) === commandKey(requested),
                    );
                  } catch {
                    /* Malformed model input is never resolved for logging. */
                  }
                }
                command = approved
                  ? commandSummary(approved.id, approved)
                  : commandId
                    ? commandSummary(commandId)
                    : undefined;
                const summary = command ?? inputSummary;
                logged?.logger.append({
                  type: "tool_start",
                  tool: calls.get(key)!.name,
                  activity: activity.label,
                  ...(activity.provider ? { provider: activity.provider } : {}),
                  ...(summary ? { summary } : {}),
                });
              } else {
                const call = calls.get(key);
                if (call) {
                  logged?.logger.append({
                    type: "tool_end",
                    tool: call.name,
                    durationMs: Date.now() - call.started,
                    success: success ?? true,
                  });
                  calls.delete(key);
                }
              }
              this.emitAgentEvent(
                toolName
                  ? {
                      type: "activity",
                      role,
                      toolName,
                      toolCallId,
                      innerToolName,
                      ...(command ? { command } : {}),
                    }
                  : { type: "activityEnd", role, toolCallId },
              );
            },
            attemptNumber,
            (text) =>
              logged?.logger.append({
                type: "assistant_output",
                text: redactVisibleText(text),
              }),
            (event) => {
              networkRetries = Math.max(networkRetries, event.retry);
              if (event.type === "network_retries_exhausted")
                networkRetriesExhausted = true;
              logged?.logger.append({
                ...event,
                agentAttempt: attemptNumber,
                networkRetry: event.retry,
                message: redactVisibleText(event.message),
              });
              if (event.type === "network_retry_scheduled")
                this.emitAgentEvent({
                  type: "networkRetry",
                  role,
                  retry: event.retry,
                  maxRetries: event.maxRetries,
                  delayMs: event.delayMs!,
                  category: event.category,
                  retryAt: Date.now() + event.delayMs!,
                });
              if (event.type === "network_retry_started")
                this.emitAgentEvent({ type: "networkStarted", role });
              if (
                event.type === "network_recovered" ||
                event.type === "network_retries_exhausted"
              )
                this.emitAgentEvent({ type: "networkClear", role });
              if (
                (event.type === "network_retry_started" && event.retry === 1) ||
                event.type === "network_recovered" ||
                event.type === "network_retries_exhausted"
              )
                networkHistoryWrites.push(
                  this.persistAttempt(
                    authoritative,
                    event.type,
                    `${role} ${event.type.replaceAll("_", " ")} ${event.retry}`,
                    {
                      agent: role,
                      attempt: attemptNumber,
                      networkRetry: event.retry,
                      reason: event.category,
                    },
                  ),
                );
            },
            this.sessions,
            (event) => {
              if (control.intention || control.settled) return;
              const safeTool =
                event.type === "doom_loop_detected" &&
                /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/.test(event.tool)
                  ? event.tool
                  : "unknown_tool";
              logged?.logger.append({
                ...event,
                ...(event.type === "doom_loop_detected"
                  ? { tool: safeTool }
                  : {}),
                agentAttempt: attemptNumber,
              });
              const label =
                event.type === "doom_loop_detected"
                  ? `${role} repeated ${safeTool} tool pattern detected`
                  : event.type === "doom_loop_steer"
                    ? `${role} automatic steering ${event.intervention}/${event.maxInterventions}`
                    : event.type === "doom_loop_finalization"
                      ? `${role} tool loop persisted; finalizing without tools`
                      : `${role} tool budget exhausted; finalizing without tools`;
              networkHistoryWrites.push(
                this.persistAttempt(authoritative, event.type, label, {
                  agent: role,
                  attempt: attemptNumber,
                }),
              );
              this.emitAgentEvent({ type: "guard", role, event });
            },
            (event) => {
              if (!("providerRequest" in event)) {
                logged?.logger.append({
                  ...event,
                  agent: role,
                  attempt: attemptNumber,
                });
                return;
              }
              if (event.type === "provider_progress") {
                try {
                  logged?.logger.append({
                    ...event,
                    agent: role,
                    attempt: attemptNumber,
                  });
                } catch {
                  // Progress logging is best effort; final request events remain authoritative.
                }
                return;
              }
              providerRequests = Math.max(
                providerRequests,
                event.providerRequest,
              );
              if (
                event.type === "provider_request_start" ||
                (event.type === "provider_request_end" && event.success)
              )
                failedRequest = undefined;
              const abortReason =
                control.intention === "abort"
                  ? "team-abort"
                  : control.intention === "retry"
                    ? "manual retry"
                    : control.intention === "superseded"
                      ? "manual retry"
                      : signal?.aborted
                        ? "team-stop"
                        : event.agentTimeoutTriggered
                          ? "agent timeout"
                          : event.abortSignalAborted
                            ? "agent timeout or workflow abort"
                            : null;
              const record = {
                ...event,
                agent: role,
                attempt: attemptNumber,
                attemptElapsedMs: Date.now() - started,
                abortReason,
              };
              if (event.type === "provider_request_failure")
                failedRequest = record;
              logged?.logger.append(record);
              if (
                event.type === "provider_request_failure" &&
                event.error &&
                containsTerminated(event.error)
              )
                logged?.logger.append({
                  type: "terminated_diagnostic",
                  agent: role,
                  attempt: attemptNumber,
                  providerRequest: event.providerRequest,
                  requestDurationMs: event.requestDurationMs,
                  attemptElapsedMs: Date.now() - started,
                  causeCode: firstErrorCode(event.error) ?? null,
                  abortSignalAborted: event.abortSignalAborted,
                  abortReason,
                });
            },
            (update) => {
              if (control.intention || control.settled) return;
              if ("kind" in update)
                this.emitAgentEvent({
                  type: "modelPreflight",
                  role,
                  workflowId: s.id,
                  attempt: attemptNumber,
                  update,
                });
              else
                this.emitAgentEvent({
                  type: "providerProgress",
                  role,
                  workflowId: s.id,
                  attempt: attemptNumber,
                  update,
                });
            },
            (command, request, commandSignal) =>
              this.runtimeCommandApproval(
                authoritative,
                s,
                role,
                control,
                command,
                request,
                commandSignal,
                (event) => logged?.logger.append(event),
              ),
          ),
        );
        if (control.intention)
          throw new Error("Agent operation superseded by user");
        control.settled = true;
        await Promise.all(networkHistoryWrites);
        if (control.intention)
          throw new Error("Agent operation superseded by user");
        logged?.logger.append({
          type: "agent_complete",
          durationMs: Date.now() - started,
          providerRequests,
          networkRetries,
        });
        await logged?.logger.flush();
        await this.persistAttempt(
          authoritative,
          "agent_attempt_completed",
          `${role} run ${attemptNumber} completed`,
          {
            agent: role,
            attempt: attemptNumber,
            retryNumber,
            durationMs: Date.now() - started,
          },
        );
        if (control.intention)
          throw new Error("Agent operation superseded by user");
        if (role !== "commitAgent" || result.type === "QUESTION_REQUEST")
          this.emitAgentEvent({ type: "complete", role });
        return {
          result,
          failures,
        };
      } catch (e) {
        await Promise.all(networkHistoryWrites);
        if (control.intention === "superseded") {
          logged?.logger.append({
            type: "agent_superseded_by_upstream_retry",
            agent: role,
            attempt: attemptNumber,
            durationMs: Date.now() - started,
          });
          await logged?.logger.flush();
          await this.persistAttempt(
            authoritative,
            "agent_superseded_by_upstream_retry",
            `${role} stopped for upstream manual retry`,
            {
              agent: role,
              attempt: attemptNumber,
              durationMs: Date.now() - started,
            },
          );
          this.emitAgentEvent({ type: "superseded", role });
          throw new AgentSupersededForRetryError(role, attemptNumber);
        }
        if (control.intention === "abort" || control.intention === "retry") {
          const restarting = control.intention === "retry";
          logged?.logger.append({
            type: restarting
              ? "agent_retry_requested_by_user"
              : "agent_aborted_by_user",
            agent: role,
            attempt: attemptNumber,
            ...(restarting
              ? {
                  previousAttempt: attemptNumber,
                  nextAttempt: attemptNumber + 1,
                }
              : {}),
          });
          await logged?.logger.flush();
          await this.persistAttempt(
            authoritative,
            restarting
              ? "agent_retry_requested_by_user"
              : "agent_aborted_by_user",
            restarting
              ? `${role} manual retry requested`
              : `${role} aborted by user`,
            { agent: role, attempt: attemptNumber },
          );
          if (restarting) {
            trigger = "manual_retry";
            this.emitAgentEvent({
              type: "restarting",
              role,
              attempt: attemptNumber + 1,
            });
            continue;
          }
          this.emitAgentEvent({ type: "aborted", role });
          throw new AgentAbortedByUserError(role, attemptNumber);
        }
        const failure = classifyFailure(e);
        const transportFailure = failedRequest?.classification === "network";
        const failureRule =
          transportFailure &&
          !(e instanceof AgentTimeoutError) &&
          !(e instanceof AgentDoomLoopError) &&
          !signal?.aborted
            ? (failedRequest?.matchedRule ?? null)
            : explainFailure(e).matchedRule;
        if (e instanceof AgentDoomLoopError) {
          logged?.logger.append({
            type: "doom_loop_failed",
            agentAttempt: attemptNumber,
            intervention: e.interventions,
          });
          await this.persistAttempt(
            authoritative,
            "doom_loop_failed",
            `${role} could not finalize after repeated tool loops`,
            { agent: role, attempt: attemptNumber },
          );
        }
        const category =
          e instanceof AgentDoomLoopError
            ? "doom_loop"
            : e instanceof AgentTimeoutError
              ? "timeout"
              : signal?.aborted
                ? "cancelled"
                : transportFailure
                  ? "network"
                  : failure;
        const agentTimeoutMs =
          e instanceof AgentTimeoutError ? e.timeoutMs : undefined;
        const label = safeFailureLabel(category, agentTimeoutMs);
        const durationMs = Date.now() - started;
        const error = failedRequest?.error ?? serializeErrorDiagnostics(e);
        const abortReason =
          control.intention === "abort"
            ? "team-abort"
            : control.intention === "retry" ||
                control.intention === "superseded"
              ? "manual retry"
              : signal?.aborted
                ? "team-stop"
                : e instanceof AgentTimeoutError
                  ? "agent timeout"
                  : null;
        logged?.logger.append({
          type: "provider_error",
          agent: role,
          attempt: attemptNumber,
          category,
          classification: category,
          matchedRule:
            category === "cancelled" ? "workflow signal aborted" : failureRule,
          label,
          durationMs,
          attemptElapsedMs: durationMs,
          providerRequest: failedRequest?.providerRequest ?? null,
          requestDurationMs: failedRequest?.requestDurationMs ?? null,
          timeToFirstEventMs: failedRequest?.timeToFirstEventMs,
          timeSinceLastActivityMs: failedRequest?.timeSinceLastActivityMs,
          error,
          agentTimeoutMs: timeoutMs ?? null,
          agentTimeoutMode: timeoutMode,
          agentTimeoutElapsedMs: failedRequest?.agentTimeoutElapsedMs,
          agentTimeoutRemainingMs: failedRequest?.agentTimeoutRemainingMs,
          abortSignalAborted:
            failedRequest?.abortSignalAborted ??
            (e instanceof AgentTimeoutError ||
              control.controller.signal.aborted),
          abortReason,
          doomLoop: failedRequest?.doomLoop ?? {
            interventions:
              this.sessions.get(s.id, role)?.doomLoopInterventions ?? 0,
            toolsDisabledForFinalization:
              this.sessions.get(s.id, role)?.toolsDisabledForFinalization ??
              false,
          },
          toolCalls:
            failedRequest?.toolCalls ??
            this.sessions.get(s.id, role)?.toolCalls ??
            0,
          maxToolCalls:
            s.config.agents[role].maxToolCalls ??
            s.config.workflow.maxToolCalls,
          toolBudgetUnlimited:
            (s.config.agents[role].maxToolCalls ??
              s.config.workflow.maxToolCalls) === 0,
          toolBudgetExhausted: failedRequest?.toolBudgetExhausted ?? false,
          networkRetry: failedRequest?.networkRetryState ?? {
            currentRetry: networkRetries,
            maxRetries:
              s.config.agents[role].networkRetry?.maxRetries ??
              s.config.workflow.networkRetry.maxRetries,
            waiting: false,
          },
          providerTimeouts: failedRequest?.providerTimeouts,
          ...(agentTimeoutMs ? { timeoutMs: agentTimeoutMs } : {}),
        });
        await logged?.logger.flush();
        await this.persistAttempt(
          authoritative,
          "agent_attempt_failed",
          `${role} run ${attemptNumber}: ${label}`,
          {
            agent: role,
            attempt: attemptNumber,
            retryNumber,
            reason: category,
            durationMs,
            finalError: {
              ...(typeof error.name === "string" ? { name: error.name } : {}),
              ...(typeof error.message === "string"
                ? { message: error.message }
                : {}),
              ...(firstErrorCode(error) ? { code: firstErrorCode(error) } : {}),
              ...(typeof error.cause?.message === "string"
                ? { causeMessage: error.cause.message }
                : {}),
              ...(typeof failedRequest?.requestDurationMs === "number"
                ? { requestDurationMs: failedRequest.requestDurationMs }
                : {}),
            },
            ...(agentTimeoutMs ? { timeoutMs: agentTimeoutMs } : {}),
          },
        );
        if (signal?.aborted) throw e;
        failures++;
        const transient = e instanceof AgentTimeoutError;
        if (
          s.agentFailures + failures >= s.config.workflow.maxAgentFailures ||
          automaticRetries === 1 ||
          mutatingRoles.includes(role) ||
          !transient
        ) {
          this.emitAgentEvent({ type: "fail", role, error: String(e) });
          const terminalError =
            category === "network" && networkRetriesExhausted
              ? new Error(
                  `network retries exhausted; last provider code: ${firstErrorCode(error) ?? "unknown"}; ${getErrorMessage(e)}`,
                  { cause: e },
                )
              : e instanceof Error
                ? e
                : new Error(String(e));
          Object.assign(terminalError, { failures });
          throw terminalError;
        }
        logged?.logger.append({
          type: "retry",
          nextAttempt: attemptNumber + 1,
          category,
          label,
        });
        await logged?.logger.flush();
        await this.persistAttempt(
          authoritative,
          "agent_retry",
          `${role} retry ${automaticRetries + 1}/1: ${label}`,
          {
            agent: role,
            attempt: attemptNumber,
            reason: category,
            ...(agentTimeoutMs ? { timeoutMs: agentTimeoutMs } : {}),
          },
        );
        this.emitAgentEvent({
          type: "retry",
          role,
          attempt: automaticRetries + 1,
          reason: label,
        });
        automaticRetries++;
        trigger = "automatic_retry";
      } finally {
        signal?.removeEventListener("abort", abortForWorkflow);
        if (this.activeAttempts.get(role) === control)
          this.activeAttempts.delete(role);
      }
    }
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
    if (s.teamConfigHash && s.agentPromptHashes && s.teamConfigPath) {
      const current = await loadConfig(this.cwd);
      const drift = analyzeConfigDrift(s, current);
      if (drift.changed && !drift.blocking) {
        acceptConfigDrift(s, current, drift);
        await this.store.save(s);
      }
    }
    if (
      s.phase !== "BLOCKED" ||
      !s.blocker?.startsWith("Agent execution failed:")
    )
      return;
    const phase = s.history.findLast((e) => e.event === "blocked")?.phase;
    const roles = phase ? getPhaseRoles(s, phase) : undefined;
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
      getFailureBudgetUsed(s) >= s.config.workflow.maxAgentFailures
    )
      return;
    record(s, "explicit_resume", phase);
    s.phase = phase;
    delete s.blocker;
    await this.store.save(s);
  }
  async continueBlocked(s: WorkflowState, signal?: AbortSignal) {
    const unlock = await this.store.lock();
    let handedToRun = false;
    try {
      const latest = await this.store.load(s.id);
      const plan = await getWorkflowRecoveryPlan(
        latest,
        this.cwd,
        this.running || this.activeAttempts.size > 0,
      );
      if (plan.kind !== "continue") throw new Error(plan.reason);
      for (const key of Object.keys(s))
        delete (s as Record<string, unknown>)[key];
      Object.assign(s, latest);
      if (s.blocker === "Local fix cycle limit reached") s.localFixCycle++;
      if (s.blocker?.startsWith("Research clarification limit reached")) {
        const questions = [
          ...new Set(
            (
              (s.results.researcher as { unresolvedQuestions?: string[] })
                ?.unresolvedQuestions ?? []
            )
              .map((question) => question.trim())
              .filter(Boolean),
          ),
        ];
        if (!questions.length)
          throw new Error("Research questions are missing");
        s.pendingResearchQuestions = questions;
        s.resumePhase = "RESEARCH";
        s.researchClarificationCount++;
      }
      record(s, "workflow_continue_requested", "", undefined);
      s.phase = plan.nextPhase;
      delete s.blocker;
      record(s, "workflow_continued", plan.nextPhase);
      this.continuingPhase = plan.nextPhase;
      await this.store.save(s);
      handedToRun = true;
      return await this.run(s, signal, unlock);
    } finally {
      this.continuingPhase = undefined;
      if (!handedToRun) await unlock();
    }
  }
  async run(
    s: WorkflowState,
    signal?: AbortSignal,
    existingUnlock?: () => Promise<void>,
  ) {
    const unlock = existingUnlock ?? (await this.store.lock());
    this.running = true;
    this.runningWorkflowId = s.id;
    try {
      // A process restart loses the suspended agent session. Re-present saved
      // requests without ever replaying the command or consuming an allow-once grant.
      if (s.pendingRuntimeCommands.length && this.activeAttempts.size === 0) {
        for (const pending of [...s.pendingRuntimeCommands]) {
          if (signal?.aborted) break;
          const request = this.runtimeApprovalPrompt(
            s,
            pending.agentId,
            pending.command,
            pending.purpose,
          );
          request.prompt +=
            "\n\nThe requesting run has ended. This decision will not execute the command; retry the agent after recovery.";
          request.options = request.options.filter(
            (option) => option.value !== "allow_once",
          );
          const selected = await this.ui.approve?.(request);
          const choice = selected?.length === 1 ? selected[0] : undefined;
          if (
            !choice ||
            !request.options.some((option) => option.value === choice)
          )
            break;
          this.saveRuntimeApproval(s, pending.command, choice);
          s.pendingRuntimeCommands = s.pendingRuntimeCommands.filter(
            (item) => item.requestId !== pending.requestId,
          );
          if (s.config.logging.agentLogs.level !== "off") {
            const log = new AttemptLogger(
              this.logs.path(s.id, pending.agentId, pending.run),
            );
            log.append({
              type: "command_approval_decided",
              agent: pending.agentId,
              run: pending.run,
              requestId: pending.requestId,
              decision: choice,
              ...(choice === "allow_similar"
                ? { rule: proposeSimilarRule(pending.command) }
                : {}),
            });
            await log.flush();
          }
          record(
            s,
            "command_approval_decided",
            `${pending.agentId} ${choice} ${pending.command.id}`,
            { agent: pending.agentId, attempt: pending.run },
          );
          await this.store.save(s);
        }
        if (s.pendingRuntimeCommands.length) {
          this.ui.progress(s);
          return s;
        }
      }
      await this.recover(s);
      if (s.pendingApproval?.kind === "commands") {
        s.phase = s.resumePhase ?? "RESEARCH";
        delete s.pendingApproval;
        delete s.resumePhase;
        s.commandApprovalComplete = false;
        record(s, "legacy_command_approval_skipped");
        await this.store.save(s);
      }
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
          let current: TeamDefinition;
          try {
            current = await loadConfig(this.cwd);
          } catch (configError) {
            if (s.phase !== "REPORT") throw configError;
            s.reportFailure = `Reporter configuration unavailable: ${String(configError)}`;
            s.reportInput ??= await buildCompletionReportInput(s);
            s.results.reporter ??= fallbackReport(
              s.reportInput as CompletionReportInput,
            );
            record(s, "report_fallback", s.reportFailure);
            s.phase = "DONE";
            await this.store.save(s);
            break;
          }
          const drift = analyzeConfigDrift(s, current);
          const changed = [
            ...drift.semanticChanges,
            ...drift.runtimeChanges,
            ...drift.presentationChanges,
            ...drift.futureAgentChanges,
          ];
          if (drift.blocking && s.phase === "REPORT") {
            record(s, "configuration_drift", changed.join(", "));
            s.reportFailure = `Configuration changed during REPORT: ${drift.semanticChanges.join(", ")}`;
            s.reportInput ??= await buildCompletionReportInput(s);
            s.results.reporter ??= fallbackReport(
              s.reportInput as CompletionReportInput,
            );
            s.phase = "DONE";
            await this.store.save(s);
            break;
          }
          if (drift.blocking) {
            s.driftCandidate = {
              configPath: current.path,
              configHash: current.configHash,
              agentPromptHashes: current.agentPromptHashes,
              changed,
            };
            s.pendingApproval = {
              kind: "configDrift",
              title: "Project team definition changed",
              prompt: `Configuration drift detected.\n${driftSummary(drift)}\nAbort is the safe default. Resuming restarts reasoning with the new team definition and original cycle limits; after implementation it is unavailable.`,
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
          if (drift.changed) {
            acceptConfigDrift(s, current, drift);
            await this.store.save(s);
          }
        }
        if (s.phase === "WAITING_USER") {
          if (s.pendingResearchQuestions?.length && !s.pendingApproval) {
            const questions = s.pendingResearchQuestions;
            const answers = await this.ui.askResearchQuestions?.(questions);
            if (!answers) {
              await this.store.save(s);
              break;
            }
            if (
              answers.length !== questions.length ||
              answers.some(
                (answer, index) =>
                  answer.question !== questions[index] || !answer.answer.trim(),
              )
            )
              throw new Error(
                "Research clarification must answer every pending question in order",
              );
            s.answers.push(
              ...answers.map((answer) => ({
                ...answer,
                sourceAgent: "researcher" as const,
                cycle: s.fullCycle,
              })),
            );
            record(s, "research_questions_answered", "", {
              agent: "researcher",
              attempt: Math.max(1, this.nextAttempt(s, "researcher") - 1),
              count: answers.length,
            });
            if (s.results.researcher)
              s.results.previous_researcher = s.results.researcher;
            delete s.results.researcher;
            delete s.pendingResearchQuestions;
            delete s.resumePhase;
            s.researchClarificationPending = true;
            s.phase = "RESEARCH";
            await this.store.save(s);
            continue;
          }
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
                    (phase) => getPhaseRoles(s, phase as Phase) ?? [],
                  ))
                    delete s.results[role];
                  s.config = current.config;
                  s.teamConfigPath = current.path;
                  s.teamConfigHash = current.configHash;
                  s.semanticConfigHash = current.semanticConfigHash;
                  s.driftConfigSnapshot = current.config;
                  s.agentPromptHashes = current.agentPromptHashes;
                  s.phase = "ORCHESTRATE";
                  delete s.pendingQuestion;
                  delete s.pendingResearchQuestions;
                  delete s.researchClarificationPending;
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
        if (
          s.phase !== "REPORT" &&
          getFailureBudgetUsed(s) >= s.config.workflow.maxAgentFailures
        ) {
          block(s, "Agent failure limit reached");
          break;
        }
        if (
          s.phase !== "REPORT" &&
          (await head(this.cwd)) !== s.baseline.head
        ) {
          block(s, "Git HEAD changed during workflow");
          break;
        }
        if (s.phase !== "ORCHESTRATE" && !s.commandApprovalComplete) {
          s.discoveredCommands = await discoverCommands(this.cwd);
          s.commandApprovalComplete = true;
          if (
            s.config.qualityGates.testing.enabled &&
            ![
              ...effectiveConfig(s).commands,
              ...s.discoveredCommands.map((item) => item.command),
            ].some((command) => ["test", "static"].includes(command.purpose))
          ) {
            block(
              s,
              "No validation commands discovered or configured; configure trusted argv commands and start a new workflow",
            );
            break;
          }
        }
        if (s.phase === "IMPLEMENT") {
          const contract = contractSchema.parse(s.results.reviewer);
          const paths = contractPaths(contract);
          await validateContractPaths(this.cwd, contract);
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
        if (s.phase === "REPORT" && !s.reportInput) {
          s.reportInput = await buildCompletionReportInput(s);
          await this.store.save(s);
        }
        if (
          s.phase === "SOLVE" &&
          (!s.results.researcher ||
            (s.results.researcher as any).unresolvedQuestions?.length !== 0)
        ) {
          block(
            s,
            "Solvers require a current Researcher result with no unresolved questions",
          );
          await this.store.save(s);
          break;
        }
        const allRoles = getPhaseRoles(s, s.phase);
        if (!allRoles) {
          block(s, "Unknown workflow phase");
          break;
        }
        const runRoles = allRoles.filter(
          (r) =>
            s.phase !== "SOLVE" || !s.results[r] || s.manualRetry?.agent === r,
        );
        const manualAtStart = new Set(this.manualReruns);
        this.manualReruns.clear();
        s.inFlight = { phase: s.phase, roles: runRoles };
        record(s, "phase_started", runRoles.join(", "));
        await this.store.save(s);
        // Use isolated snapshots. A solver can never observe a sibling's initial output.
        const results = await Promise.allSettled(
          runRoles.map(async (role) => {
            const snapshot = structuredClone(s);
            if (snapshot.manualRetry?.agent === role)
              delete snapshot.results[role];
            return {
              role,
              ...(await this.invoke(
                role,
                snapshot,
                signal,
                s,
                manualAtStart.has(role),
              )),
            };
          }),
        );
        if (s.pendingRuntimeCommands.length) {
          const waiting = [
            ...new Set(
              s.pendingRuntimeCommands.map((request) => request.agentId),
            ),
          ];
          block(
            s,
            `Command approval pending for ${waiting.join(", ")}; review it with /team resume, then inspect and retry the agent.`,
          );
          delete s.inFlight;
          await this.store.save(s);
          break;
        }
        if (this.continuingPhase === s.phase) this.continuingPhase = undefined;
        // Failure accounting belongs to the authoritative parent, not the isolated snapshots.
        let error: string | undefined;
        let aborted: Role | undefined;
        let pending: Question | undefined;
        let solverFailures = 0;
        for (let i = 0; i < results.length; i++) {
          const item = results[i];
          if (item.status === "rejected") {
            if (item.reason instanceof AgentAbortedByUserError) {
              aborted = runRoles[i];
              continue;
            }
            if (item.reason instanceof AgentSupersededForRetryError) continue;
            const failures = item.reason?.failures ?? 1;
            s.agentFailures += failures;
            if (s.phase === "SOLVE") solverFailures += failures;
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
            if (s.manualRetry?.agent === role && !this.manualReruns.has(role)) {
              this.invalidateDependents(s, role);
              delete s.manualRetry;
            }
            try {
              s.results[role] =
                role === "reporter"
                  ? finalizeReport(
                      s.reportInput as CompletionReportInput,
                      result,
                    )
                  : result;
              if (role === "reporter") delete s.reportFailure;
            } catch (invalid) {
              error = `Invalid reporter result: ${String(invalid)}`;
              continue;
            }
            if (role !== "commitAgent") record(s, "agent_completed", role);
          }
        }
        for (const role of [...this.manualReruns]) {
          if (!allRoles.includes(role)) continue;
          this.manualReruns.delete(role);
          this.retryRequests.delete(role);
          try {
            const snapshot = structuredClone(s);
            delete snapshot.results[role];
            const replay = await this.invoke(role, snapshot, signal, s, true);
            s.agentFailures += replay.failures;
            if (replay.result.type !== "QUESTION_REQUEST") {
              this.invalidateDependents(s, role);
              s.results[role] =
                role === "reporter"
                  ? finalizeReport(
                      s.reportInput as CompletionReportInput,
                      replay.result,
                    )
                  : replay.result;
              if (role === "reporter") delete s.reportFailure;
              delete s.manualRetry;
              record(s, "agent_completed", role);
            } else pending = replay.result;
          } catch (retryError) {
            if (retryError instanceof AgentAbortedByUserError) aborted = role;
            else {
              s.agentFailures += (retryError as any)?.failures ?? 1;
              error = String(retryError);
            }
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
        if (this.pendingRewind?.workflowId === s.id) {
          const rewind = this.pendingRewind;
          this.pendingRewind = undefined;
          this.prepareManualRetry(s, rewind.role, rewind.phase);
          await this.store.save(s);
          continue;
        }
        if (s.phase === "SOLVE") {
          const solverCount = s.config.workflow.solverCount;
          const required = getRequiredSuccessfulSolverCount(solverCount);
          const valid = getActiveSolverIds(s.config).filter(
            (role) => !!s.results[role],
          ).length;
          if (valid >= required && !s.manualRetry) {
            record(
              s,
              "solver_quorum_satisfied",
              JSON.stringify({
                successfulSolvers: valid,
                requiredSuccessfulSolvers: required,
                configuredSolvers: solverCount,
                coveredFailures: solverFailures,
              }),
            );
            aborted = undefined;
            error = undefined;
          } else if ((aborted || error) && !s.manualRetry) {
            block(
              s,
              `Solver quorum not reached: ${valid}/${required} successful (${solverCount} configured).`,
            );
            await this.store.save(s);
            break;
          }
        }
        if (aborted && !error) error = `Agent ${aborted} aborted by user`;
        if ((error || pending) && s.phase === "REPORT") {
          s.reportFailure =
            error ?? "Reporter requested additional information";
          s.results.reporter ??= fallbackReport(
            s.reportInput as CompletionReportInput,
          );
          record(s, "report_fallback", s.reportFailure);
          s.phase = "DONE";
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
        if (s.phase === "RESEARCH") {
          s.researchClarificationPending = false;
          const questions: string[] = [
            ...new Set<string>(
              (
                s.results.researcher as { unresolvedQuestions: string[] }
              ).unresolvedQuestions
                .map((question) => question.trim())
                .filter(Boolean),
            ),
          ];
          (
            s.results.researcher as { unresolvedQuestions: string[] }
          ).unresolvedQuestions = questions;
          if (questions.length) {
            if (
              s.config.workflow.maxResearchClarifications > 0 &&
              s.researchClarificationCount >=
                s.config.workflow.maxResearchClarifications
            )
              block(
                s,
                `Research clarification limit reached. The Researcher still has unresolved questions after ${s.researchClarificationCount} clarification rounds.`,
              );
            else {
              s.pendingResearchQuestions = questions;
              s.resumePhase = "RESEARCH";
              s.researchClarificationCount++;
              record(s, "research_questions_requested", "", {
                agent: "researcher",
                attempt: Math.max(1, this.nextAttempt(s, "researcher") - 1),
                count: questions.length,
              });
              s.phase = "WAITING_USER";
            }
            await this.store.save(s);
            if ((s.phase as Phase) === "BLOCKED") break;
            continue;
          }
        }
        if (s.phase === "REVIEW") {
          const contract = contractSchema.parse(s.results.reviewer);
          await validateContractPaths(this.cwd, contract);
          if (
            new Set(contractPaths(contract)).size !==
            contractPaths(contract).length
          )
            throw new Error("Contract file lists overlap");
        }
        if (s.phase === "SOLVE")
          for (const role of getActiveSolverIds(s.config))
            if (s.results[role] && (s.results[role] as any)?.solverId !== role)
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
          try {
            this.emitAgentEvent({
              type: "activity",
              role: "commitAgent",
              toolName: "commit_inspect",
            });
            s.commitIntent = await prepareCommit(
              s,
              result.files,
              result.message,
            );
            // Persist intent before a non-idempotent operation. Interrupted commits require inspection.
            s.inFlight = { phase: "COMMIT", roles: ["commitAgent"] };
            await this.store.save(s);
            this.emitAgentEvent({
              type: "activity",
              role: "commitAgent",
              toolName: "commit_create",
            });
            s.commit = await createCommit(s);
            delete s.inFlight;
            this.emitAgentEvent({ type: "complete", role: "commitAgent" });
            record(s, "agent_completed", "commitAgent");
          } catch (error) {
            this.emitAgentEvent({
              type: "fail",
              role: "commitAgent",
              error: String(error),
            });
            throw error;
          }
        }
        transition(s);
        record(s, "phase_completed");
        await this.store.save(s);
      }
      await this.store.save(s);
      this.ui.progress(s);
      return s;
    } catch (e) {
      block(s, getErrorMessage(e));
      await this.store.save(s);
      this.ui.progress(s);
      return s;
    } finally {
      this.running = false;
      this.runningWorkflowId = undefined;
      if (this.pendingRewind?.workflowId === s.id)
        this.pendingRewind = undefined;
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
