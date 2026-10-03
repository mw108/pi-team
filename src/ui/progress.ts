import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { roles, type Role } from "../agents/schemas.ts";
import type { WorkflowState } from "../workflow/state.ts";
import type { AgentProgress, ProgressRuntime } from "./runtime.ts";
import { getAgentDisplayName } from "./agent-name.ts";
import { getActiveSolverIds } from "../config/solvers.ts";
import { solverIds } from "../agents/schemas.ts";
import { formatCommandLine } from "../agents/command-observability.ts";
import { getPhaseRoles, phaseRoles } from "../workflow/router.ts";
import { redactVisibleText } from "../agents/redaction.ts";
const symbols = {
  pending: "○",
  running: "●",
  completed: "✓",
  failed: "✗",
  waiting: "◉",
  invalidated: "↺",
  stopped: "–",
  aborted: "⊘",
};
export function formatCycleProgress(state: WorkflowState): string | undefined {
  const parts: string[] = [];
  if (state.pentestCycle > 0)
    parts.push(
      `Pentest cycle ${state.pentestCycle}/${state.config.workflow.maxPentestCycles}`,
    );
  if (state.localFixCycle > 0)
    parts.push(
      `Local fixes ${state.localFixCycle}/${state.config.workflow.maxLocalFixCycles}`,
    );
  return parts.length ? parts.join(" · ") : undefined;
}
export type AgentProgressStatus = keyof typeof symbols;
export interface DerivedAgentProgress {
  status: AgentProgressStatus;
  attempt?: number;
  detail?: string;
}
const roleOrder = [...roles];
function invalidates(event: WorkflowState["history"][number], role: Role) {
  if (event.event === "configuration_refresh") return true;
  if (event.event === "research_questions_answered")
    return role === "researcher";
  if (event.event === "FIX_REQUIREMENTS") return true;
  if (event.event === "FIX_DESIGN")
    return roleOrder.indexOf(role) >= roleOrder.indexOf("researcher");
  if (event.event === "FIX_LOCAL")
    return roleOrder.indexOf(role) >= roleOrder.indexOf("implementor");
  if (event.event === "downstream_invalidated") {
    const source = event.detail.match(/^After manual retry of (\w+)$/)?.[1] as
      Role | undefined;
    return (
      !!source &&
      (solverIds.includes(source as any)
        ? roleOrder.indexOf(role) >= roleOrder.indexOf("critic")
        : roleOrder.indexOf(role) > roleOrder.indexOf(source))
    );
  }
  return false;
}
export function deriveAgentProgressState(
  state: WorkflowState,
  role: Role,
  runtime?: ProgressRuntime,
): DerivedAgentProgress {
  const live = runtime?.agents[role];
  const history = state.history;
  const invalidation = history.findLastIndex((entry) =>
    invalidates(entry, role),
  );
  const lifecycle = history.findLastIndex(
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
  const latest = history[lifecycle];
  const completion = history.findLastIndex(
    (entry) =>
      entry.meta?.agent === role && entry.event === "agent_attempt_completed",
  );
  const latestStart = history.findLastIndex(
    (entry) =>
      entry.meta?.agent === role && entry.event === "agent_attempt_started",
  );
  const historicalResult =
    !!state.results[`previous_${role}`] ||
    completion >= 0 ||
    (invalidation >= 0 && !!state.results[role]);
  const currentResult =
    !!state.results[role] &&
    (invalidation < 0 || completion > invalidation) &&
    (latestStart < 0 || completion >= latestStart);
  if (state.pendingRuntimeCommands?.some((request) => request.agentId === role))
    return {
      status: "waiting",
      attempt: live?.attempt ?? latest?.meta?.attempt,
      detail: "waiting for command approval",
    };
  if (
    role === "researcher" &&
    state.pendingResearchQuestions?.length &&
    state.phase === "WAITING_USER"
  )
    return {
      status: "waiting",
      attempt: latest?.meta?.attempt,
      detail: `waiting for user answers · ${state.pendingResearchQuestions.length} questions`,
    };
  if (
    live?.status === "running" &&
    (invalidation < 0 ||
      lifecycle > invalidation ||
      (state.phase === "RESEARCH" && role === "researcher"))
  )
    return { status: "running", attempt: live.attempt };
  if (lifecycle > invalidation && latest?.event === "agent_attempt_failed")
    return { status: "failed", attempt: latest.meta?.attempt };
  if (lifecycle > invalidation && latest?.event === "agent_aborted_by_user")
    return { status: "aborted", attempt: latest.meta?.attempt };
  if (
    lifecycle > invalidation &&
    latest?.event === "agent_superseded_by_upstream_retry"
  )
    return { status: "stopped", attempt: latest.meta?.attempt };
  if (
    live?.status === "completed" &&
    lifecycle > invalidation &&
    latest?.event === "agent_attempt_completed" &&
    state.inFlight?.roles.includes(role)
  )
    return { status: "completed", attempt: latest.meta?.attempt };
  if (
    role === "pentester" &&
    state.phase === "BLOCKED" &&
    state.results.pentester?.status === "BLOCKED"
  )
    return { status: "failed", attempt: latest?.meta?.attempt };
  if (currentResult)
    return { status: "completed", attempt: latest?.meta?.attempt };
  if (latest?.event === "agent_attempt_started" && lifecycle > invalidation)
    return {
      status: "pending",
      attempt: latest.meta?.attempt,
      detail: "run incomplete",
    };
  if (invalidation >= 0 && historicalResult)
    return {
      status: "invalidated",
      detail: role === "codeReviewer" ? "re-review pending" : "rerun required",
    };
  if (
    live?.status === "failed" ||
    (state.phase === "BLOCKED" &&
      history.some(
        (entry) =>
          entry.event === "agent_attempt_failed" && entry.meta?.agent === role,
      ))
  )
    return {
      status: "failed",
      attempt: live?.attempt ?? latest?.meta?.attempt,
    };
  if (live?.status === "aborted" || live?.status === "stopped")
    return { status: live.status, attempt: live.attempt };
  return { status: "pending" };
}
export function elapsed(ms: number) {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}
function activityAge(ms: number) {
  if (ms < 10000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 60000) return `${Math.floor(ms / 1000)}s`;
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
function visibleRoles(state: WorkflowState) {
  return roles.filter((role) => {
    if (
      solverIds.includes(role as any) &&
      !getActiveSolverIds(state.config).includes(role as any)
    )
      return false;
    if (role === "pentester" && !state.config.qualityGates.pentest.enabled)
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
  const derived = deriveAgentProgressState(state, role, runtime);
  const latestStart = state.history.findLast(
    (entry) =>
      entry.event === "agent_attempt_started" &&
      entry.meta?.agent === role &&
      entry.meta.attempt === derived.attempt,
  );
  const trigger = live?.trigger ?? latestStart?.meta?.trigger;
  const retryNumber = live?.retryNumber ?? latestStart?.meta?.retryNumber ?? 0;
  const status = derived.status;
  const modelId = state.config.agents[role].model;
  const model = state.config.ui.progress.showModels
    ? ` [${/^[A-Za-z0-9._:/-]{1,80}$/.test(modelId) && !modelId.includes("://") ? modelId.slice(0, 24) : "model configured"}]`
    : "";
  const duration =
    live?.startedAt !== undefined &&
    ["running", "completed", "failed"].includes(status)
      ? `  ${elapsed(runtime!.elapsed(live))}`
      : "";
  const retry =
    retryNumber > 0 &&
    (trigger === "manual_retry" || trigger === "automatic_retry")
      ? ` · retry ${retryNumber}`
      : "";
  const attempt =
    derived.attempt && (live?.manualRetry || derived.attempt > 1)
      ? ` · run ${derived.attempt}`
      : "";
  const context =
    status === "running" && live?.contextUsage?.percent != null
      ? ` · context used ${Math.round(live.contextUsage.percent)}%`
      : "";
  const label = `${symbols[status]} ${getAgentDisplayName(state.config, role)}${showId ? ` (${role})` : ""}${model}${duration}${attempt}${retry}${context}${derived.detail ? ` · ${derived.detail}` : ""}`;
  const returnedBy =
    trigger === "fix_local" ||
    trigger === "fix_design" ||
    trigger === "fix_requirements"
      ? "Code Reviewer"
      : trigger === "pentest_remediation"
        ? "Pentester"
        : trigger === "security_remediation"
          ? "Security Reviewer"
          : trigger === "test_remediation"
            ? "Tester"
            : undefined;
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
  const provider = live?.providerProgress;
  const providerAge = provider
    ? Math.max(
        0,
        (runtime?.nowMs() ?? Date.now()) -
          (provider.lastActivityAt ?? provider.startedAt),
      )
    : 0;
  const providerStatus =
    status !== "running" || !provider
      ? undefined
      : providerAge >= 60000
        ? `  ↳ provider idle · ${activityAge(providerAge)} since ${provider.lastActivityAt === undefined ? "request start" : "last event"}`
        : provider.state === "waiting"
          ? "  ↳ waiting for model response"
          : `  ↳ ${provider.state === "tool_calling" ? "preparing tool call" : provider.state} · active ${activityAge(providerAge)} ago`;
  const preflight = status === "running" ? live?.modelPreflight : undefined;
  const modelStatus = preflight
    ? `  ↳ ${preflight.state === "checking" ? "checking model" : preflight.state === "downloading" || preflight.state === "downloaded" ? "downloading model" : preflight.state === "sleeping" ? "waking model" : "loading model"}${preflight.progress === undefined ? "" : ` · ${Math.round(preflight.progress * 100)}%`}`
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
      ? `  ↳ ${live.doomLoopInterventions ? `doom-loop interventions: ${live.doomLoopInterventions}/${state.config.agents[role].doomLoop?.maxInterventions ?? state.config.workflow.doomLoop.maxInterventions} · ` : ""}tool calls: ${live.toolCalls ?? 0}${(state.config.agents[role].maxToolCalls ?? state.config.workflow.maxToolCalls) > 0 ? `/${state.config.agents[role].maxToolCalls ?? state.config.workflow.maxToolCalls}` : ""}${live.toolsDisabledForFinalization ? " · tools: disabled for finalization" : ""}`
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
      ? `  ↳ Previous run failed: ${previous}`
      : status === "failed" && last
        ? `  ↳ Final error: ${last.detail.split(": ").at(-1)} · run ${last.meta?.attempt}`
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
    returnedBy && derived.attempt && derived.attempt > 1
      ? `  ↳ returned by ${returnedBy}`
      : undefined,
    control ?? reconnect ?? activity ?? modelStatus ?? providerStatus,
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
  for (const request of state.pendingRuntimeCommands ?? [])
    lines.push(
      `◉ ${getAgentDisplayName(state.config, request.agentId)} · command approval required\n  ↳ ${formatCommandLine(request.command)}`,
    );
  if (state.pendingResearchQuestions?.length)
    lines.push(
      `Pending research questions: ${state.pendingResearchQuestions.length}`,
    );
  if (state.pendingResearchQuestions?.length)
    lines.push(
      `Research clarification: ${state.researchClarificationCount}${state.config.workflow.maxResearchClarifications === 0 ? "" : `/${state.config.workflow.maxResearchClarifications}`}`,
    );
  if (state.inFlight && !runtime)
    lines.push(
      "Live runtime details unavailable; inspect or resume this workflow",
    );
  for (const role of visibleRoles(state))
    lines.push(...displayAgent(role, state, runtime, showIds));
  const gates = [
    ...(!state.config.qualityGates.pentest.enabled ? ["Pentest disabled"] : []),
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
  const counters = formatCycleProgress(state);
  if (counters) lines.push(counters);
  if (gates.length) lines.push(gates.join(" · "));
  if (state.blocker) lines.push(`Blocked: ${state.blocker}`);
  if (state.phase === "DONE")
    lines.push(
      `Report: ${state.results.reporter ? "available" : "deterministic fallback available"} · /team-report`,
    );
  if (
    state.history.some((entry) => entry.event === "agent_attempt_started") &&
    state.config.logging.agentLogs.level !== "off"
  )
    lines.push(`Logs: .pi/team/state/${state.id}.logs/ · /team-log`);
  return lines.map(redactVisibleText);
}
// The widget has a bounded history; /team-status uses renderProgress above.
export function renderLiveProgress(
  state: WorkflowState,
  runtime?: ProgressRuntime,
  rowBudget = 12,
) {
  const header = `Team ${state.id.slice(0, 8)} · ${state.phase === "BLOCKED" ? "BLOCKED" : runtime?.stopped ? "stopped" : state.phase.replaceAll("_", " ").toLowerCase()} · Design cycle ${state.fullCycle}/${state.config.workflow.maxFullCycles}`;
  const available = visibleRoles(state);
  const active = available.filter((role) => {
    const status = deriveAgentProgressState(state, role, runtime).status;
    return status === "running" || status === "waiting";
  });
  const completed = state.history
    .filter((entry) => entry.event === "agent_attempt_completed" && entry.meta)
    .map((entry) => entry.meta!.agent)
    .reverse()
    .filter((role, index, all) => all.indexOf(role) === index)
    .filter(
      (role) =>
        available.includes(role) &&
        !active.includes(role) &&
        deriveAgentProgressState(state, role, runtime).status === "completed",
    );
  const counters = formatCycleProgress(state);
  if (state.phase === "BLOCKED") {
    const pentest = state.results.pentester;
    const pentestBlocked = pentest?.status === "BLOCKED";
    const blockedRole: Role | undefined = pentestBlocked
      ? "pentester"
      : state.history.findLast(
          (event) => event.event === "agent_attempt_failed",
        )?.meta?.agent;
    const blockedRow = blockedRole
      ? displayAgent(blockedRole, state, runtime)[0].replace(
          /^[^ ]+/,
          symbols.failed,
        )
      : undefined;
    const waitingLines = active.flatMap((role) => [
      ...displayAgent(role, state, runtime),
      ...(state.pendingRuntimeCommands ?? [])
        .filter((request) => request.agentId === role)
        .map((request) => `  ↳ ${formatCommandLine(request.command)}`),
    ]);
    const focused = [
      header,
      ...waitingLines,
      ...(blockedRow ? [blockedRow] : []),
      "",
      pentestBlocked ? "Pentest blocked:" : "Workflow blocked:",
      pentestBlocked
        ? (pentest.blocker?.message ?? "Required testing incomplete")
        : (state.blocker ?? "Unknown blocker"),
      ...(pentestBlocked && pentest.blocker?.remediation
        ? [pentest.blocker.remediation]
        : []),
      ...(pentestBlocked ? ["Then: /team-retry pentester"] : []),
      "/team-status for full workflow",
    ];
    const history = completed
      .filter((role) => role !== blockedRole)
      .slice(0, Math.max(0, Math.min(2, rowBudget - focused.length)))
      .reverse();
    return [
      header,
      ...history.map((role) => displayAgent(role, state, runtime)[0]),
      ...focused.slice(1),
    ];
  }
  const activeLines = active.flatMap((role) => {
    const request = state.pendingRuntimeCommands?.find(
      (item) => item.agentId === role,
    );
    return [
      ...displayAgent(role, state, runtime),
      ...(request ? [`  ↳ ${formatCommandLine(request.command)}`] : []),
    ];
  });
  const phases = Object.keys(phaseRoles) as (keyof typeof phaseRoles)[];
  const index = phases.indexOf(state.phase as keyof typeof phaseRoles);
  const nextPhase = (index < 0 ? [] : phases.slice(index + 1)).find((phase) =>
    getPhaseRoles(state, phase)?.some((role) => available.includes(role)),
  );
  const nextRoles = nextPhase
    ? (getPhaseRoles(state, nextPhase)?.filter((role) =>
        available.includes(role),
      ) ?? [])
    : [];
  const next = nextRoles.length
    ? `Next: ${nextRoles.map((role) => getAgentDisplayName(state.config, role)).join(", ")}`
    : undefined;
  const footer = "/team-status for full workflow";
  const waiting =
    state.phase === "WAITING_USER" && !active.length
      ? ["◉ Waiting for user input"]
      : [];
  const reserved =
    1 +
    activeLines.length +
    waiting.length +
    (next ? 1 : 0) +
    (counters ? 1 : 0) +
    1;
  const historyCount = Math.max(0, Math.min(2, rowBudget - reserved));
  const recent = completed.slice(0, historyCount).reverse();
  return [
    header,
    ...recent.map((role) => displayAgent(role, state, runtime)[0]),
    ...activeLines,
    ...waiting,
    ...(next ? [next] : []),
    ...(counters ? [counters] : []),
    footer,
  ];
}
export function progress(
  ctx: ExtensionContext,
  state: WorkflowState,
  runtime?: ProgressRuntime,
) {
  runtime?.refreshContextUsage();
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
      ? renderLiveProgress(state, runtime).map((rawLine) => {
          const line = redactVisibleText(rawLine);
          const theme = ctx.ui.theme;
          if (!theme?.fg) return line;
          if (line.startsWith("✓ ")) return theme.fg("dim", line);
          if (line.startsWith("● ")) return theme.fg("accent", line);
          if (line.startsWith("◉ ")) return theme.fg("warning", line);
          if (line.startsWith("✗ ") || line.includes(" blocked:"))
            return theme.fg("error", line);
          if (line.startsWith("Next:") || line.startsWith("/team-status"))
            return theme.fg("dim", line);
          return line;
        })
      : undefined,
  );
}
