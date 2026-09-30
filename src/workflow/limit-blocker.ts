import type { TeamConfig } from "../config/schema.ts";
import { getFailureBudgetUsed } from "../config/solvers.ts";
import type { WorkflowState } from "./state.ts";

/** undefined means this is not a recognized limit blocker. */
export function isLimitBlockerStillActive(
  state: WorkflowState,
  config: TeamConfig,
): boolean | undefined {
  const blocker = state.blocker ?? "";
  if (blocker === "Local fix cycle limit reached")
    return state.localFixCycle >= config.workflow.maxLocalFixCycles;
  if (blocker === "Pentest cycle limit reached")
    return state.pentestCycle >= config.workflow.maxPentestCycles;
  if (blocker.startsWith("Research clarification limit reached"))
    return (
      config.workflow.maxResearchClarifications > 0 &&
      state.researchClarificationCount >=
        config.workflow.maxResearchClarifications
    );
  if (blocker === "Agent failure limit reached")
    return getFailureBudgetUsed(state) >= config.workflow.maxAgentFailures;
  return undefined;
}
