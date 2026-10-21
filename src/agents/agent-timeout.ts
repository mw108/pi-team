import { performance } from "node:perf_hooks";

export type AgentTimeoutPauseReason =
  | "model_preflight"
  | "runtime_command_approval"
  | "runtime_file_approval"
  | "contract_path_approval";

export type AgentTimeoutEvent = {
  type: "agent_timeout_paused" | "agent_timeout_resumed";
  reason: AgentTimeoutPauseReason;
  remainingMs: number | null;
  activeExecutionMs: number | null;
  waitingForUserMs: number;
  pauseDurationMs?: number;
};

export type AgentHumanInputWait = <T>(
  reason: Exclude<AgentTimeoutPauseReason, "model_preflight">,
  operation: () => Promise<T>,
) => Promise<T>;

type Timer = ReturnType<typeof setTimeout>;

export type AgentTimeoutBudgetOptions = {
  now?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => Timer;
  clearTimer?: (timer: Timer) => void;
  onTimeout(): void;
  onEvent?(event: AgentTimeoutEvent): void;
};

/** Tracks active execution time while independent pause owners hold tokens. */
export class AgentTimeoutBudget {
  private readonly now: () => number;
  private readonly setTimer: (callback: () => void, delayMs: number) => Timer;
  private readonly clearTimer: (timer: Timer) => void;
  private readonly onTimeout: () => void;
  private readonly onEvent?: (event: AgentTimeoutEvent) => void;
  private remainingMs: number | undefined;
  private activeStartedAt: number | undefined;
  private timer: Timer | undefined;
  private readonly pauses = new Map<symbol, AgentTimeoutPauseReason>();
  private pauseStartedAt: number | undefined;
  private totalPausedMs = 0;
  private expired = false;
  private stopped = false;

  constructor(
    readonly timeoutMs: number | undefined,
    options: AgentTimeoutBudgetOptions,
  ) {
    this.remainingMs = timeoutMs;
    this.now = options.now ?? performance.now.bind(performance);
    this.setTimer = options.setTimer ?? setTimeout;
    this.clearTimer = options.clearTimer ?? clearTimeout;
    this.onTimeout = options.onTimeout;
    this.onEvent = options.onEvent;
  }

  start() {
    if (
      this.timeoutMs === undefined ||
      this.activeStartedAt !== undefined ||
      this.pauses.size ||
      this.expired ||
      this.stopped
    )
      return;
    if ((this.remainingMs ?? 0) <= 0) {
      this.expire();
      return;
    }
    this.activeStartedAt = this.now();
    this.timer = this.setTimer(() => this.expire(), this.remainingMs!);
  }

  pause(reason: AgentTimeoutPauseReason): () => void {
    if (this.timeoutMs === undefined || this.expired || this.stopped)
      return () => {};
    const token = Symbol(reason);
    const first = this.pauses.size === 0;
    this.pauses.set(token, reason);
    if (first) {
      this.debitActiveTime();
      this.pauseStartedAt = this.now();
      this.emit({
        type: "agent_timeout_paused",
        reason,
        remainingMs: this.remaining(),
        activeExecutionMs: this.elapsed(),
        waitingForUserMs: this.waiting(),
      });
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (!this.pauses.delete(token) || this.pauses.size) return;
      const pauseDurationMs = Math.max(
        0,
        this.now() - (this.pauseStartedAt ?? this.now()),
      );
      this.totalPausedMs += pauseDurationMs;
      this.pauseStartedAt = undefined;
      this.emit({
        type: "agent_timeout_resumed",
        reason,
        remainingMs: this.remaining(),
        activeExecutionMs: this.elapsed(),
        waitingForUserMs: this.waiting(),
        pauseDurationMs,
      });
      this.start();
    };
  }

  async withPaused<T>(
    reason: AgentTimeoutPauseReason,
    operation: () => Promise<T>,
  ): Promise<T> {
    const release = this.pause(reason);
    try {
      return await operation();
    } finally {
      release();
    }
  }

  elapsed(): number | null {
    if (this.timeoutMs === undefined) return null;
    const active =
      this.activeStartedAt === undefined
        ? 0
        : Math.max(0, this.now() - this.activeStartedAt);
    return Math.min(
      this.timeoutMs,
      Math.max(0, this.timeoutMs - (this.remainingMs ?? 0) + active),
    );
  }

  remaining(): number | null {
    if (this.timeoutMs === undefined) return null;
    return Math.max(0, this.timeoutMs - (this.elapsed() ?? 0));
  }

  waiting(): number {
    return (
      this.totalPausedMs +
      (this.pauseStartedAt === undefined
        ? 0
        : Math.max(0, this.now() - this.pauseStartedAt))
    );
  }

  stop() {
    if (this.stopped) return;
    this.debitActiveTime();
    if (this.pauseStartedAt !== undefined) {
      this.totalPausedMs += Math.max(0, this.now() - this.pauseStartedAt);
      this.pauseStartedAt = undefined;
    }
    this.pauses.clear();
    this.stopped = true;
  }

  private debitActiveTime() {
    if (this.activeStartedAt !== undefined) {
      this.remainingMs = Math.max(
        0,
        (this.remainingMs ?? 0) - (this.now() - this.activeStartedAt),
      );
      this.activeStartedAt = undefined;
    }
    if (this.timer) this.clearTimer(this.timer);
    this.timer = undefined;
  }

  private expire() {
    if (this.expired || this.stopped || this.pauses.size) return;
    this.debitActiveTime();
    this.remainingMs = 0;
    this.expired = true;
    this.onTimeout();
  }

  private emit(event: AgentTimeoutEvent) {
    try {
      this.onEvent?.(event);
    } catch {
      // Diagnostics must never alter timeout or cancellation behavior.
    }
  }
}
