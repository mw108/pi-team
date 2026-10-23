import type {
  ClassifiedCommandOutcome,
  VerifiedCommandResult,
} from "./verified-commands.ts";
import { record, type WorkflowState } from "./state.ts";

/** Record one audit event per execution without changing failure accounting. */
export function recordCommandPurposeMismatch(
  state: WorkflowState,
  result: VerifiedCommandResult,
  outcome: ClassifiedCommandOutcome,
): boolean {
  const mismatch = outcome.purposeMismatch;
  if (!mismatch) return false;
  if (
    state.history.some(
      (entry) =>
        entry.event === "command_purpose_mismatch" &&
        entry.meta?.executionId === result.executionId,
    )
  )
    return false;
  record(
    state,
    "command_purpose_mismatch",
    `Declared ${mismatch.declaredPurpose}; detected ${mismatch.detectedTool}; effective ${mismatch.effectiveValidationType}. Verified command identity takes precedence.`,
    {
      agent: result.agent,
      attempt: result.attempt,
      commandId: result.command.id,
      executionId: result.executionId,
      declaredPurpose: mismatch.declaredPurpose,
      effectiveValidationType: mismatch.effectiveValidationType,
      detectedTool: mismatch.detectedTool,
      validatorSource: mismatch.source,
      resolution: "verified_command_identity",
    },
  );
  return true;
}
