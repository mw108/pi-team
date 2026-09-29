import type { Role } from "../agents/schemas.ts";
import type { WorkflowState } from "../workflow/state.ts";
import { formatToolActivity } from "./activity.ts";
import type { GuardEvent } from "../agents/runner.ts";

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
  previousFailure?: string;
  attempt?: number;
  controlActivity?: string;
  manualRetry?: boolean;
  toolCalls?: number;
  doomLoopInterventions?: number;
  toolsDisabledForFinalization?: boolean;
  networkRetry?: {
    retry: number;
    maxRetries: number;
    delayMs: number;
    retryAt?: number;
    category: string;
  };
}
export type AgentEvent =
  | {
      type: "start" | "complete";
      role: Role;
      attempt?: number;
      trigger?: "initial" | "automatic_retry" | "manual_retry";
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
      retry: number;
      maxRetries: number;
      delayMs: number;
      retryAt: number;
      category: string;
    }
  | { type: "networkStarted"; role: Role }
  | { type: "networkClear"; role: Role }
  | {
      type: "activity";
      role: Role;
      toolName: string;
      toolCallId?: string;
      innerToolName?: string;
    }
  | { type: "activityEnd"; role: Role; toolCallId?: string }
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
    if (event.type === "start")
      this.agents[event.role] = {
        instanceId: event.role,
        status: "running",
        startedAt: this.now(),
        attempt: event.attempt,
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
      if (event.event.type === "doom_loop_steer") {
        existing.doomLoopInterventions = event.event.intervention;
        existing.controlActivity = `Repeated tool pattern detected · steering ${event.event.intervention}/${event.event.maxInterventions}`;
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
      existing.controlActivity = `Restarting as attempt ${event.attempt}`;
      existing.networkRetry = undefined;
    } else if (event.type === "aborted" && existing) {
      existing.status = "aborted";
      existing.completedAt = this.now();
      existing.controlActivity = undefined;
      existing.error = "Aborted by user";
    } else if (event.type === "superseded" && existing) {
      existing.status = "stopped";
      existing.completedAt = this.now();
      existing.controlActivity = undefined;
      existing.error = "Stopped for upstream retry";
    } else if (event.type === "complete" || event.type === "fail") {
      this.agents[event.role] = {
        ...existing,
        instanceId: event.role,
        status: event.type === "complete" ? "completed" : "failed",
        completedAt: this.now(),
        activity: undefined,
        toolCallId: undefined,
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
    } else if (event.type === "networkRetry" && existing) {
      existing.networkRetry = {
        retry: event.retry,
        maxRetries: event.maxRetries,
        delayMs: event.delayMs,
        retryAt: event.retryAt,
        category: event.category,
      };
    } else if (event.type === "networkStarted" && existing?.networkRetry) {
      existing.networkRetry.retryAt = undefined;
    } else if (event.type === "networkClear" && existing) {
      existing.networkRetry = undefined;
    } else if (event.type === "activity" && existing?.status === "running") {
      existing.toolCalls = (existing.toolCalls ?? 0) + 1;
      if (!existing.toolsDisabledForFinalization)
        existing.controlActivity = undefined;
      existing.activity = formatToolActivity(
        event.toolName,
        this.state?.config,
        event.innerToolName,
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
