import type { Role } from "../agents/schemas.ts";
import type { WorkflowState } from "../workflow/state.ts";
import { formatToolActivity } from "./activity.ts";

export type AgentRuntimeStatus =
  "pending" | "running" | "completed" | "failed" | "stopped";
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
}
export type AgentEvent =
  | { type: "start" | "complete"; role: Role }
  | { type: "fail"; role: Role; error: string }
  | { type: "retry"; role: Role; attempt: number; reason: string }
  | {
      type: "activity";
      role: Role;
      toolName: string;
      toolCallId?: string;
      innerToolName?: string;
    }
  | { type: "activityEnd"; role: Role; toolCallId?: string };

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
      };
    else if (event.type === "complete" || event.type === "fail") {
      this.agents[event.role] = {
        ...existing,
        instanceId: event.role,
        status: event.type === "complete" ? "completed" : "failed",
        completedAt: this.now(),
        activity: undefined,
        toolCallId: undefined,
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
    } else if (event.type === "activity" && existing?.status === "running") {
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
