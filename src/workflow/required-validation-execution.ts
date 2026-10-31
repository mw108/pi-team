import type { Command } from "../config/schema.ts";
import {
  commandTool,
  type CommandEvidence,
  type CommandResultObserver,
  type RuntimeCommandApprover,
} from "../agents/commands.ts";
import { allowedCommandCategories } from "../agents/command-policy.ts";
import { commandKey, effectiveConfig } from "../agents/discovery.ts";
import { formatCommandLine } from "../agents/command-observability.ts";
import { redactVisibleText } from "../agents/redaction.ts";
import type { WorkflowState } from "./state.ts";
import { statePersistenceError } from "./persistence.ts";
import {
  requiredValidationCommands,
  validationApplicability,
  type ValidationApplicability,
} from "./validation-applicability.ts";
import {
  currentVerifiedCommandResults,
  repositoryEvidenceState,
  resolveValidationObligationMatches,
  type ValidationObligationMatch,
  type VerifiedCommandResult,
} from "./verified-commands.ts";

export type RequiredValidationExecutionBlock = {
  command: Command;
  obligationId: string;
  code: string;
  reason: string;
  action: string;
};

export type RequiredValidationExecutionStage = {
  applicability: ValidationApplicability[];
  required: Command[];
  current: VerifiedCommandResult[];
  matches: ValidationObligationMatch[];
  executed: string[];
  blocked?: RequiredValidationExecutionBlock;
};

export type RequiredValidationExecutionOptions = {
  state: WorkflowState;
  attempt: number;
  signal?: AbortSignal;
  runtimeApproval?: RuntimeCommandApprover;
  onResult: CommandResultObserver;
  onDenial?: (status: "denied" | "pending") => void;
  activity?: (toolName: string | undefined) => void;
};

function testerEvidence(current: VerifiedCommandResult[]) {
  return current.filter(
    (item) =>
      item.agent === "tester" &&
      allowedCommandCategories("tester").includes(
        item.command.purpose as "test" | "static",
      ),
  );
}

function executionBlockMessage(block: RequiredValidationExecutionBlock) {
  return [
    "TEST blocked: Required validation could not execute.",
    "",
    "Command:",
    formatCommandLine(block.command),
    "",
    "Reason:",
    block.reason,
    "",
    "Required obligation:",
    block.obligationId,
    "",
    "Action:",
    block.action,
  ].join("\n");
}

export function requiredValidationBlockReason(
  block: RequiredValidationExecutionBlock,
) {
  return executionBlockMessage(block);
}

function resultDetails(result: unknown): Record<string, unknown> {
  if (!result || typeof result !== "object" || !("details" in result))
    return {};
  const details = (result as { details?: unknown }).details;
  return details && typeof details === "object"
    ? (details as Record<string, unknown>)
    : {};
}

function blockedExecution(
  command: Command,
  details: Record<string, unknown>,
): RequiredValidationExecutionBlock | undefined {
  const code = typeof details.code === "string" ? details.code : undefined;
  if (typeof details.exitCode === "number") {
    if (details.timedOut)
      return {
        command,
        obligationId: command.id,
        code: "COMMAND_TIMEOUT",
        reason: "The required validation command timed out.",
        action:
          "Inspect the validator or timeout configuration, then retry Tester.",
      };
    if (details.aborted)
      return {
        command,
        obligationId: command.id,
        code: "COMMAND_ABORTED",
        reason: "The required validation command was interrupted.",
        action: "Retry Tester after the interruption has been resolved.",
      };
    return undefined;
  }
  if (!code) return;
  const message =
    typeof details.message === "string"
      ? redactVisibleText(details.message)
      : "The command did not produce verified execution evidence.";
  const approval = /APPROVAL_PENDING$/.test(code);
  const denied = /_DENIED$/.test(code);
  const missing = code === "EXECUTABLE_NOT_FOUND";
  return {
    command,
    obligationId: command.id,
    code,
    reason: message,
    action: approval
      ? "Review the pending exact-command authorization, then retry Tester."
      : denied
        ? "Authorize the exact command if appropriate, then retry Tester."
        : missing
          ? "Restore the required executable or configure an authorized evidence-backed alternative, then retry Tester."
          : "Resolve the execution restriction, then retry Tester.",
  };
}

/**
 * Resolve and execute mandatory TEST obligations before the Tester model runs.
 *
 * Existing policy intentionally limits cross-attempt reuse to current evidence
 * produced by the Tester. Implementor executions remain audit/context evidence;
 * they are not silently upgraded into TEST quality-gate results.
 */
export async function executeRequiredValidationStage(
  options: RequiredValidationExecutionOptions,
): Promise<RequiredValidationExecutionStage> {
  const {
    state,
    attempt,
    signal,
    runtimeApproval,
    onResult,
    onDenial,
    activity,
  } = options;
  const applicability = await validationApplicability(state);
  const required = requiredValidationCommands(applicability);
  const before = currentVerifiedCommandResults(
    state,
    await repositoryEvidenceState(state),
  );
  const priorMatches = await resolveValidationObligationMatches(
    required,
    testerEvidence(before),
    state.cwd,
  );
  const resolved = new Set(
    priorMatches.map((match) => match.requiredCommandId),
  );
  const pending = required.filter((command) => !resolved.has(command.id));
  const evidence: CommandEvidence[] = [];
  const executed: string[] = [];
  const config = effectiveConfig(state, "tester");
  const tool = commandTool(
    "tester",
    config,
    state.cwd,
    evidence,
    runtimeApproval,
    () => effectiveConfig(state, "tester").commands,
    onResult,
    onDenial,
  );

  for (const command of pending) {
    if (signal?.aborted) throw new Error("Workflow interrupted");
    const policy = applicability.find(
      (candidate) => commandKey(candidate.command) === commandKey(command),
    );
    activity?.(`validation_${command.purpose}`);
    try {
      const result = await tool.execute(
        `host-required-validation-${attempt}-${command.id}`,
        {
          executable: command.executable,
          args: [...command.args],
          category: command.purpose,
          purpose: `Required validation ${command.id}: ${policy?.explanation ?? "mandatory TEST quality gate"}`,
        },
        signal,
        undefined,
        {} as never,
      );
      if (signal?.aborted) throw new Error("Workflow interrupted");
      const details = resultDetails(result);
      const blocked = blockedExecution(command, details);
      if (blocked) {
        const current = currentVerifiedCommandResults(
          state,
          await repositoryEvidenceState(state),
        );
        return {
          applicability,
          required,
          current,
          matches: await resolveValidationObligationMatches(
            required,
            testerEvidence(current),
            state.cwd,
          ),
          executed,
          blocked,
        };
      }
      if (typeof details.exitCode !== "number")
        return {
          applicability,
          required,
          current: before,
          matches: priorMatches,
          executed,
          blocked: {
            command,
            obligationId: command.id,
            code: "VERIFICATION_BLOCKED",
            reason:
              "The host command runner returned no complete execution evidence.",
            action: "Inspect the execution diagnostics, then retry Tester.",
          },
        };
      executed.push(command.id);
    } catch (error) {
      if (signal?.aborted) throw new Error("Workflow interrupted");
      const persistenceFailure = statePersistenceError(error);
      if (persistenceFailure) throw persistenceFailure;
      return {
        applicability,
        required,
        current: before,
        matches: priorMatches,
        executed,
        blocked: {
          command,
          obligationId: command.id,
          code: "HOST_EXECUTION_ERROR",
          reason: redactVisibleText(
            error instanceof Error ? error.message : String(error),
          ),
          action:
            "Resolve the sandbox, executable, or command-runner error, then retry Tester.",
        },
      };
    } finally {
      activity?.(undefined);
    }
  }

  const current = currentVerifiedCommandResults(
    state,
    await repositoryEvidenceState(state),
  );
  const matches = await resolveValidationObligationMatches(
    required,
    testerEvidence(current),
    state.cwd,
  );
  const matched = new Set(matches.map((match) => match.requiredCommandId));
  const invalidated = required.find((command) => !matched.has(command.id));
  if (invalidated)
    return {
      applicability,
      required,
      current,
      matches,
      executed,
      blocked: {
        command: invalidated,
        obligationId: invalidated.id,
        code: "REPOSITORY_CHANGED_DURING_VALIDATION",
        reason:
          "Repository or validation configuration changed while required validations were executing, so the host cannot prove that all evidence describes one current state.",
        action:
          "Inspect the recorded command mutation and repository drift, restore a stable reviewed state, then retry Tester.",
      },
    };
  return {
    applicability,
    required,
    current,
    matches,
    executed,
  };
}
