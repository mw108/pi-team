import type { WorkflowState } from "../workflow/state.ts";
import { commandSchema } from "../config/schema.ts";
import {
  allowedCommandCategories,
  staticCommandMatches,
} from "./command-policy.ts";
import { commandKey, detectedCommandId, effectiveConfig } from "./discovery.ts";

export interface CandidateValidationCommand {
  executable: string;
  args: string[];
  purpose: string;
  source: string;
}

/** Only plain, whitespace-delimited argv is accepted from free-text hints. */
export function parseValidationHint(value: string) {
  const text = value.trim();
  if (!text || text.length > 2048 || /[;&|`$<>\\\r\n'"\0]/.test(text)) return;
  const tokens = text.split(/\s+/);
  if (tokens.length > 64 || tokens.some((token) => !token)) return;
  const [executable, ...args] = tokens;
  const knownValidation =
    (executable === "php" &&
      ((args[0] === "artisan" && args[1] === "test") ||
        args[0] === "vendor/bin/phpunit")) ||
    executable === "vendor/bin/phpunit" ||
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
    purpose: "test",
    timeoutMs: 120000,
  });
  return parsed.success ? { executable, args } : undefined;
}

export function testerValidationContext(state: WorkflowState) {
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
    if (command) add(command, `Run required test`, "reviewer.requiredTests");
  }
  for (const criterion of reviewer?.acceptanceCriteria ?? []) {
    const command = parseValidationHint(criterion);
    if (command)
      add(command, "Check acceptance criterion", "reviewer.acceptanceCriteria");
  }
  const configured = effectiveConfig(state, "tester").commands.filter(
    (command) => allowedCommandCategories("tester").includes(command.purpose),
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
    if (discovered.category !== "test") continue;
    add(discovered.command, "Run discovered test", "discovered");
  }
  for (const command of configured)
    add(command, `Run ${command.purpose} check`, "approved.commands");
  return {
    candidateValidationCommands: candidates,
    approvedCommandIds: configured.map((command) => command.id),
    commandAuthorizationHints: state.config.permissions.commands.allow
      .filter((rule) =>
        candidates.some((candidate) => staticCommandMatches(rule, candidate)),
      )
      .map((rule) => ({ ...rule, source: "static" as const })),
  };
}
