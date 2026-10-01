import { z } from "zod";
import { commandSchema, type Command } from "../config/schema.ts";
import type { Role } from "./schemas.ts";
import { detectedCommandId } from "./discovery.ts";

export const runtimeCommandRequestSchema = z
  .object({
    executable: z.string().min(1),
    args: z.array(z.string()),
    purpose: z.string().trim().min(1).max(500),
    category: z.enum(["development", "test", "static", "pentest"]).optional(),
  })
  .strict();
export type RuntimeCommandRequest = z.infer<typeof runtimeCommandRequestSchema>;

export const similarCommandRuleSchema = z
  .object({
    executable: z.string().min(1),
    argsPrefix: z.array(z.string()),
    allowRemainingArgs: z.literal(true),
    category: z.enum(["development", "test", "static", "pentest"]),
  })
  .strict()
  .superRefine((rule, ctx) => {
    const safe =
      rule.category === "test" &&
      ((rule.executable === "php" &&
        JSON.stringify(rule.argsPrefix) ===
          JSON.stringify(["artisan", "test"])) ||
        (rule.executable === "vendor/bin/phpunit" &&
          rule.argsPrefix.length === 0) ||
        (rule.executable === "composer" &&
          JSON.stringify(rule.argsPrefix) === JSON.stringify(["test"])));
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
  const allowed =
    role === "implementor"
      ? ["development", "test", "static"]
      : role === "tester"
        ? ["test", "static"]
        : role === "codeReviewer"
          ? ["static"]
          : role === "pentester"
            ? ["pentest"]
            : [];
  if (!allowed.includes(category))
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
): boolean {
  return (
    rule.executable === command.executable &&
    rule.category === command.purpose &&
    command.args.length >= rule.argsPrefix.length &&
    rule.argsPrefix.every((arg, i) => command.args[i] === arg)
  );
}

/** Only known test entry points may receive a prefix approval proposal. */
export function proposeSimilarRule(
  command: Command,
): SimilarCommandRule | undefined {
  const exe = command.executable;
  const args = command.args;
  const prefix =
    exe === "php" && args[0] === "artisan" && args[1] === "test"
      ? ["artisan", "test"]
      : exe === "vendor/bin/phpunit"
        ? []
        : exe === "composer" && args[0] === "test"
          ? ["test"]
          : undefined;
  if (!prefix || command.purpose !== "test") return;
  return {
    executable: exe,
    argsPrefix: prefix,
    allowRemainingArgs: true,
    category: "test",
  };
}
