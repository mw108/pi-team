import { z } from "zod";
import { commandSchema, type Command } from "../config/schema.ts";
import { roles, type Role } from "./schemas.ts";
import { detectedCommandId } from "./discovery.ts";
import {
  allowedCommandCategories,
  commandCategories,
} from "./command-policy.ts";

export const runtimeCommandRequestSchema = z
  .object({
    executable: z.string().min(1),
    args: z.array(z.string()),
    purpose: z.string().trim().min(1).max(500),
    category: z.enum(commandCategories).optional(),
  })
  .strict();
export type RuntimeCommandRequest = z.infer<typeof runtimeCommandRequestSchema>;

export const similarCommandRuleSchema = z
  .object({
    executable: z.string().min(1),
    argsPrefix: z.array(z.string()),
    category: z.literal("test"),
    role: z.enum(roles),
  })
  .strict()
  .superRefine((rule, ctx) => {
    const safe =
      rule.category === "test" &&
      ((rule.executable === "php" &&
        JSON.stringify(rule.argsPrefix) ===
          JSON.stringify(["artisan", "test"])) ||
        (rule.executable === "vendor/bin/phpunit" &&
          rule.argsPrefix.length === 0));
    if (!safe)
      ctx.addIssue({
        code: "custom",
        message:
          "Similarity rule is outside the conservative test-command allowlist",
      });
  });
export type SimilarCommandRule = z.infer<typeof similarCommandRuleSchema>;

export function normalizedRuntimeCommand(
  input: unknown,
  role: Role,
): {
  command: Command;
  request: RuntimeCommandRequest;
} {
  const request = runtimeCommandRequestSchema.parse(input);
  const obviousTest =
    (request.executable === "php" &&
      request.args[0] === "artisan" &&
      request.args[1] === "test") ||
    request.executable === "vendor/bin/phpunit" ||
    (request.executable === "composer" && request.args[0] === "test");
  const category =
    request.category ??
    (role === "tester"
      ? "test"
      : role === "pentester"
        ? "pentest"
        : role === "codeReviewer"
          ? "static"
          : obviousTest
            ? "test"
            : "development");
  if (!allowedCommandCategories(role).includes(category))
    throw new Error("Command category not permitted for this agent");
  const command = commandSchema.parse({
    id: detectedCommandId(request),
    executable: request.executable,
    args: request.args,
    purpose: category,
    timeoutMs: 120000,
  });
  return { command, request };
}

export function ruleMatches(
  rule: SimilarCommandRule,
  command: Command,
  role: Role = rule.role,
): boolean {
  return (
    rule.role === role &&
    rule.executable === command.executable &&
    rule.category === command.purpose &&
    command.args.length >= rule.argsPrefix.length &&
    rule.argsPrefix.every((arg, i) => command.args[i] === arg) &&
    safeTestArgs(command.args.slice(rule.argsPrefix.length))
  );
}

/** Parse every suffix token; unknown options and unsafe path operands fail closed. */
function safeTestArgs(args: string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--testdox") continue;
    if (arg === "--colors" || arg.startsWith("--colors=")) {
      const value = arg === "--colors" ? args[++i] : arg.slice(9);
      if (!["auto", "always", "never"].includes(value)) return false;
      continue;
    }
    const key = arg.split("=", 1)[0];
    if (key === "--filter" || key === "--testsuite") {
      const value = arg === key ? args[++i] : arg.slice(key.length + 1);
      if (!value || !/^[A-Za-z0-9_][A-Za-z0-9_.:\\-]{0,119}$/.test(value))
        return false;
      continue;
    }
    return false;
  }
  return true;
}

export function similarRuleDescription(rule: SimilarCommandRule): string {
  return `${[rule.executable, ...rule.argsPrefix].join(" ")}\nAllowed options: --filter <name>, --testsuite <name>, --colors <auto|always|never>, --testdox. File paths and other arguments require approval.`;
}

/** Only known test entry points may receive a constrained approval proposal. */
export function proposeSimilarRule(
  command: Command,
  role: Role,
): SimilarCommandRule | undefined {
  const exe = command.executable;
  const args = command.args;
  const prefix =
    exe === "php" && args[0] === "artisan" && args[1] === "test"
      ? ["artisan", "test"]
      : exe === "vendor/bin/phpunit"
        ? []
        : undefined;
  if (!prefix || command.purpose !== "test") return;
  const rule: SimilarCommandRule = {
    executable: exe,
    argsPrefix: prefix,
    category: "test",
    role,
  };
  return ruleMatches(rule, command, role) ? rule : undefined;
}
