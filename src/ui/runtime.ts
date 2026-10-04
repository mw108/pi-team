import type { Role } from "../agents/schemas.ts";
import type { WorkflowState } from "../workflow/state.ts";
import { formatToolActivity } from "./activity.ts";
import type { CommandSummary } from "../agents/command-observability.ts";
import type { GuardEvent } from "../agents/runner.ts";
import type { ContextUsage } from "@earendil-works/pi-coding-agent";
import type { ActiveSessionRegistry } from "../agents/active-sessions.ts";
import type {
  ProviderLiveProgress,
  ProviderProgressUpdate,
} from "../agents/network-retry.ts";
import type { ModelPreflightUpdate } from "../agents/model-preflight.ts";

export type AgentRuntimeStatus =
  "pending" | "running" | "completed" | "failed" | "stopped" | "aborted";
export interface AgentProgress {
  instanceId: Role;
  status: AgentRuntimeStatus;
  startedAt?: number;
  completedAt?: number;
  activity?: string;
  toolCallId?: string;
  error?: string;
  retry?: number;
  retryNumber?: number;
  trigger?: Extract<AgentEvent, { type: "start" | "complete" }>["trigger"];
  previousFailure?: string;
  attempt?: number;
  controlActivity?: string;
  manualRetry?: boolean;
  toolCalls?: number;
  doomLoopInterventions?: number;
  doomLoopReason?: string;
  toolsDisabledForFinalization?: boolean;
  networkRetry?: {
    status: "waiting_retry" | "reconnecting";
    retry: number;
    maxRetries: number;
    delayMs: number;
    retryAt?: number;
    category: string;
    nextProviderRequest: number;
  };
  latestProviderRequest?: number;
  endedProviderRequest?: number;
  contextUsage?: ContextUsage;
  providerProgress?: ProviderLiveProgress;
  modelPreflight?: Extract<ModelPreflightUpdate, { kind: "model_preflight" }>;
}
export type AgentEvent =
  | {
      type: "start" | "complete";
      role: Role;
      attempt?: number;
      retryNumber?: number;
      trigger?:
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
        | "test_remediation";
    }
  | { type: "fail"; role: Role; error: string }
  | { type: "retry"; role: Role; attempt: number; reason: string }
  | {
      type: "steer" | "steerClear" | "aborting" | "aborted" | "superseded";
      role: Role;
    }
  | { type: "restarting"; role: Role; attempt: number }
  | {
      type: "networkRetry";
      role: Role;
      workflowId: string;
      attempt: number;
      providerRequest: number;
      retry: number;
      maxRetries: number;
      delayMs: number;
      retryAt?: number;
      category: string;
    }
  | {
      type: "networkStarted";
      role: Role;
      workflowId: string;
      attempt: number;
      providerRequest: number;
      retry: number;
    }
  | {
      type: "networkClear";
      role: Role;
      workflowId: string;
      attempt: number;
      providerRequest: number;
      reason: "recovered" | "exhausted";
    }
  | {
      type: "providerProgress";
      role: Role;
      workflowId: string;
      attempt: number;
      update: ProviderProgressUpdate;
    }
  | {
      type: "modelPreflight";
      role: Role;
      workflowId: string;
      attempt: number;
      update: ModelPreflightUpdate;
    }
  | {
      type: "activity";
      role: Role;
      toolName: string;
      toolCallId?: string;
      innerToolName?: string;
      command?: CommandSummary;
    }
  | { type: "activityEnd"; role: Role; toolCallId?: string }
  | { type: "commandApproved"; role: Role; command: CommandSummary }
  | { type: "guard"; role: Role; event: GuardEvent };

function interval(callback: () => void, ms: number) {
  const timer = setInterval(callback, ms);
  timer.unref?.();
  return () => clearInterval(timer);
}

export class ProgressRuntime {
  readonly agents: Partial<Record<Role, AgentProgress>> = {};
  state?: WorkflowState;
  stopped = false;
  private cancelTimer?: () => void;
  private disposed = false;
  private sessions?: ActiveSessionRegistry;
  constructor(
    private readonly changed: () => void,
    private refreshMs = 2000,
    private readonly now: () => number = Date.now,
    private heartbeat = true,
    private readonly schedule: (
      callback: () => void,
      ms: number,
    ) => () => void = interval,
  ) {}
  bindSessions(sessions: ActiveSessionRegistry) {
    this.sessions = sessions;
  }
  refreshContextUsage() {
    if (this.disposed || !this.state) return;
    for (const [role, agent] of Object.entries(this.agents) as [
      Role,
      AgentProgress,
    ][]) {
      agent.contextUsage = undefined;
      if (agent.status !== "running") continue;
      const entry = this.sessions?.get(this.state.id, role);
      if (!entry || entry.attempt !== agent.attempt) continue;
      try {
        const usage = entry.session.getContextUsage();
        if (usage?.percent != null && Number.isFinite(usage.percent))
          agent.contextUsage = usage;
      } catch {
        // Context telemetry must never affect an active agent.
      }
    }
  }
  configure(refreshMs: number, heartbeat: boolean) {
    if (this.disposed) return;
    if (this.refreshMs === refreshMs && this.heartbeat === heartbeat) return;
    this.cancelTimer?.();
    this.cancelTimer = undefined;
    this.refreshMs = refreshMs;
    this.heartbeat = heartbeat;
    this.updateTimer();
  }
  get heartbeatActive() {
    return this.cancelTimer !== undefined;
  }
  private emit() {
    try {
      this.changed();
    } catch {
      // A UI failure must not change workflow or agent outcomes.
    }
  }
  bind(state: WorkflowState) {
    if (this.disposed) return;
    this.state = state;
    if (["WAITING_USER", "BLOCKED", "DONE"].includes(state.phase))
      for (const agent of Object.values(this.agents))
        if (agent.status === "running") {
          agent.status = state.phase === "BLOCKED" ? "failed" : "stopped";
          agent.completedAt = this.now();
          agent.activity = undefined;
          agent.toolCallId = undefined;
          agent.providerProgress = undefined;
          agent.modelPreflight = undefined;
          if (state.phase === "BLOCKED")
            agent.error = "Workflow blocked; inspect state";
        }
    if (state.phase !== "WAITING_USER")
      for (const [role, agent] of Object.entries(this.agents) as [
        Role,
        AgentProgress,
      ][])
        if (agent.status === "completed" && !state.results[role])
          delete this.agents[role];
    this.updateTimer();
    this.emit();
  }
  event(event: AgentEvent) {
    if (this.disposed || this.stopped) return;
    const existing = this.agents[event.role];
    if (event.type === "modelPreflight") {
      if (
        this.state?.id !== event.workflowId ||
        existing?.status !== "running" ||
        existing.attempt !== event.attempt
      )
        return;
      existing.modelPreflight =
        event.update.kind === "model_preflight" ? event.update : undefined;
      this.emit();
      return;
    }
    if (event.type === "providerProgress") {
      if (
        this.state?.id !== event.workflowId ||
        existing?.status !== "running" ||
        existing.attempt !== event.attempt
      )
        return;
      const currentRequest = existing.latestProviderRequest ?? 0;
      if (event.update.providerRequest < currentRequest) return;
      if (
        !("ended" in event.update) &&
        event.update.providerRequest <= (existing.endedProviderRequest ?? 0)
      )
        return;
      existing.latestProviderRequest = event.update.providerRequest;
      if ("ended" in event.update) {
        existing.endedProviderRequest = event.update.providerRequest;
        if (event.update.providerRequest === currentRequest)
          existing.providerProgress = undefined;
      } else {
        existing.providerProgress = event.update;
        existing.modelPreflight = undefined;
        if (
          event.update.streamEventCount > 0 &&
          event.update.providerRequest >=
            (existing.networkRetry?.nextProviderRequest ?? Infinity)
        ) {
          existing.networkRetry = undefined;
          this.emit();
        }
      }
      // The heartbeat renders ordinary deltas; recovery repaints immediately.
      return;
    }
    if (event.type === "start")
      this.agents[event.role] = {
        instanceId: event.role,
        status: "running",
        startedAt: this.now(),
        attempt: event.attempt,
        retryNumber: event.retryNumber,
        trigger: event.trigger,
        toolCalls: 0,
        doomLoopInterventions: 0,
        manualRetry: event.trigger === "manual_retry",
        previousFailure:
          event.trigger === "automatic_retry"
            ? existing?.previousFailure
            : undefined,
      };
    else if (event.type === "steer" && existing)
      existing.controlActivity = "Steering message queued";
    else if (event.type === "guard" && existing) {
      if (event.event.type === "doom_loop_detected") {
        existing.doomLoopReason =
          event.event.patternType === "tool_call_burst" &&
          event.event.limit !== undefined
            ? `tool-call burst >${event.event.limit}`
            : `${event.event.repeatCount} ${event.event.patternType.replaceAll("_", " ")}`;
      } else if (event.event.type === "tool_call_burst_limited") {
        existing.doomLoopReason = `tool-call burst ${event.event.allowed}/${event.event.emitted} allowed`;
      } else if (event.event.type === "doom_loop_steer") {
        existing.doomLoopInterventions = event.event.intervention;
        existing.controlActivity = `Doom Loop intervention ${event.event.intervention}/${event.event.maxInterventions} · ${existing.doomLoopReason ?? "repeated tool use"}`;
      } else if (event.event.type === "doom_loop_finalization") {
        existing.toolsDisabledForFinalization = true;
        existing.controlActivity =
          "Tool loop persisted · finalizing without tools";
      } else if (event.event.type === "tool_budget_finalization") {
        existing.toolsDisabledForFinalization = true;
        existing.controlActivity =
          "Tool budget reached · finalizing without tools";
      }
    } else if (
      event.type === "steerClear" &&
      existing &&
      existing.controlActivity === "Steering message queued"
    )
      existing.controlActivity = undefined;
    else if (event.type === "aborting" && existing)
      existing.controlActivity = "Aborting...";
    else if (event.type === "restarting" && existing) {
      existing.controlActivity = `Restarting as run ${event.attempt}`;
      existing.networkRetry = undefined;
      existing.latestProviderRequest = undefined;
      existing.endedProviderRequest = undefined;
      existing.providerProgress = undefined;
      existing.modelPreflight = undefined;
    } else if (event.type === "aborted" && existing) {
      existing.status = "aborted";
      existing.completedAt = this.now();
      existing.controlActivity = undefined;
      existing.error = "Aborted by user";
      existing.providerProgress = undefined;
      existing.modelPreflight = undefined;
    } else if (event.type === "superseded" && existing) {
      existing.status = "stopped";
      existing.completedAt = this.now();
      existing.controlActivity = undefined;
      existing.error = "Stopped for upstream retry";
      existing.providerProgress = undefined;
      existing.modelPreflight = undefined;
    } else if (event.type === "complete" || event.type === "fail") {
      this.agents[event.role] = {
        ...existing,
        instanceId: event.role,
        status: event.type === "complete" ? "completed" : "failed",
        completedAt: this.now(),
        activity: undefined,
        toolCallId: undefined,
        providerProgress: undefined,
        modelPreflight: undefined,
        controlActivity: undefined,
        error:
          event.type === "fail"
            ? "Agent or provider error; see workflow state"
            : undefined,
      };
    } else if (event.type === "retry" && existing) {
      existing.retry = event.attempt;
      existing.previousFailure = event.reason;
      existing.activity = undefined;
      existing.toolCallId = undefined;
      existing.providerProgress = undefined;
      existing.modelPreflight = undefined;
    } else if (
      event.type === "networkRetry" &&
      existing?.status === "running" &&
      this.state?.id === event.workflowId &&
      existing.attempt === event.attempt &&
      event.providerRequest >= (existing.latestProviderRequest ?? 0) &&
      (existing.networkRetry?.nextProviderRequest !==
        event.providerRequest + 1 ||
        event.retry >= existing.networkRetry.retry)
    ) {
      existing.networkRetry = {
        status: "waiting_retry",
        retry: event.retry,
        maxRetries: event.maxRetries,
        delayMs: event.delayMs,
        retryAt: event.retryAt,
        category: event.category,
        nextProviderRequest: event.providerRequest + 1,
      };
    } else if (
      event.type === "networkStarted" &&
      this.state?.id === event.workflowId &&
      existing?.status === "running" &&
      existing.attempt === event.attempt &&
      event.providerRequest ===
        (existing.networkRetry?.nextProviderRequest ?? 0) - 1 &&
      existing.networkRetry?.retry === event.retry
    ) {
      existing.networkRetry.status = "reconnecting";
      existing.networkRetry.retryAt = undefined;
    } else if (
      event.type === "networkClear" &&
      this.state?.id === event.workflowId &&
      existing?.status === "running" &&
      existing.attempt === event.attempt &&
      event.providerRequest >=
        (existing.networkRetry?.nextProviderRequest ?? Infinity) -
          (event.reason === "exhausted" ? 1 : 0)
    ) {
      existing.networkRetry = undefined;
    } else if (
      event.type === "commandApproved" &&
      existing?.status === "running"
    ) {
      existing.activity = formatToolActivity(
        "team_command",
        this.state?.config,
        undefined,
        event.command,
      );
    } else if (event.type === "activity" && existing?.status === "running") {
      existing.toolCalls = (existing.toolCalls ?? 0) + 1;
      if (!existing.toolsDisabledForFinalization)
        existing.controlActivity = undefined;
      existing.activity = formatToolActivity(
        event.toolName,
        this.state?.config,
        event.innerToolName,
        event.command,
      );
      existing.toolCallId = event.toolCallId;
    } else if (
      event.type === "activityEnd" &&
      existing?.status === "running" &&
      (!event.toolCallId || event.toolCallId === existing.toolCallId)
    ) {
      existing.activity = undefined;
      existing.toolCallId = undefined;
    }
    this.updateTimer();
    this.emit();
  }
  cancel() {
    if (this.disposed) return;
    this.stopped = true;
    for (const agent of Object.values(this.agents))
      if (agent.status === "running") {
        agent.status = "stopped";
        agent.completedAt = this.now();
        agent.activity = undefined;
        agent.toolCallId = undefined;
        agent.providerProgress = undefined;
        agent.modelPreflight = undefined;
      }
    this.updateTimer();
    this.emit();
  }
  dispose() {
    this.disposed = true;
    this.cancelTimer?.();
    this.cancelTimer = undefined;
  }
  elapsed(agent: AgentProgress) {
    return Math.max(
      0,
      (agent.completedAt ?? this.now()) - (agent.startedAt ?? this.now()),
    );
  }
  nowMs() {
    return this.now();
  }
  private updateTimer() {
    const running = Object.values(this.agents).some(
      (agent) => agent.status === "running",
    );
    if (running && this.heartbeat && !this.cancelTimer) {
      this.cancelTimer = this.schedule(() => this.emit(), this.refreshMs);
    } else if ((!running || !this.heartbeat) && this.cancelTimer) {
      this.cancelTimer();
      this.cancelTimer = undefined;
    }
  }
}
