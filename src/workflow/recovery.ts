import { loadConfig } from "../config/loader.ts";
import { analyzeConfigDrift, driftSummary } from "../config/drift.ts";
import { contractSchema, type Role } from "../agents/schemas.ts";
import { contractPaths } from "../agents/permissions.ts";
import {
  dirtyPaths,
  gateSnapshot,
  unexpectedWorkflowPaths,
  head,
  classifyAttributedImplementation,
} from "./git.ts";
import { phaseRoles, getPhaseRoles, transition } from "./router.ts";
import {
  getRequiredSuccessfulSolverCount,
  getFailureBudgetUsed,
} from "../config/solvers.ts";
import type { Phase, WorkflowState } from "./state.ts";
import { isLimitBlockerStillActive } from "./limit-blocker.ts";
import { getErrorMessage } from "../agents/error-message.ts";
import { projectInstructionsDrift } from "./project-instructions.ts";
import { isLegacySecurityRiskBlock } from "./security-risk-review.ts";

export type FixRequirementsOrigin = {
  sourceAgent: "implementor" | "codeReviewer";
  sourcePhase: "IMPLEMENT" | "CODE_REVIEW";
  attempt: number;
};

/** Only a still-unanswered requirement decision may be replaced by a retry. */
export function pendingFixRequirements(
  state: WorkflowState,
): FixRequirementsOrigin | undefined {
  if (
    state.phase !== "WAITING_USER" ||
    !state.pendingQuestion ||
    state.resumePhase !== "ORCHESTRATE" ||
    state.pendingApproval ||
    state.pendingResearchQuestions?.length ||
    state.pendingRuntimeCommands.length ||
    state.pendingRuntimeFiles.length ||
    state.inFlight ||
    state.manualRetry ||
    state.driftCandidate
  )
    return undefined;
  const question = state.pendingQuestion;
  if (
    (question.route || question.sourceAgent || question.sourcePhase) &&
    (!question.route || !question.sourceAgent || !question.sourcePhase)
  )
    return undefined;
  if (question.route && question.route !== "FIX_REQUIREMENTS") return undefined;
  const routeIndex = state.history.findLastIndex(
    (event) => event.event === "FIX_REQUIREMENTS",
  );
  if (routeIndex < 1) return undefined;
  const route = state.history[routeIndex];
  const completion = state.history[routeIndex - 1];
  if (
    completion.event !== "agent_completed" ||
    completion.phase !== route.phase ||
    state.history
      .slice(routeIndex + 1)
      .some(
        (event) =>
          event.event !== "phase_completed" || event.phase !== "WAITING_USER",
      )
  )
    return undefined;
  const sourcePhase = route.phase;
  const sourceAgent = completion.detail;
  if (
    !(
      (sourcePhase === "IMPLEMENT" && sourceAgent === "implementor") ||
      (sourcePhase === "CODE_REVIEW" && sourceAgent === "codeReviewer")
    ) ||
    (question.sourceAgent && question.sourceAgent !== sourceAgent) ||
    (question.sourcePhase && question.sourcePhase !== sourcePhase) ||
    (question.route && question.route !== route.event)
  )
    return undefined;
  const result = state.results[sourceAgent];
  if (
    sourceAgent === "implementor"
      ? result?.status !== "IMPLEMENTATION_BLOCKED" ||
        result.suggestedRoute !== "FIX_REQUIREMENTS"
      : result?.status !== "FIX_REQUIREMENTS"
  )
    return undefined;
  const started = state.history
    .slice(0, routeIndex)
    .findLast(
      (event) =>
        event.event === "agent_attempt_started" &&
        event.meta?.agent === sourceAgent,
    );
  const attempt = started?.meta?.attempt;
  if (
    !attempt ||
    (completion.meta?.agent && completion.meta.agent !== sourceAgent)
  )
    return undefined;
  return { sourceAgent, sourcePhase, attempt };
}

const mutating = new Set<Role>([
  "implementor",
  "pentester",
  "tester",
  "commitAgent",
]);
export type ManualRetryState =
  | { kind: "none" }
  | { kind: "unconsumed"; agent: Role; phase: Phase; sourceAttempt: number }
  | { kind: "active" | "consumed"; agent: Role; phase: Phase; attempt: number }
  | { kind: "ambiguous"; agent: Role; phase: Phase; reason: string };

/** Infer legacy retry intent from recorded lifecycle, without rewriting history. */
export function classifyManualRetry(
  state: WorkflowState,
  liveAgents: ReadonlySet<Role> = new Set(),
): ManualRetryState {
  const intent = state.manualRetry;
  if (!intent) return { kind: "none" };
  const { agent, phase } = intent;
  const ambiguous = (reason: string): ManualRetryState => ({
    kind: "ambiguous",
    agent,
    phase,
    reason,
  });
  const requestIndex = state.history.findLastIndex(
    (event) =>
      event.event === "agent_retry_requested_by_user" &&
      event.meta?.agent === agent,
  );
  if (requestIndex < 0) return ambiguous("Retry request has no history event.");
  const request = state.history[requestIndex];
  const sourceAttempt = request.meta?.attempt;
  if (!sourceAttempt) return ambiguous("Retry request has no source attempt.");
  const starts = state.history.filter(
    (event) =>
      event.event === "agent_attempt_started" && event.meta?.agent === agent,
  );
  const sourceStarts = starts.filter(
    (event) => event.meta?.attempt === sourceAttempt,
  );
  const terminals = state.history.filter(
    (event) =>
      (event.event === "agent_attempt_completed" ||
        event.event === "agent_attempt_failed") &&
      event.meta?.agent === agent &&
      event.meta.attempt === sourceAttempt,
  );
  if (sourceStarts.length !== 1 || terminals.length !== 1)
    return ambiguous("Source attempt lifecycle is incomplete or ambiguous.");
  if (
    state.history.indexOf(sourceStarts[0]) >=
      state.history.indexOf(terminals[0]) ||
    state.history.indexOf(sourceStarts[0]) >= requestIndex
  )
    return ambiguous("Retry request does not follow the source attempt start.");
  if (
    state.history
      .slice(state.history.indexOf(sourceStarts[0]) + 1, requestIndex + 1)
      .filter(
        (event) =>
          event.event === "agent_retry_requested_by_user" &&
          event.meta?.agent === agent,
      ).length !== 1
  )
    return ambiguous("Multiple retry requests target the same source attempt.");
  const newer = state.history
    .slice(requestIndex + 1)
    .filter(
      (event) =>
        event.event === "agent_attempt_started" && event.meta?.agent === agent,
    );
  if (
    newer.length > 1 ||
    (newer.length && newer[0].meta?.attempt !== sourceAttempt + 1)
  )
    return ambiguous("Retry attempt numbering is ambiguous.");
  if (
    newer.length &&
    newer[0].meta?.trigger &&
    newer[0].meta.trigger !== "manual_retry"
  )
    return ambiguous("Newer attempt was not attributed to the pending retry.");
  if (newer.length)
    return {
      kind: liveAgents.has(agent) ? "active" : "consumed",
      agent,
      phase,
      attempt: newer[0].meta!.attempt,
    };
  if (liveAgents.has(agent))
    return ambiguous("Agent is live before retry start was recorded.");
  return { kind: "unconsumed", agent, phase, sourceAttempt };
}

export type RecoveryAction = {
  kind:
    | "continue"
    | "retry"
    | "retry_keep"
    | "retry_discard"
    | "retry_override"
    | "resume"
    | "abort";
  command: string;
};
export type QualityGateBlocker =
  | {
      kind: "owned";
      agent: "tester" | "pentester";
      phase: "TEST" | "PENTEST";
      attempt: number;
    }
  | { kind: "ambiguous"; reason: string };

/** Verify result, blocker, and completed attempt together; legacy text alone is insufficient. */
export function classifyQualityGateBlocker(
  state: WorkflowState,
): QualityGateBlocker | undefined {
  if (state.phase !== "BLOCKED" || !state.blocker) return undefined;
  const candidates = (["tester", "pentester"] as const).filter(
    (agent) => state.results[agent]?.status === "BLOCKED",
  );
  if (!candidates.length) return undefined;
  if (candidates.length !== 1)
    return {
      kind: "ambiguous",
      reason: "Multiple blocked quality gate results exist.",
    };
  const agent = candidates[0];
  const phase = agent === "tester" ? "TEST" : "PENTEST";
  const expected =
    agent === "tester"
      ? `Testing blocked: ${state.results.tester?.reason ?? "Required validation could not run"}`
      : `Pentest blocked: ${state.results.pentester?.blocker?.message ?? ""}`;
  const meta = state.blockerMeta;
  const ambiguous = (reason: string): QualityGateBlocker => ({
    kind: "ambiguous",
    reason,
  });
  if (!meta && state.blocker !== expected)
    return ambiguous("Current blocker does not match the blocked gate result.");
  const blockedIndex = state.history.findLastIndex(
    (event) => event.event === "blocked",
  );
  const blocked = state.history[blockedIndex];
  if (blocked?.phase !== phase || blocked.detail !== state.blocker)
    return ambiguous("Blocking transition cannot be attributed to the gate.");
  const startedIndex = state.history.findLastIndex(
    (event) =>
      event.event === "agent_attempt_started" && event.meta?.agent === agent,
  );
  const started = state.history[startedIndex];
  const attempt = started?.meta?.attempt;
  const terminalIndex = state.history.findLastIndex(
    (event) =>
      (event.event === "agent_attempt_completed" ||
        event.event === "agent_attempt_failed") &&
      event.meta?.agent === agent,
  );
  const terminal = state.history[terminalIndex];
  if (
    !attempt ||
    terminal?.event !== "agent_attempt_completed" ||
    terminal.meta?.attempt !== attempt ||
    startedIndex >= terminalIndex ||
    terminalIndex >= blockedIndex
  )
    return ambiguous("Latest gate attempt was not completed successfully.");
  const completionIndex = state.history.findLastIndex(
    (event) => event.event === "agent_completed" && event.detail === agent,
  );
  if (
    completionIndex <= terminalIndex ||
    completionIndex >= blockedIndex ||
    state.history
      .slice(completionIndex + 1, blockedIndex)
      .some(
        (event) =>
          event.event === "agent_attempt_started" &&
          event.meta?.agent === agent,
      )
  )
    return ambiguous("Gate completion is not tied to the blocking transition.");
  if (
    meta &&
    (meta.kind !== "quality_gate_blocked" ||
      meta.sourceAgent !== agent ||
      meta.sourcePhase !== phase ||
      meta.sourceAttempt !== attempt)
  )
    return ambiguous(
      "Structured blocker provenance belongs to another attempt or agent.",
    );
  return { kind: "owned", agent, phase, attempt };
}

export function clearQualityGateBlocker(
  state: WorkflowState,
  agent: Role,
): QualityGateBlocker & { kind: "owned" } {
  const ownership = classifyQualityGateBlocker(state);
  if (!ownership || ownership.kind !== "owned" || ownership.agent !== agent)
    throw new Error(
      `Cannot clear unrelated or ambiguous blocker: ${ownership?.kind === "ambiguous" ? ownership.reason : (state.blocker ?? "unknown blocker")}`,
    );
  delete state.blocker;
  delete state.blockerMeta;
  return ownership;
}

type BaseRecoveryPlan =
  | { kind: "continue"; nextPhase: Phase; agentId: Role; reason: string }
  | { kind: "retry-agent"; agentId: Role; reason: string }
  | { kind: "completed-quality-gate-blocked"; agentId: Role; reason: string }
  | { kind: "unconsumed-manual-retry"; agentId: Role; reason: string }
  | { kind: "interrupted-mutation"; agentId: Role; reason: string }
  | { kind: "waiting-user" | "unsafe" | "none"; reason: string };
export type WorkflowRecoveryPlan = BaseRecoveryPlan & {
  actions: RecoveryAction[];
};

export function interruptedMutationRecovery(state: WorkflowState) {
  if (state.phase !== "BLOCKED") return undefined;
  const marker = state.interruptedMutationRecovery;
  const legacy =
    state.blocker?.startsWith("Interrupted mutating phase;") ||
    state.blocker?.startsWith("Interrupted IMPLEMENT;");
  if (!marker && !legacy) return undefined;
  const started = state.history.findLast(
    (event) =>
      event.event === "agent_attempt_started" &&
      event.meta?.agent === "implementor",
  );
  const attempt = marker?.attempt ?? started?.meta?.attempt;
  if (marker && started?.meta?.attempt !== marker.attempt) return undefined;
  if (
    !attempt ||
    (marker && (marker.agent !== "implementor" || marker.phase !== "IMPLEMENT"))
  )
    return undefined;
  const startIndex = state.history.findLastIndex(
    (event) =>
      event.event === "agent_attempt_started" &&
      event.meta?.agent === "implementor" &&
      event.meta.attempt === attempt,
  );
  if (
    startIndex < 0 ||
    state.history
      .slice(startIndex + 1)
      .some(
        (event) =>
          event.event === "agent_completed" && event.detail === "implementor",
      )
  )
    return undefined;
  if (marker) {
    const markerIndex = state.history.findLastIndex(
      (event) =>
        event.event === "interrupted_mutation_recovery_required" &&
        event.meta?.agent === marker.agent &&
        event.meta.attempt === marker.attempt,
    );
    if (
      markerIndex < 0 ||
      state.history[markerIndex + 1]?.event !== "blocked" ||
      state.history.findLastIndex((event) => event.event === "blocked") !==
        markerIndex + 1 ||
      state.history[markerIndex + 1]?.phase !== marker.phase
    )
      return undefined;
    return marker;
  }
  if (
    state.history.findLast((event) => event.event === "blocked")?.phase !==
    "IMPLEMENT"
  )
    return undefined;
  const prior =
    state.priorImplementation?.attempt === attempt
      ? state.priorImplementation
      : undefined;
  return {
    agent: "implementor" as const,
    phase: "IMPLEMENT" as const,
    attempt,
    reason: "process_interrupted" as const,
    hashes: prior?.hashes ?? {},
    createdPaths: prior?.createdPaths ?? [],
    discardablePaths: prior?.discardablePaths ?? [],
  };
}

export function recoveryAction(plan: WorkflowRecoveryPlan): string {
  if (plan.actions.length) return plan.actions[0].command;
  if (plan.kind === "continue") return "/team-continue";
  if (plan.kind === "retry-agent") return `/team-retry ${plan.agentId}`;
  if (plan.kind === "interrupted-mutation")
    return `/team-retry ${plan.agentId} keep or discard`;
  if (plan.kind === "waiting-user")
    return "Answer the pending question or approval.";
  return plan.reason;
}

async function planWorkflowRecovery(
  state: WorkflowState,
  cwd: string,
  active = false,
): Promise<BaseRecoveryPlan> {
  const unsafe = (reason: string): BaseRecoveryPlan => ({
    kind: "unsafe",
    reason,
  });
  if (active) return unsafe("Workflow is already running.");
  if (
    state.phase === "WAITING_USER" &&
    state.securityRiskReview &&
    !state.pendingApproval &&
    !state.pendingQuestion &&
    !state.pendingResearchQuestions?.length &&
    !state.pendingRuntimeCommands?.length &&
    !state.pendingRuntimeFiles?.length
  )
    return {
      kind: "continue",
      nextPhase: "WAITING_USER",
      agentId: "securityReviewer",
      reason:
        state.securityRiskReview.status === "accepted"
          ? "Accepted security risks were approved; continue to the next gate."
          : "Waiting for user review of accepted security risks. Continue to reopen the confirmation.",
    };
  if (
    state.phase === "WAITING_USER" ||
    state.pendingQuestion ||
    state.pendingApproval ||
    state.pendingRuntimeCommands?.length ||
    state.pendingRuntimeFiles?.length
  )
    return {
      kind: "waiting-user",
      reason:
        state.pendingRuntimeCommands?.length ||
        state.pendingRuntimeFiles?.length
          ? "Waiting for tool approval. Run /team resume to review the saved request. /team-continue cannot bypass it."
          : "Workflow is waiting for user input.",
    };
  if (state.phase === "DONE")
    return { kind: "none", reason: "Workflow is already DONE." };
  if (state.phase === "ABORTED")
    return { kind: "none", reason: "Workflow is already ABORTED." };
  if (state.phase !== "BLOCKED" && !state.inFlight && !state.manualRetry)
    return unsafe("Workflow is already running.");
  if (state.driftCandidate)
    return unsafe("Configuration drift requires user review.");
  const instructionDrift = await projectInstructionsDrift(
    cwd,
    state.projectInstructions,
  );
  if (instructionDrift) return unsafe(instructionDrift);
  if (
    !state.teamConfigPath ||
    !state.teamConfigHash ||
    !state.agentPromptHashes
  )
    return unsafe("Workflow lacks configuration hashes; start a new workflow.");
  let current;
  try {
    current = await loadConfig(cwd);
  } catch (error) {
    return unsafe(
      `Cannot validate project configuration: ${getErrorMessage(error)}`,
    );
  }
  const drift = analyzeConfigDrift(state, current);
  if (drift.blocking)
    return unsafe(`Configuration drift detected.\n${driftSummary(drift)}`);
  if (isLegacySecurityRiskBlock(state))
    return {
      kind: "continue",
      nextPhase: "WAITING_USER",
      agentId: "securityReviewer",
      reason:
        "Waiting for user review of accepted security risks. Continue to open the confirmation.",
    };
  const interrupted = interruptedMutationRecovery(state);
  if (interrupted) {
    const classification = await classifyAttributedImplementation(
      state,
      interrupted,
      "interrupted",
    );
    const safe = classification.discardable.length;
    const ambiguous = classification.ambiguous.length;
    const recommendDiscard = !ambiguous && !state.baseline.dirtyPaths.length;
    return {
      kind: "interrupted-mutation",
      agentId: interrupted.agent,
      reason: `Recovery required: Implementor was interrupted during a mutating run.\nRepository: ${safe} safe to discard; ${ambiguous} ambiguous.\n${ambiguous ? `Inspect ambiguous paths: ${classification.ambiguous.join(", ")}\n` : recommendDiscard ? "Recommended: /team-retry implementor discard\n" : ""}Options: /team-retry implementor keep · /team-retry implementor discard · /team-abort implementor\nPlease inspect repository changes before retrying.`,
    };
  }
  const manual = classifyManualRetry(state);
  if (manual.kind === "unconsumed" && !state.inFlight) {
    if (state.commit || (await head(cwd)) !== state.baseline.head)
      return unsafe(
        "Repository HEAD changed; pending retry cannot start safely.",
      );
    if (
      state.gateHashes &&
      ["CODE_REVIEW", "PENTEST", "SECURITY_REVIEW", "TEST", "COMMIT"].includes(
        manual.phase,
      )
    ) {
      try {
        if (
          (await unexpectedWorkflowPaths(state)).length ||
          JSON.stringify(await gateSnapshot(state)) !==
            JSON.stringify(state.gateHashes)
        )
          return unsafe(
            "Repository changed after a quality gate; pending retry cannot start safely.",
          );
      } catch (error) {
        return unsafe(
          `Cannot verify repository before retry: ${getErrorMessage(error)}`,
        );
      }
    }
    return {
      kind: "unconsumed-manual-retry",
      agentId: manual.agent,
      reason: `A ${manual.agent} retry was requested but did not start. Run ${manual.sourceAttempt} ended; the pending retry will start as run ${manual.sourceAttempt + 1}.`,
    };
  }
  if (manual.kind === "consumed" && !mutating.has(manual.agent)) {
    const terminals = state.history.filter(
      (event) =>
        (event.event === "agent_attempt_completed" ||
          event.event === "agent_attempt_failed") &&
        event.meta?.agent === manual.agent &&
        event.meta.attempt === manual.attempt,
    );
    if (terminals.length <= 1 && !state.results[manual.agent])
      return {
        kind: "retry-agent",
        agentId: manual.agent,
        reason: terminals.length
          ? `${manual.agent} retry run ${manual.attempt} ended without a result. Retry it explicitly.`
          : `${manual.agent} retry run ${manual.attempt} was interrupted. Retry this read-only agent explicitly.`,
      };
  }
  if (
    manual.kind === "ambiguous" ||
    manual.kind === "consumed" ||
    manual.kind === "active"
  )
    return unsafe(
      `Pending ${state.manualRetry?.agent} retry needs explicit recovery: ${manual.kind === "ambiguous" ? manual.reason : "a newer attempt already started"}.`,
    );
  if (state.inFlight && state.inFlight.roles.length === 1) {
    const role = state.inFlight.roles[0];
    const started = state.history.findLast(
      (event) =>
        event.event === "agent_attempt_started" && event.meta?.agent === role,
    );
    const attempt = started?.meta?.attempt;
    const terminal = state.history.some(
      (event) =>
        (event.event === "agent_attempt_completed" ||
          event.event === "agent_attempt_failed") &&
        event.meta?.agent === role &&
        event.meta.attempt === attempt,
    );
    if (!mutating.has(role) && attempt && !terminal)
      return {
        kind: "retry-agent",
        agentId: role,
        reason: `${role} run ${attempt} was interrupted before a terminal event. Retry this read-only agent.`,
      };
  }
  if (state.inFlight)
    return unsafe(
      `Interrupted ${state.inFlight.phase}; inspect repository effects before continuing.`,
    );
  const gateBlocker = classifyQualityGateBlocker(state);
  if (gateBlocker?.kind === "ambiguous")
    return unsafe(
      `Blocked quality gate provenance is ambiguous: ${gateBlocker.reason}`,
    );
  if (gateBlocker?.kind === "owned") {
    if (state.commit || (await head(cwd)) !== state.baseline.head)
      return unsafe(
        "Repository HEAD changed; blocked gate cannot be retried safely.",
      );
    if (state.gateHashes) {
      try {
        if (
          (await unexpectedWorkflowPaths(state)).length ||
          JSON.stringify(await gateSnapshot(state)) !==
            JSON.stringify(state.gateHashes)
        )
          return unsafe(
            "Repository changed after a quality gate; blocked gate cannot be retried safely.",
          );
      } catch (error) {
        return unsafe(
          `Cannot verify repository before retry: ${getErrorMessage(error)}`,
        );
      }
    }
    return {
      kind: "completed-quality-gate-blocked",
      agentId: gateBlocker.agent,
      reason: `${gateBlocker.agent} run ${gateBlocker.attempt} completed with a BLOCKED gate result. Retry the gate; upstream results remain valid.`,
    };
  }
  if (
    state.blocker?.startsWith("Command approval pending for ") ||
    state.blocker?.startsWith("File approval pending for ")
  ) {
    const prefix = state.blocker.startsWith("File")
      ? "File approval pending for "
      : "Command approval pending for ";
    const role = state.blocker.slice(prefix.length).split(/[;,]/, 1)[0] as Role;
    if (
      getPhaseRoles(
        state,
        state.history.findLast((event) => event.event === "blocked")?.phase ??
          state.phase,
      )?.includes(role)
    )
      return {
        kind: "retry-agent",
        agentId: role,
        reason: `Tool approval was reviewed after ${role} run ended. Inspect repository effects, then retry ${role}.`,
      };
  }
  const limitActive = isLimitBlockerStillActive(state, current.config);
  if (limitActive) return unsafe(state.blocker!);
  const staleLimit = limitActive === false;

  // Follow the ordinary router, on copies, through the current valid results.
  // Each copy starts from the original results because RESEARCH's transition
  // invalidates downstream results as a real workflow side effect.
  let phase = (
    staleLimit && state.blocker === "Local fix cycle limit reached"
      ? "IMPLEMENT"
      : staleLimit && state.blocker === "Pentest cycle limit reached"
        ? "PENTEST"
        : staleLimit &&
            state.blocker?.startsWith("Research clarification limit reached")
          ? "WAITING_USER"
          : "ORCHESTRATE"
  ) as Phase;
  const seen = new Set<Phase>();
  const hasResult = (role: Role) => {
    if (!state.results[role]) return false;
    if (role !== "implementor") return true;
    // FIX_LOCAL deliberately retains the prior Implementor result as evidence.
    // It is not completion of the new implementation pass.
    const lastFix = state.history.findLastIndex(
      (event) => event.event === "FIX_LOCAL",
    );
    const lastStart = state.history.findLastIndex(
      (event) => event.phase === "IMPLEMENT" && event.event === "phase_started",
    );
    const lastCompletion = state.history.findLastIndex(
      (event) =>
        event.event === "agent_completed" && event.detail === "implementor",
    );
    return (
      Math.max(lastFix, lastStart) < 0 ||
      lastCompletion > Math.max(lastFix, lastStart)
    );
  };
  for (; phase !== "WAITING_USER";) {
    if (seen.has(phase))
      return unsafe(
        "Workflow results require another design cycle; inspect the blocker.",
      );
    seen.add(phase);
    if (phase === "DONE")
      return { kind: "none", reason: "All workflow phases are complete." };
    const roles = getPhaseRoles(state, phase);
    if (!roles) return unsafe(`Unknown workflow phase: ${phase}`);
    const complete =
      phase === "SOLVE"
        ? roles.filter(hasResult).length >=
          getRequiredSuccessfulSolverCount(state.config.workflow.solverCount)
        : roles.every(hasResult);
    if (!complete) break;
    if (
      phase === "IMPLEMENT" &&
      state.results.implementor?.status !== "IMPLEMENTED"
    )
      return unsafe(
        "Implementor did not complete successfully; inspect repository changes and retry the Implementor.",
      );
    if (
      phase === "COMMIT" &&
      !state.commit &&
      !(
        state.commitSelection?.completed &&
        !state.commitSelection.commitPaths.length
      )
    )
      return unsafe(
        "Commit is not confirmed; inspect repository changes before continuing.",
      );
    const copy = structuredClone(state);
    copy.phase = phase;
    copy.config = current.config;
    try {
      transition(copy);
    } catch (error) {
      return unsafe(
        `Cannot verify ${phase} transition: ${getErrorMessage(error)}`,
      );
    }
    if (
      copy.phase === "BLOCKED" ||
      (copy.phase as Phase) === "WAITING_USER" ||
      seen.has(copy.phase)
    )
      return unsafe(`Completed ${phase} requires review before proceeding.`);
    phase = copy.phase;
  }
  const roles = getPhaseRoles(state, phase) ?? [];
  const pending = roles.filter((role) => !hasResult(role));
  const lastInvalidation = state.history.findLastIndex((event) =>
    [
      "FIX_LOCAL",
      "FIX_DESIGN",
      "downstream_invalidated",
      "configuration_refresh",
    ].includes(event.event),
  );
  const started = pending.find((role) =>
    state.history
      .slice(lastInvalidation + 1)
      .some(
        (event) =>
          event.event === "agent_attempt_started" && event.meta?.agent === role,
      ),
  );
  const failure = state.history.findLast(
    (event) => event.event === "agent_failure",
  );
  const failedRole = failure?.detail.split(":", 1)[0] as Role | undefined;
  if (
    state.blocker?.startsWith("Agent execution failed:") ||
    state.blocker?.includes("aborted by user") ||
    state.blocker?.startsWith("Insufficient Solver proposals") ||
    state.blocker?.startsWith("Solver quorum not reached")
  ) {
    const role = pending.includes(failedRole as Role) ? failedRole : started;
    if (role && pending.includes(role))
      return {
        kind: "retry-agent",
        agentId: role,
        reason: `${role} has not completed successfully.`,
      };
    return unsafe(
      "The failed prerequisite is unresolved; inspect workflow history.",
    );
  }
  if (started) {
    if (mutating.has(started))
      return unsafe(
        `${started} started without a successful result; inspect repository changes before retrying.`,
      );
    const attempt = state.history.findLast(
      (event) =>
        event.event === "agent_attempt_started" &&
        event.meta?.agent === started,
    )?.meta?.attempt;
    const terminals = state.history.filter(
      (event) =>
        (event.event === "agent_attempt_completed" ||
          event.event === "agent_attempt_failed") &&
        event.meta?.agent === started &&
        event.meta.attempt === attempt,
    );
    if (terminals.length > 1 || !attempt)
      return unsafe(`${started} attempt lifecycle is ambiguous.`);
    return {
      kind: "retry-agent",
      agentId: started,
      reason: terminals.length
        ? `${started} run ${attempt} ended without a successful result. Retry it explicitly.`
        : `${started} run ${attempt} was interrupted. This agent cannot modify the repository and can be retried.`,
    };
  }
  if (
    phase === "IMPLEMENT" &&
    state.results.implementor &&
    !hasResult("implementor") &&
    state.blocker !== "Local fix cycle limit reached"
  )
    return unsafe(
      "A prior Implementor result does not complete the current local fix; inspect repository changes before continuing.",
    );
  const stopped = state.history.findLast(
    (event) => event.event === "blocked",
  )?.phase;
  const interruptedAfterCompletedMutation =
    state.blocker?.startsWith("Interrupted mutating phase;") &&
    stopped &&
    ["IMPLEMENT", "PENTEST", "TEST", "COMMIT"].includes(stopped) &&
    (getPhaseRoles(state, stopped) ?? []).every(hasResult) &&
    (stopped !== "COMMIT" || !!state.commit);
  if (
    !interruptedAfterCompletedMutation &&
    !staleLimit &&
    (!state.blocker ||
      !/^(?:Workflow stopped after|Recoverable transition interruption|Transition interrupted|Interrupted after)/i.test(
        state.blocker,
      ))
  )
    return unsafe(
      `Blocker requires inspection: ${state.blocker ?? "unknown blocker"}`,
    );
  if (
    getFailureBudgetUsed(state) >=
    (drift.changed
      ? current.config.workflow.maxAgentFailures
      : state.config.workflow.maxAgentFailures)
  )
    return unsafe("Agent failure limit reached.");
  if (phase !== "REPORT" && (await head(cwd)) !== state.baseline.head)
    return unsafe(
      "Git HEAD changed during workflow; inspect repository changes.",
    );
  if (
    ["CODE_REVIEW", "PENTEST", "SECURITY_REVIEW", "TEST", "COMMIT"].includes(
      phase,
    ) &&
    state.gateHashes
  ) {
    try {
      if ((await unexpectedWorkflowPaths(state)).length)
        return unsafe(
          "Repository changed outside the Implementation Contract; inspect changes before continuing.",
        );
      const snapshot = await gateSnapshot(state);
      if (JSON.stringify(snapshot) !== JSON.stringify(state.gateHashes))
        return unsafe(
          "Repository changed after a quality gate; inspect changes before continuing.",
        );
    } catch (error) {
      return unsafe(
        `Cannot verify repository state: ${getErrorMessage(error)}`,
      );
    }
  }
  if (phase === "CODE_REVIEW") {
    try {
      contractSchema.parse(state.results.reviewer);
    } catch {
      return unsafe("Implementation Contract is missing or invalid.");
    }
    const allowed = new Set([
      ...state.baseline.dirtyPaths,
      ...contractPaths(contractSchema.parse(state.results.reviewer)),
    ]);
    if (
      (await dirtyPaths(cwd)).some(
        (path) => !path.startsWith(".pi/team/") && !allowed.has(path),
      )
    )
      return unsafe(
        "Repository contains changes outside the Implementation Contract; inspect them before continuing.",
      );
  }
  if (phase === "COMMIT" && state.commitIntent)
    return unsafe(
      "Commit intent exists without confirmed completion; inspect repository state.",
    );
  return {
    kind: "continue",
    nextPhase: phase,
    agentId: pending[0] ?? "researcher",
    reason: staleLimit
      ? `Previous ${state.blocker} no longer applies. Continue at ${phase}.`
      : `Continue at ${phase}.`,
  };
}

/** Decisions take priority over mutation recovery, queued retries, and normal continuation. */
export async function getWorkflowRecoveryPlan(
  state: WorkflowState,
  cwd: string,
  active = false,
): Promise<WorkflowRecoveryPlan> {
  const plan = await planWorkflowRecovery(state, cwd, active);
  if (active)
    return {
      ...plan,
      actions: [{ kind: "abort", command: "/team-stop" }],
    } as WorkflowRecoveryPlan;
  let actions: RecoveryAction[] = [];
  if (plan.kind === "continue") {
    actions = [{ kind: "continue", command: "/team-continue" }];
    if (
      state.securityRiskReview?.status === "pending" ||
      isLegacySecurityRiskBlock(state)
    )
      actions.push({ kind: "retry", command: "/team-retry securityReviewer" });
  } else if (plan.kind === "unconsumed-manual-retry")
    actions = [
      { kind: "retry", command: `/team-retry ${plan.agentId}` },
      { kind: "continue", command: "/team-continue" },
    ];
  else if (
    plan.kind === "retry-agent" ||
    plan.kind === "completed-quality-gate-blocked"
  )
    actions = [{ kind: "retry", command: `/team-retry ${plan.agentId}` }];
  else if (plan.kind === "interrupted-mutation")
    actions = [
      { kind: "retry_keep", command: `/team-retry ${plan.agentId} keep` },
      { kind: "retry_discard", command: `/team-retry ${plan.agentId} discard` },
    ];
  else if (plan.kind === "waiting-user")
    actions = [{ kind: "resume", command: `/team resume ${state.id}` }];
  if (
    plan.kind !== "none" &&
    state.phase !== "DONE" &&
    state.phase !== "ABORTED"
  )
    actions.push({ kind: "abort", command: "/team-abort" });
  return { ...plan, actions } as WorkflowRecoveryPlan;
}
