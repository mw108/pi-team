import { loadConfig } from "../config/loader.ts";
import { contractSchema, type Role } from "../agents/schemas.ts";
import { contractPaths } from "../agents/permissions.ts";
import { dirtyPaths, hashes, head } from "./git.ts";
import { phaseRoles, transition } from "./router.ts";
import type { Phase, WorkflowState } from "./state.ts";

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
    state.pendingApproval
  )
    return {
      kind: "waiting-user",
      reason: "Workflow is waiting for user input.",
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
    return unsafe(`Cannot validate project configuration: ${String(error)}`);
  }
  if (
    current.path !== state.teamConfigPath ||
    current.configHash !== state.teamConfigHash ||
    Object.entries(current.agentPromptHashes).some(
      ([role, hash]) => state.agentPromptHashes?.[role] !== hash,
    )
  )
    return unsafe(
      "Project configuration or agent prompts changed; resolve configuration drift before continuing.",
    );

  // Follow the ordinary router, on copies, through the current valid results.
  // Each copy starts from the original results because RESEARCH's transition
  // invalidates downstream results as a real workflow side effect.
  let phase = "ORCHESTRATE" as Phase;
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
  for (;;) {
    if (seen.has(phase))
      return unsafe(
        "Workflow results require another design cycle; inspect the blocker.",
      );
    seen.add(phase);
    if (phase === "DONE")
      return { kind: "none", reason: "All workflow phases are complete." };
    const roles = phaseRoles[phase];
    if (!roles) return unsafe(`Unknown workflow phase: ${phase}`);
    const complete =
      phase === "SOLVE"
        ? roles.filter(hasResult).length >= 2
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
    try {
      transition(copy);
    } catch (error) {
      return unsafe(`Cannot verify ${phase} transition: ${String(error)}`);
    }
    if (
      copy.phase === "BLOCKED" ||
      copy.phase === "WAITING_USER" ||
      seen.has(copy.phase)
    )
      return unsafe(`Completed ${phase} requires review before proceeding.`);
    phase = copy.phase;
  }
  const roles = phaseRoles[phase]!;
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
    state.blocker?.startsWith("Insufficient Solver proposals")
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
    return unsafe(
      `${started} already has an incomplete attempt; inspect workflow history before recovery.`,
    );
  }
  if (
    phase === "IMPLEMENT" &&
    state.results.implementor &&
    !hasResult("implementor")
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
    (phaseRoles[stopped] ?? []).every(hasResult) &&
    (stopped !== "COMMIT" || !!state.commit);
  if (
    !interruptedAfterCompletedMutation &&
    (!state.blocker ||
      !/^(?:Workflow stopped after|Recoverable transition interruption|Transition interrupted|Interrupted after)/i.test(
        state.blocker,
      ))
  )
    return unsafe(
      `Blocker requires inspection: ${state.blocker ?? "unknown blocker"}`,
    );
  if (state.agentFailures >= state.config.workflow.maxAgentFailures)
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
      return unsafe(`Cannot verify repository state: ${String(error)}`);
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
    agentId: pending[0],
    reason: `Continue at ${phase}.`,
  };
}
