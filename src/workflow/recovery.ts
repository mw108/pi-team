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
export type WorkflowRecoveryPlan =
  | { kind: "continue"; nextPhase: Phase; agentId: Role; reason: string }
  | { kind: "retry-agent"; agentId: Role; reason: string }
  | { kind: "interrupted-mutation"; agentId: Role; reason: string }
  | { kind: "waiting-user" | "unsafe" | "none"; reason: string };

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
  if (plan.kind === "continue") return "/team-continue";
  if (plan.kind === "retry-agent") return `/team-retry ${plan.agentId}`;
  if (plan.kind === "interrupted-mutation")
    return `/team-retry ${plan.agentId} keep or discard`;
  if (plan.kind === "waiting-user")
    return "Answer the pending question or approval.";
  return plan.reason;
}

export async function getWorkflowRecoveryPlan(
  state: WorkflowState,
  cwd: string,
  active = false,
): Promise<WorkflowRecoveryPlan> {
  const unsafe = (reason: string): WorkflowRecoveryPlan => ({
    kind: "unsafe",
    reason,
  });
  if (active) return unsafe("Workflow is already running.");
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
  if (state.phase !== "BLOCKED") return unsafe("Workflow is already running.");
  if (state.driftCandidate)
    return unsafe("Configuration drift requires user review.");
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
  if (state.inFlight)
    return unsafe(
      `Interrupted ${state.inFlight.phase}; inspect repository effects before continuing.`,
    );
  if (
    state.blocker?.startsWith("Pentest blocked:") &&
    state.results.pentester?.status === "BLOCKED"
  )
    return {
      kind: "retry-agent",
      agentId: "pentester",
      reason:
        "Restore the required Pentest capability, then retry the Pentester. Upstream results remain valid.",
    };
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
    if (phase === "COMMIT" && !state.commit)
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
    if (staleLimit && state.blocker === "Agent failure limit reached")
      return {
        kind: "retry-agent",
        agentId: started,
        reason: `Previous agent failure limit no longer applies; retry ${started}.`,
      };
    return unsafe(
      `${started} already has an incomplete attempt; inspect workflow history before recovery.`,
    );
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
