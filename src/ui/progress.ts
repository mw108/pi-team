import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { roles, type Role } from "../agents/schemas.ts";
import type { WorkflowState } from "../workflow/state.ts";
import type { AgentProgress, ProgressRuntime } from "./runtime.ts";
import { getAgentDisplayName } from "./agent-name.ts";
const symbols = {
  pending: "○",
  running: "●",
  completed: "✓",
  failed: "✗",
  stopped: "–",
  aborted: "⊘",
};
export function elapsed(ms: number) {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}
function visibleRoles(state: WorkflowState) {
  return roles.filter((role) => {
    if (
      (role === "pentester" || role === "securityReviewer") &&
      !state.config.qualityGates.pentest.enabled
    )
      return false;
    if (
      role === "codeReviewer" &&
      !state.config.qualityGates.codeReview.enabled
    )
      return false;
    if (role === "tester" && !state.config.qualityGates.testing.enabled)
      return false;
    if (role === "commitAgent" && !state.config.qualityGates.commit.enabled)
      return false;
    return true;
  });
}
function displayAgent(
  role: Role,
  state: WorkflowState,
  runtime?: ProgressRuntime,
  showId = false,
) {
  const live: AgentProgress | undefined = runtime?.agents[role];
  const last = state.history.findLast(
    (entry) =>
      entry.meta?.agent === role && entry.event === "agent_attempt_failed",
  );
  const latestLifecycle = state.history.findLast(
    (entry) =>
      entry.meta?.agent === role &&
      [
        "agent_attempt_started",
        "agent_attempt_completed",
        "agent_attempt_failed",
        "agent_aborted_by_user",
        "agent_superseded_by_upstream_retry",
      ].includes(entry.event),
  );
  const status =
    live?.status ??
    (state.results[role]
      ? "completed"
      : latestLifecycle?.event === "agent_aborted_by_user"
        ? "aborted"
        : latestLifecycle?.event === "agent_superseded_by_upstream_retry"
          ? "stopped"
          : state.phase === "BLOCKED" && last
            ? "failed"
            : "pending");
  const modelId = state.config.agents[role].model;
  const model = state.config.ui.progress.showModels
    ? ` [${/^[A-Za-z0-9._:/-]{1,80}$/.test(modelId) && !modelId.includes("://") ? modelId.slice(0, 24) : "model configured"}]`
    : "";
  const duration =
    live?.startedAt !== undefined ? `  ${elapsed(runtime!.elapsed(live))}` : "";
  const retry =
    live?.retry && status === "running" ? ` · retry ${live.retry}/1` : "";
  const attempt =
    live?.attempt && (live.manualRetry || live.attempt > 1)
      ? ` · attempt ${live.attempt}`
      : "";
  const label = `${symbols[status]} ${getAgentDisplayName(state.config, role)}${showId ? ` (${role})` : ""}${model}${duration}${retry}${attempt}`;
  const activity =
    status === "running" &&
    live?.activity &&
    state.config.ui.progress.showToolActivity
      ? `  ↳ ${live.activity}`
      : undefined;
  const reconnect =
    status === "running" && live?.networkRetry
      ? `  ↳ Reconnecting · ${live.networkRetry.category === "transport" ? "network error" : live.networkRetry.category === "rate_limit" ? "rate limited" : "provider temporarily unavailable"} · ${live.networkRetry.maxRetries === 0 ? `attempt ${live.networkRetry.retry}` : `${live.networkRetry.retry}/${live.networkRetry.maxRetries}`}${live.networkRetry.retryAt === undefined ? "" : ` · retry in ${Math.ceil(Math.max(0, live.networkRetry.retryAt - Date.now()) / 1000)}s`}`
      : undefined;
  const error =
    status === "aborted"
      ? "  ↳ Aborted by user"
      : status === "stopped" &&
          latestLifecycle?.event === "agent_superseded_by_upstream_retry"
        ? "  ↳ Stopped for upstream retry"
        : status === "failed" && live?.error
          ? `  ↳ ${live.error}`
          : undefined;
  const control =
    status === "running" && live?.controlActivity
      ? `  ↳ ${live.controlActivity}`
      : undefined;
  const guardStatus =
    status === "running" && live
      ? `  ↳ ${live.doomLoopInterventions ? `doom-loop interventions: ${live.doomLoopInterventions}/${state.config.agents[role].doomLoop?.maxInterventions ?? state.config.workflow.doomLoop.maxInterventions} · ` : ""}tool calls: ${live.toolCalls ?? 0}/${state.config.agents[role].maxToolCalls ?? state.config.workflow.maxToolCalls}${live.toolsDisabledForFinalization ? " · tools: disabled for finalization" : ""}`
      : undefined;
  const persistedRetry = state.history.findLast(
    (entry) => entry.meta?.agent === role && entry.event === "agent_retry",
  );
  const previous =
    live?.previousFailure ??
    (persistedRetry && last?.meta?.reason
      ? last.detail.split(": ").at(-1)
      : undefined);
  const reason =
    status === "running" && previous
      ? `  ↳ Previous attempt failed: ${previous}`
      : status === "failed" && last
        ? `  ↳ Final error: ${last.detail.split(": ").at(-1)} · attempt ${last.meta?.attempt}`
        : undefined;
  const finalError =
    status === "failed" &&
    typeof last?.meta?.finalError?.requestDurationMs === "number"
      ? last.meta.finalError
      : undefined;
  const detail = finalError
    ? [
        finalError.code || finalError.causeMessage
          ? `  ↳ Cause: ${[finalError.code, finalError.causeMessage].filter(Boolean).join(" · ")}`
          : undefined,
        typeof finalError.requestDurationMs === "number"
          ? `  ↳ Provider request: ${(finalError.requestDurationMs / 1000).toFixed(1)}s`
          : undefined,
      ].filter((line): line is string => !!line)
    : [];
  return [
    label,
    control ?? reconnect ?? activity,
    guardStatus,
    finalError?.message
      ? `  ↳ Final error: ${finalError.name ?? "Error"}: ${finalError.message}`
      : (reason ?? error),
    ...detail,
  ].filter((line): line is string => !!line);
}
export function renderProgress(
  state: WorkflowState,
  runtime?: ProgressRuntime,
  showIds = false,
) {
  const phase = runtime?.stopped
    ? "stopped"
    : state.phase === "WAITING_USER"
      ? "waiting for user"
      : state.phase.replaceAll("_", " ").toLowerCase();
  const lines = [
    `Team ${state.id.slice(0, 8)} · ${phase} · Design cycle ${state.fullCycle}/${state.config.workflow.maxFullCycles}`,
  ];
  if (state.phase === "WAITING_USER") lines.push("◉ Waiting for user input");
  if (state.inFlight && !runtime)
    lines.push(
      "Live runtime details unavailable; inspect or resume this workflow",
    );
  for (const role of visibleRoles(state))
    lines.push(...displayAgent(role, state, runtime, showIds));
  const gates = [
    `Local fixes ${state.localFixCycle}/${state.config.workflow.maxLocalFixCycles}`,
    state.config.qualityGates.pentest.enabled
      ? `Pentest cycle ${state.pentestCycle}/${state.config.workflow.maxPentestCycles}`
      : "Pentest disabled",
    ...(
      [
        ["codeReview", "Code review"],
        ["testing", "Testing"],
        ["commit", "Commit"],
      ] as const
    )
      .filter(([gate]) => !state.config.qualityGates[gate].enabled)
      .map(([, label]) => `${label} disabled`),
  ];
  lines.push(gates.join(" · "));
  if (state.blocker) lines.push("Blocked; inspect workflow state for details");
  if (state.phase === "DONE")
    lines.push(
      `Report: ${state.results.reporter ? "available" : "deterministic fallback available"} · /team-report`,
    );
  if (
    state.history.some((entry) => entry.event === "agent_attempt_started") &&
    state.config.logging.agentLogs.level !== "off"
  )
    lines.push(`Logs: .pi/team/state/${state.id}.logs/ · /team-log`);
  return lines;
}
export function progress(
  ctx: ExtensionContext,
  state: WorkflowState,
  runtime?: ProgressRuntime,
) {
  const active = Object.values(runtime?.agents ?? {})
    .filter((agent) => agent.status === "running")
    .map((agent) => getAgentDisplayName(state.config, agent.instanceId));
  ctx.ui.setStatus(
    "pi-team",
    `Team: ${runtime?.stopped ? "STOPPED" : state.phase}${active.length ? ` · ${active.join(", ")}` : ""} · design cycle ${state.fullCycle}/${state.config.workflow.maxFullCycles}`,
  );
  ctx.ui.setWidget(
    "pi-team",
    state.config.ui.progress.enabled
      ? renderProgress(state, runtime)
      : undefined,
  );
}
