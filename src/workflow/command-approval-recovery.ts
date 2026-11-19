import type { WorkflowState, Phase } from "./state.ts";
import type { Role } from "../agents/schemas.ts";
import { getPhaseRoles } from "./router.ts";

export const commandApprovalRecoveryEvent =
  "command_approval_recovery_required";
const resolvedPrefix = "Command approval resolved for ";

export function savedCommandApprovalMismatch(state: WorkflowState) {
  for (const pending of state.pendingRuntimeCommands) {
    const latest = state.history.findLast(
      (e) =>
        e.event === "agent_attempt_started" &&
        e.meta?.agent === pending.agentId,
    );
    const execution = state.executions.filter(
      (e) => e.agent === pending.agentId && e.attempt === pending.run,
    );
    if (
      pending.workflowId !== state.id ||
      !latest ||
      latest.meta?.attempt !== pending.run ||
      execution.length > 1 ||
      execution.some((e) => e.workflowId !== state.id)
    )
      return `Saved command approval for ${pending.agentId} run ${pending.run} does not match the current workflow attempt. Inspect history and abort; it cannot authorize another execution.`;
  }
  return undefined;
}

function approvalBlocker(blocker: string | undefined) {
  return (
    !!blocker &&
    (blocker.startsWith("Command approval pending for ") ||
      blocker.startsWith(resolvedPrefix) ||
      blocker.startsWith("Pi-Team approval contains secret-like content") ||
      blocker.startsWith("Pi-Team approval is too large") ||
      blocker.startsWith("Local terminal approval unavailable:") ||
      blocker.startsWith("Pi-Team is configured for Telegram interaction,") ||
      blocker.startsWith("Pi-Team Telegram interaction is unavailable") ||
      blocker.startsWith("Telegram interaction service unavailable:") ||
      blocker.startsWith("Telegram polling stopped unexpectedly;") ||
      /^Telegram API HTTP \d+:/.test(blocker) ||
      blocker.startsWith(
        "Could not deliver complete Telegram interaction details;",
      ) ||
      blocker.startsWith("Could not send Telegram question;"))
  );
}

/** A discovery flag or a workflow grant alone is never evidence of resolution.
 * Legacy v3 history has no request ID: require an unambiguous request/decision
 * pair for every command in the latest attempt. New history adds request IDs.
 */
export function resolvedCommandApproval(state: WorkflowState) {
  if (
    state.phase !== "BLOCKED" ||
    !approvalBlocker(state.blocker) ||
    state.pendingRuntimeCommands.length ||
    state.pendingRuntimeFiles.length ||
    state.pendingApproval ||
    state.pendingQuestion ||
    state.pendingContractPaths.length ||
    state.pendingContractExtensions.length ||
    state.pendingResearchQuestions?.length ||
    state.commit ||
    state.manualRetry
  )
    return undefined;
  const requests = state.history.filter(
    (e) => e.event === "command_approval_requested",
  );
  const last = requests.at(-1);
  const agent = last?.meta?.agent;
  const attempt = last?.meta?.attempt;
  if (!last || !agent || !attempt) return undefined;
  const sourcePhase =
    last.phase === "BLOCKED" ? last.meta?.sourcePhase : last.phase;
  if (!sourcePhase || !getPhaseRoles(state, sourcePhase)?.includes(agent))
    return undefined;
  const starts = state.history.filter(
    (e) => e.event === "agent_attempt_started" && e.meta?.agent === agent,
  );
  if (
    starts.at(-1)?.meta?.attempt !== attempt ||
    starts.filter((e) => e.meta?.attempt === attempt).length !== 1
  )
    return undefined;
  const startIndex = state.history.indexOf(starts.at(-1)!);
  const relevant = requests.filter(
    (e) => state.history.indexOf(e) > startIndex,
  );
  if (
    !relevant.length ||
    relevant.some((e) => e.meta?.agent !== agent || e.meta?.attempt !== attempt)
  )
    return undefined;
  const decisions: string[] = [];
  for (const request of relevant) {
    const commandId =
      request.meta?.commandId ??
      request.detail.match(new RegExp(`^${agent} (?:requested )?(\\S+)$`))?.[1];
    if (!commandId) return undefined;
    const same = relevant.filter(
      (e) => (e.meta?.commandId ?? e.detail.split(" ").at(-1)) === commandId,
    );
    if (!request.meta?.requestId && same.length !== 1) return undefined;
    const matches = state.history.filter((e) => {
      if (
        e.event !== "command_approval_decided" ||
        state.history.indexOf(e) <= state.history.indexOf(request) ||
        e.meta?.agent !== agent ||
        e.meta.attempt !== attempt
      )
        return false;
      if (
        request.meta?.requestId &&
        e.meta.requestId !== request.meta.requestId
      )
        return false;
      if (
        request.meta?.executionId &&
        e.meta.executionId !== request.meta.executionId
      )
        return false;
      if (e.meta.commandId && e.meta.commandId !== commandId) return false;
      if (
        e.meta.executionId &&
        !state.executions.some(
          (execution) =>
            execution.id === e.meta?.executionId &&
            execution.workflowId === state.id &&
            execution.agent === agent &&
            execution.attempt === attempt,
        )
      )
        return false;
      return (
        e.detail === `${agent} allow_once ${commandId}` ||
        e.detail === `${agent} allow_workflow ${commandId}` ||
        e.detail === `${agent} allow_similar ${commandId}` ||
        e.detail === `${agent} deny ${commandId}`
      );
    });
    if (!matches.length || new Set(matches.map((e) => e.detail)).size !== 1)
      return undefined;
    decisions.push(matches[0].detail.split(" ")[1]);
  }
  const executions = state.executions.filter(
    (e) => e.agent === agent && e.attempt === attempt,
  );
  if (
    executions.length > 1 ||
    executions.some((e) => e.workflowId !== state.id)
  )
    return undefined;
  const execution = executions[0];
  if (
    execution &&
    relevant.some(
      (e) => e.meta?.executionId && e.meta.executionId !== execution.id,
    )
  )
    return undefined;
  const terminals = state.history.filter(
    (e) =>
      ["agent_attempt_completed", "agent_attempt_failed"].includes(e.event) &&
      e.meta?.agent === agent &&
      e.meta.attempt === attempt,
  );
  if (terminals.length > 1 || (!execution && !terminals.length))
    return undefined;
  if (
    state.inFlight &&
    (state.inFlight.phase !== sourcePhase ||
      state.inFlight.roles.length !== 1 ||
      state.inFlight.roles[0] !== agent)
  )
    return undefined;
  // A different phase's blocker must not be cleared by an old approval.
  const blocked = state.history.filter((e) => e.event === "blocked");
  if (
    !blocked.some(
      (e) => e.phase === sourcePhase && state.history.indexOf(e) > startIndex,
    ) ||
    (blocked.at(-1)?.detail !== state.blocker &&
      !state.blocker?.startsWith(resolvedPrefix))
  )
    return undefined;
  return {
    agent: agent as Role,
    attempt,
    phase: sourcePhase as Phase,
    execution,
    decisions,
  };
}

export function commandApprovalRecoveryBlocker(agent: Role, attempt: number) {
  return `${resolvedPrefix}${agent} run ${attempt}; original command continuation ended. Explicit agent recovery is required; no command was replayed.`;
}
