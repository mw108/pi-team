import type { WorkflowState } from "../workflow/state.ts";
import { commandSchema } from "../config/schema.ts";
import {
  allowedCommandCategories,
  staticCommandMatches,
} from "./command-policy.ts";
import { commandKey, detectedCommandId, effectiveConfig } from "./discovery.ts";
import type { VerifiedCommandResult } from "../workflow/verified-commands.ts";
import type { ValidationApplicability } from "../workflow/validation-applicability.ts";

export interface CandidateValidationCommand {
  executable: string;
  args: string[];
  purpose: string;
  source: string;
  intent?: string;
  platform?: "any" | "win32" | "posix";
  requiresShell?: boolean;
  interpreter?: string;
  equivalentOf?: string;
  applicability?: ValidationApplicability["status"];
  applicabilityReasonCode?: string;
  applicabilityExplanation?: string;
  applicabilityEvidence?: ValidationApplicability["evidence"];
  buildAssessment?: ValidationApplicability["buildAssessment"];
}

function validationHintPurpose(command: {
  executable: string;
  args: string[];
}): "test" | "static" {
  const script = command.args[0] === "run" ? (command.args[1] ?? "") : "";
  return (command.executable === "php" &&
    command.args[0] === "vendor/bin/pint" &&
    command.args.includes("--test")) ||
    (command.executable === "vendor/bin/pint" &&
      command.args.includes("--test")) ||
    /^(?:check|lint|typecheck|type-check|build|format:check)(?:[:_-].+)?$/.test(
      script,
    )
    ? "static"
    : "test";
}

/** Only plain, whitespace-delimited argv is accepted from free-text hints. */
export function parseValidationHint(value: string) {
  const text = value.trim();
  if (!text || text.length > 2048 || /[;&|`$<>\\\r\n'"\0]/.test(text)) return;
  const tokens = text.split(/\s+/);
  if (tokens.length > 64 || tokens.some((token) => !token)) return;
  const [executable, ...args] = tokens;
  const staticValidation =
    validationHintPurpose({ executable, args }) === "static";
  const knownValidation =
    (executable === "php" &&
      ((args[0] === "artisan" && args[1] === "test") ||
        args[0] === "vendor/bin/phpunit" ||
        (args[0] === "vendor/bin/pint" && args.includes("--test")))) ||
    executable === "vendor/bin/phpunit" ||
    (executable === "vendor/bin/pint" && args.includes("--test")) ||
    (["npm", "pnpm", "yarn", "bun", "composer"].includes(executable) &&
      (args[0] === "test" ||
        (args[0] === "run" &&
          /^(?:test|check|lint|typecheck|type-check|build|format:check)(?:[:_-].+)?$/.test(
            args[1] ?? "",
          )))) ||
    ["pytest", "pytest3"].includes(executable) ||
    (["python", "python3"].includes(executable) &&
      args[0] === "-m" &&
      args[1] === "pytest") ||
    (["cargo", "go", "dotnet", "mvn", "gradle", "./gradlew"].includes(
      executable,
    ) &&
      args[0] === "test");
  if (!knownValidation) return;
  const parsed = commandSchema.safeParse({
    id: detectedCommandId({ executable, args }),
    executable,
    args,
    purpose: staticValidation ? "static" : "test",
    timeoutMs: 120000,
  });
  return parsed.success ? { executable, args } : undefined;
}

export function testerValidationContext(
  state: WorkflowState,
  verified: VerifiedCommandResult[] = [],
  applicability: ValidationApplicability[] = [],
) {
  const candidates: CandidateValidationCommand[] = [];
  const seen = new Set<string>();
  const add = (
    command: { executable: string; args: string[] },
    purpose: string,
    source: string,
  ) => {
    const key = commandKey(command);
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push({ ...command, purpose, source });
  };
  const reviewer = state.results.reviewer as
    | {
        requiredTests?: { description: string }[];
        acceptanceCriteria?: string[];
      }
    | undefined;
  for (const test of reviewer?.requiredTests ?? []) {
    const command = parseValidationHint(test.description);
    if (command)
      add(
        command,
        validationHintPurpose(command) === "static"
          ? "Run required static validation"
          : "Run required test",
        "reviewer.requiredTests",
      );
  }
  for (const criterion of reviewer?.acceptanceCriteria ?? []) {
    const command = parseValidationHint(criterion);
    if (command)
      add(
        command,
        validationHintPurpose(command) === "static"
          ? "Run acceptance static validation"
          : "Check acceptance criterion",
        "reviewer.acceptanceCriteria",
      );
  }
  const approved = effectiveConfig(state, "tester").commands.filter((command) =>
    allowedCommandCategories("tester").includes(command.purpose),
  );
  for (const command of state.config.commands.filter((item) =>
    allowedCommandCategories("tester").includes(item.purpose),
  ))
    add(command, `Run ${command.purpose} check`, "workflow.commands");
  const implementor = state.results.implementor as
    { checks?: string[] } | undefined;
  for (const check of implementor?.checks ?? []) {
    const command = parseValidationHint(check);
    if (command) add(command, "Verify Implementor check", "implementor.checks");
  }
  for (const discovered of state.discoveredCommands) {
    if (
      !allowedCommandCategories("tester").includes(discovered.command.purpose)
    )
      continue;
    const before = candidates.length;
    add(
      discovered.command,
      discovered.command.purpose === "test"
        ? "Run discovered test"
        : "Run discovered static validation",
      discovered.source,
    );
    if (candidates.length !== before)
      Object.assign(candidates.at(-1)!, {
        intent: discovered.category,
        platform: discovered.execution?.platform ?? "any",
        requiresShell: discovered.execution?.requiresShell ?? false,
        interpreter: discovered.execution?.interpreter,
        equivalentOf: discovered.execution?.equivalentOf,
      });
  }
  for (const result of verified) {
    if (
      result.exitCode !== 0 ||
      result.agent === "tester" ||
      !["test", "static"].includes(result.command.purpose)
    )
      continue;
    add(
      result.command,
      "Re-run previously successful host-verified validation",
      `verified:${result.agent}:attempt-${result.attempt}`,
    );
  }
  // Approval authorizes execution but does not create a verification
  // obligation. Approved commands only belong to the current plan when an
  // independent source above (workflow configuration, Contract, discovery,
  // or current evidence) already selected the same argv.
  const plannedApprovals = approved.filter((command) =>
    seen.has(commandKey(command)),
  );
  for (const candidate of candidates) {
    const policy = applicability.find(
      (item) => commandKey(item.command) === commandKey(candidate),
    );
    if (policy)
      Object.assign(candidate, {
        applicability: policy.status,
        applicabilityReasonCode: policy.reasonCode,
        applicabilityExplanation: policy.explanation,
        applicabilityEvidence: policy.evidence,
        ...(policy.buildAssessment
          ? { buildAssessment: policy.buildAssessment }
          : {}),
      });
  }
  return {
    candidateValidationCommands: candidates,
    approvedCommandIds: plannedApprovals.map((command) => command.id),
    commandAuthorizationHints: state.config.permissions.commands.allow
      .filter((rule) =>
        candidates.some((candidate) => staticCommandMatches(rule, candidate)),
      )
      .map((rule) => ({ ...rule, source: "static" as const })),
  };
}
