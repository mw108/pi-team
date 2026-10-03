import type { TeamConfig } from "../config/schema.ts";
import type { Role } from "./schemas.ts";

export const defaultRequestTimeoutMs = 300000;

export interface ResolvedRequestTimeout {
  value: number;
  source: "agent" | "workflow" | "default";
  mode?: "unlimited";
}

export function resolveRequestTimeout(
  config: TeamConfig,
  role: Role,
): ResolvedRequestTimeout {
  const agent = config.agents[role].requestTimeoutMs;
  const workflow = config.workflow.requestTimeoutMs;
  const value = agent ?? workflow ?? defaultRequestTimeoutMs;
  return {
    value,
    source:
      agent !== undefined
        ? "agent"
        : workflow !== undefined
          ? "workflow"
          : "default",
    ...(value === 0 ? { mode: "unlimited" as const } : {}),
  };
}

// Pi 0.99 maps its disabled HTTP timeout to this largest supported Node timer.
// Passing 0 to OpenAI's SDK instead starts an immediate abort timer.
export function piRequestTimeoutMs(timeout: ResolvedRequestTimeout): number {
  return timeout.value === 0 ? 2147483647 : timeout.value;
}
