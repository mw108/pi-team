import { loadConfig } from "../config/loader.ts";
import { analyzeConfigDrift, driftSummary } from "../config/drift.ts";
import { contractSchema, type Role } from "../agents/schemas.ts";
import { contractPaths } from "../agents/permissions.ts";
import { dirtyPaths, hashes, head } from "./git.ts";
import { phaseRoles, getPhaseRoles, transition } from "./router.ts";
import {
  getRequiredSuccessfulSolverCount,
  getFailureBudgetUsed,
} from "../config/solvers.ts";
import type { Phase, WorkflowState } from "./state.ts";
import { isLimitBlockerStillActive } from "./limit-blocker.ts";
import { getErrorMessage } from "../agents/error-message.ts";

const mutating = new Set<Role>([
  "implementor",
  "pentester",
  "tester",
  "commitAgent",
]);
export type WorkflowRecoveryPlan =
  | { kind: "continue"; nextPhase: Phase; agentId: Role; reason: string }
  | { kind: "retry-agent"; agentId: Role; reason: string }
  | { kind: "waiting-user" | "unsafe" | "none"; reason: string };

export function recoveryAction(plan: WorkflowRecoveryPlan): string {
  if (plan.kind === "continue") return "/team-continue";
  if (plan.kind === "retry-agent") return `/team-retry ${plan.agentId}`;
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
    state.pendingRuntimeCommands?.length
  )
    return {
      kind: "waiting-user",
      reason: state.pendingRuntimeCommands?.length
        ? "Waiting for command approval. Run /team resume to review the saved request. /team-continue cannot bypass it."
        : "Workflow is waiting for user input.",
    };
  if (state.phase === "DONE")
    return { kind: "none", reason: "Workflow is already DONE." };
  if (state.phase !== "BLOCKED") return unsafe("Workflow is already running.");
  if (state.inFlight)
    return unsafe(
      `Interrupted ${state.inFlight.phase}; inspect repository effects before continuing.`,
    );
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
  if (
    state.blocker?.startsWith("Pentest blocked:") &&
    (state.results.pentester as any)?.status === "BLOCKED"
  )
    return {
      kind: "retry-agent",
      agentId: "pentester",
      reason:
        "Restore the required Pentest capability, then retry the Pentester. Upstream results remain valid.",
    };
  if (state.blocker?.startsWith("Command approval pending for ")) {
    const role = state.blocker
      .slice("Command approval pending for ".length)
      .split(/[;,]/, 1)[0] as Role;
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
        reason: `Command approval was reviewed after ${role} run ended. Inspect repository effects, then retry ${role}.`,
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
      (state.results.implementor as any)?.status !== "IMPLEMENTED"
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
      const snapshot = await hashes(cwd, await dirtyPaths(cwd));
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
