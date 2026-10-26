import type { TeamConfig } from "../config/schema.ts";
import type { Role } from "./schemas.ts";

export const defaultProviderRequestDeadlineMs = 1_200_000;
export const defaultReasoningStallTimeoutMs = 600_000;

export interface ResolvedProviderDuration {
  value: number;
  source: "agent" | "workflow" | "default";
  mode?: "disabled";
}

export interface ResolvedProviderRequestLimits {
  providerRequestDeadlineMs: ResolvedProviderDuration;
  reasoningStallTimeoutMs: ResolvedProviderDuration;
}

function resolved(
  agent: number | undefined,
  workflow: number | undefined,
  fallback: number,
): ResolvedProviderDuration {
  const value = agent ?? workflow ?? fallback;
  return {
    value,
    source:
      agent !== undefined
        ? "agent"
        : workflow !== undefined
          ? "workflow"
          : "default",
    ...(value === 0 ? { mode: "disabled" as const } : {}),
  };
}

export function resolveProviderRequestLimits(
  config: TeamConfig,
  role: Role,
): ResolvedProviderRequestLimits {
  const agent = config.agents[role];
  return {
    providerRequestDeadlineMs: resolved(
      agent.providerRequestDeadlineMs,
      config.workflow.providerRequestDeadlineMs,
      defaultProviderRequestDeadlineMs,
    ),
    reasoningStallTimeoutMs: resolved(
      agent.reasoningStallTimeoutMs,
      config.workflow.reasoningStallTimeoutMs,
      defaultReasoningStallTimeoutMs,
    ),
  };
}
