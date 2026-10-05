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
    super(`${agentId} timed out after ${timeoutMs} ms (run ${attempt})`);
    this.name = "AgentTimeoutError";
  }
}

export class AgentDoomLoopError extends Error {
  readonly category = "doom_loop";
  constructor(
    readonly agentId: Role,
    readonly attempt: number,
    readonly interventions: number,
  ) {
    super(
      `${agentId} run ${attempt} could not finalize after ${interventions} doom-loop interventions`,
    );
    this.name = "AgentDoomLoopError";
  }
}

export class AgentOutputError extends Error {
  readonly category = "agent_output";
  constructor(
    readonly kind: "parse" | "schema" | "finalization",
    readonly agentId: Role,
    readonly rawFinalResponsePreview: string,
    finalizing = false,
    readonly diagnostic?: string,
  ) {
    const display = agentId[0].toUpperCase() + agentId.slice(1);
    super(
      kind === "finalization"
        ? `${display} returned invalid final output after tool finalization. The response attempted another tool call instead of returning the required ${display} JSON. Next: /team-retry ${agentId}`
        : `${display} returned invalid final output${finalizing ? " after tool finalization" : ""} (${kind}). Next: /team-retry ${agentId}`,
    );
    this.name = "AgentOutputError";
  }
}

export class AgentAbortedByUserError extends Error {
  readonly failures = 0;
  constructor(
    readonly agentId: Role,
    readonly attempt: number,
  ) {
    super(`${agentId} run ${attempt} aborted by user`);
    this.name = "AgentAbortedByUserError";
  }
}

export class AgentSupersededForRetryError extends Error {
  readonly failures = 0;
  constructor(
    readonly agentId: Role,
    readonly attempt: number,
  ) {
    super(`${agentId} run ${attempt} stopped for an upstream manual retry`);
    this.name = "AgentSupersededForRetryError";
  }
}

export type FailureCategory =
  | "doom_loop"
  | "agent_output"
  | "cancelled"
  | "timeout"
  | "http_503"
  | "rate_limit"
  | "network"
  | "schema"
  | "tool"
  | "other";

export function classifyFailure(error: unknown): FailureCategory {
  if (error instanceof AgentOutputError) return "agent_output";
  if (error instanceof AgentDoomLoopError) return "doom_loop";
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

/** Mirror the existing workflow classifier for log provenance only. */
export function explainFailure(error: unknown): {
  category: FailureCategory;
  matchedRule: string | null;
} {
  const category = classifyFailure(error);
  if (category === "other") return { category, matchedRule: null };
  if (error instanceof AgentDoomLoopError)
    return { category, matchedRule: "AgentDoomLoopError" };
  if (error instanceof AgentOutputError)
    return { category, matchedRule: `AgentOutputError:${error.kind}` };
  if (error instanceof AgentTimeoutError)
    return { category, matchedRule: "AgentTimeoutError" };
  const value = error as { status?: number; code?: string };
  if (value?.status === 429 || value?.code === "429")
    return { category, matchedRule: "status/code=429" };
  if (value?.status === 503 || value?.code === "503")
    return { category, matchedRule: "status/code=503" };
  if (
    typeof value?.code === "string" &&
    /^(ECONN|ENET|ETIMEDOUT|EAI_)/.test(value.code)
  )
    return { category, matchedRule: `code=${value.code}` };
  const message = String(error);
  const rules: [RegExp, string][] = [
    [/\b429\b|rate limit/i, "message=rate_limit"],
    [/\b503\b/, "message=http_503"],
    [/timeout|timed out/i, "message=timeout"],
    [/ECONN|fetch failed|network/i, "message=network"],
    [/json|schema|validat/i, "message=schema"],
    [/tool|command/i, "message=tool"],
  ];
  return {
    category,
    matchedRule: rules.find(([pattern]) => pattern.test(message))?.[1] ?? null,
  };
}

export function safeFailureLabel(
  category: FailureCategory,
  timeoutMs?: number,
) {
  switch (category) {
    case "doom_loop":
      return "doom loop persisted";
    case "agent_output":
      return "invalid agent final output";
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
