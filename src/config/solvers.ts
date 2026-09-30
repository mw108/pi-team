import { solverIds, type SolverAgentId } from "../agents/schemas.ts";
import type { TeamConfig } from "./schema.ts";
import type { WorkflowState } from "../workflow/state.ts";

export function getActiveSolverIds(config: TeamConfig): SolverAgentId[] {
  return solverIds.slice(0, config.workflow.solverCount);
}

export function getRequiredSuccessfulSolverCount(solverCount: number): number {
  if (solverCount <= 2) return solverCount;
  return Math.ceil(solverCount / 2);
}

export function getFailureBudgetUsed(state: WorkflowState): number {
  const covered = state.history
    .filter((event) => event.event === "solver_quorum_satisfied")
    .reduce((total, event) => {
      try {
        const value = JSON.parse(event.detail);
        return (
          total +
          (Number.isInteger(value.coveredFailures) && value.coveredFailures > 0
            ? value.coveredFailures
            : 0)
        );
      } catch {
        return total;
      }
    }, 0);
  return Math.max(0, state.agentFailures - covered);
}

export function inactiveSolverError(
  config: TeamConfig,
  agentId: string,
): string | undefined {
  if (
    !solverIds.includes(agentId as SolverAgentId) ||
    getActiveSolverIds(config).includes(agentId as SolverAgentId)
  )
    return undefined;
  return config.agents[agentId as SolverAgentId]
    ? `${agentId} is configured but inactive because workflow.solverCount=${config.workflow.solverCount}.`
    : undefined;
}
