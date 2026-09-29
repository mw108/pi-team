import type { Role } from "./schemas.ts";
import type { TeamConfig } from "../config/schema.ts";

export const getAgentTimeoutMs = (
  config: TeamConfig,
  role: Role,
): number | undefined => {
  const configured =
    config.agents[role].timeoutMs ?? config.workflow.agentTimeoutMs;
  return configured === 0 ? undefined : configured;
};

export const formatAgentTimeout = (timeoutMs: number | undefined) =>
  timeoutMs === undefined ? "unlimited" : `${timeoutMs} ms`;

export class AgentTimeoutError extends Error {
  readonly category = "timeout";
  constructor(
    readonly agentId: Role,
    readonly timeoutMs: number,
    readonly attempt: number,
  ) {
    super(`${agentId} timed out after ${timeoutMs} ms (attempt ${attempt})`);
    this.name = "AgentTimeoutError";
  }
}

export class AgentAbortedByUserError extends Error {
  readonly failures = 0;
  constructor(
    readonly agentId: Role,
    readonly attempt: number,
  ) {
    super(`${agentId} attempt ${attempt} aborted by user`);
    this.name = "AgentAbortedByUserError";
  }
}

export class AgentSupersededForRetryError extends Error {
  readonly failures = 0;
  constructor(
    readonly agentId: Role,
    readonly attempt: number,
  ) {
    super(`${agentId} attempt ${attempt} stopped for an upstream manual retry`);
    this.name = "AgentSupersededForRetryError";
  }
}

export type FailureCategory =
  | "cancelled"
  | "timeout"
  | "http_503"
  | "rate_limit"
  | "network"
  | "schema"
  | "tool"
  | "other";

export function classifyFailure(error: unknown): FailureCategory {
  if (error instanceof AgentTimeoutError) return "timeout";
  const value = error as { status?: number; code?: string; name?: string };
  if (value?.status === 429 || value?.code === "429") return "rate_limit";
  if (value?.status === 503 || value?.code === "503") return "http_503";
  if (
    typeof value?.code === "string" &&
    /^(ECONN|ENET|ETIMEDOUT|EAI_)/.test(value.code)
  )
    return "network";
  const message = String(error);
  if (/\b429\b|rate limit/i.test(message)) return "rate_limit";
  if (/\b503\b/.test(message)) return "http_503";
  if (/timeout|timed out/i.test(message)) return "timeout";
  if (/ECONN|fetch failed|network/i.test(message)) return "network";
  if (/json|schema|validat/i.test(message)) return "schema";
  if (/tool|command/i.test(message)) return "tool";
  return "other";
}

export function safeFailureLabel(
  category: FailureCategory,
  timeoutMs?: number,
) {
  switch (category) {
    case "cancelled":
      return "cancelled";
    case "timeout":
      return `timeout${
        timeoutMs
          ? ` after ${Math.floor(timeoutMs / 60000)
              .toString()
              .padStart(2, "0")}:${Math.floor((timeoutMs % 60000) / 1000)
              .toString()
              .padStart(2, "0")}`
          : ""
      }`;
    case "http_503":
      return "HTTP 503";
    case "rate_limit":
      return "rate limited";
    case "network":
      return "network error";
    case "schema":
      return "invalid agent output";
    case "tool":
      return "tool failure";
    default:
      return "agent error";
  }
}
