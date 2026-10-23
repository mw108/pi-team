import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { Command } from "../config/schema.ts";
import type { CommandEvidence } from "../agents/commands.ts";
import { commandKey } from "../agents/discovery.ts";
import { redactVisibleText } from "../agents/redaction.ts";
import { roles, type Role } from "../agents/schemas.ts";
import { gateSnapshot, head } from "./git.ts";
import type { WorkflowState } from "./state.ts";

export const staticValidatorTools = [
  "LARAVEL_PINT",
  "PHP_CS_FIXER",
  "PHPSTAN",
  "PSALM",
  "ESLINT",
  "PRETTIER",
  "TYPESCRIPT",
] as const;
export type StaticValidatorTool = (typeof staticValidatorTools)[number];
export const validatorIdentitySchema = z.object({
  tool: z.enum([...staticValidatorTools, "UNKNOWN", "COMPOSITE"]),
  source: z.enum(["direct", "interpreter", "package_script", "unknown"]),
  scriptName: z.string().optional(),
  underlyingTools: z.array(z.enum(staticValidatorTools)).optional(),
});
export type ValidatorIdentity = z.infer<typeof validatorIdentitySchema>;

export const verifiedCommandResultSchema = z.object({
  executionId: z.string().uuid(),
  command: z.object({
    id: z.string(),
    executable: z.string(),
    args: z.array(z.string()),
    purpose: z.string(),
  }),
  commandIdentity: z.string(),
  validatorIdentity: validatorIdentitySchema.optional(),
  agent: z.enum(roles),
  attempt: z.number().int().positive(),
  exitCode: z.number().int(),
  output: z.string(),
  stdoutTail: z.string().optional(),
  stderrTail: z.string().optional(),
  completedAt: z.string(),
  repoState: z.object({
    head: z.string().nullable(),
    gateHashes: z.record(z.string()),
    packageJsonHash: z.string().optional(),
    composerJsonHash: z.string().optional(),
  }),
});
export type VerifiedCommandResult = z.infer<typeof verifiedCommandResultSchema>;

export async function repositoryEvidenceState(state: WorkflowState) {
  const metadataHash = (name: string) =>
    readFile(join(state.cwd, name))
      .then((content) => createHash("sha256").update(content).digest("hex"))
      .catch(() => undefined);
  const [packageJsonHash, composerJsonHash] = await Promise.all([
    metadataHash("package.json"),
    metadataHash("composer.json"),
  ]);
  return {
    head: await head(state.cwd),
    gateHashes: await gateSnapshot(state),
    packageJsonHash,
    composerJsonHash,
  };
}

function executableName(value: string): string {
  return (
    value
      .replace(/\\/g, "/")
      .split("/")
      .at(-1)
      ?.toLowerCase()
      .replace(/\.(?:cmd|exe|bat)$/i, "") ?? ""
  );
}

function interpreterTarget(value: string): string {
  return value.replace(/\\/g, "/").toLowerCase();
}

function toolForExecutable(
  executable: string,
): StaticValidatorTool | undefined {
  switch (executableName(executable)) {
    case "pint":
      return "LARAVEL_PINT";
    case "php-cs-fixer":
      return "PHP_CS_FIXER";
    case "phpstan":
      return "PHPSTAN";
    case "psalm":
      return "PSALM";
    case "eslint":
      return "ESLINT";
    case "prettier":
      return "PRETTIER";
    case "tsc":
      return "TYPESCRIPT";
  }
}

/** Resolve only validators established by argv; output is never identity evidence. */
export function directStaticValidatorIdentity(
  command: Pick<Command, "executable" | "args">,
): ValidatorIdentity | undefined {
  const executable = executableName(command.executable);
  const args = command.args.map(interpreterTarget);
  const direct = toolForExecutable(executable);
  if (direct) return { tool: direct, source: "direct" };
  if (executable === "npx") {
    const tool = toolForExecutable(args[0] ?? "");
    if (tool) return { tool, source: "interpreter" };
  }
  if (executable === "php") {
    const target = args[0] ?? "";
    if (
      !/(?:^|\/)vendor\/bin\/(?:pint|php-cs-fixer|phpstan|psalm)$/.test(target)
    )
      return;
    const tool = toolForExecutable(target);
    if (tool) return { tool, source: "interpreter" };
  }
  if (executable === "node") {
    const target = args[0] ?? "";
    if (
      /(?:^|\/)node_modules\/typescript\/(?:bin\/tsc|lib\/tsc\.js)$/.test(
        target,
      )
    )
      return { tool: "TYPESCRIPT", source: "interpreter" };
  }
}

function packageScriptRequest(command: Pick<Command, "executable" | "args">) {
  const executable = executableName(command.executable);
  if (["npm", "pnpm", "yarn", "bun"].includes(executable)) {
    const name =
      command.args[0] === "run"
        ? command.args[1]
        : command.args[0] === "test"
          ? "test"
          : undefined;
    return name ? { file: "package.json", name } : undefined;
  }
  if (executable === "composer") {
    const name = command.args[0] === "run" ? command.args[1] : command.args[0];
    return name ? { file: "composer.json", name } : undefined;
  }
}

function scriptCommandIdentity(value: string): ValidatorIdentity | undefined {
  const text = value.trim().replace(/^@php\s+/, "php ");
  if (!text || /[`$<>\r\n'"\\]/.test(text)) return;
  const parts = text.split(/\s+/);
  const [executable, ...args] = parts;
  return directStaticValidatorIdentity({ executable, args });
}

function packageScriptIdentity(
  definition: unknown,
  scriptName: string,
): ValidatorIdentity {
  const commands =
    typeof definition === "string"
      ? definition.split(/(?:&&|\|\||[;|])/).map((part) => part.trim())
      : Array.isArray(definition) &&
          definition.every((item) => typeof item === "string")
        ? definition
        : [];
  if (!commands.length)
    return { tool: "UNKNOWN", source: "package_script", scriptName };
  const identities = commands
    .map(scriptCommandIdentity)
    .filter((identity): identity is ValidatorIdentity => Boolean(identity));
  const tools = [
    ...new Set(
      identities.flatMap((identity) =>
        identity.tool === "COMPOSITE"
          ? (identity.underlyingTools ?? [])
          : identity.tool === "UNKNOWN"
            ? []
            : [identity.tool],
      ),
    ),
  ];
  if (commands.length === 1 && identities.length === 0)
    return { tool: "UNKNOWN", source: "package_script", scriptName };
  if (commands.length !== 1 || identities.length !== 1)
    return {
      tool: "COMPOSITE",
      source: "package_script",
      scriptName,
      underlyingTools: tools,
    };
  return { tool: identities[0].tool, source: "package_script", scriptName };
}

export async function resolveStaticValidatorIdentity(
  command: Pick<Command, "executable" | "args" | "purpose">,
  cwd: string,
): Promise<ValidatorIdentity> {
  if (command.purpose !== "static")
    return { tool: "UNKNOWN", source: "unknown" };
  const direct = directStaticValidatorIdentity(command);
  if (direct) return direct;
  const request = packageScriptRequest(command);
  if (!request) return { tool: "UNKNOWN", source: "unknown" };
  try {
    const source = await readFile(join(cwd, request.file));
    if (source.byteLength > 262144)
      return {
        tool: "UNKNOWN",
        source: "package_script",
        scriptName: request.name,
      };
    const document = JSON.parse(source.toString("utf8"));
    return packageScriptIdentity(
      document?.scripts?.[request.name],
      request.name,
    );
  } catch {
    return {
      tool: "UNKNOWN",
      source: "package_script",
      scriptName: request.name,
    };
  }
}

export async function recordVerifiedCommandResult(
  state: WorkflowState,
  command: Command,
  evidence: CommandEvidence,
  agent: Role,
  attempt: number,
): Promise<VerifiedCommandResult | undefined> {
  if (
    evidence.timedOut ||
    evidence.aborted ||
    evidence.exitCode < 0 ||
    !Number.isInteger(evidence.exitCode)
  )
    return;
  const repoState = await repositoryEvidenceState(state);
  const validatorIdentity = await resolveStaticValidatorIdentity(
    command,
    state.cwd,
  );
  return {
    executionId: randomUUID(),
    command: {
      id: command.id,
      executable: command.executable,
      args: [...command.args],
      purpose: command.purpose,
    },
    commandIdentity: commandKey(command),
    ...(command.purpose === "static" ? { validatorIdentity } : {}),
    agent,
    attempt,
    exitCode: evidence.exitCode,
    output: redactVisibleText(evidence.output.slice(-4000)),
    stdoutTail: evidence.stdout
      ? redactVisibleText(evidence.stdout.slice(-4000))
      : undefined,
    stderrTail: evidence.stderr
      ? redactVisibleText(evidence.stderr.slice(-4000))
      : undefined,
    completedAt: evidence.completedAt ?? new Date().toISOString(),
    repoState,
  };
}

export function isVerifiedCommandResultCurrent(
  result: VerifiedCommandResult,
  current: Awaited<ReturnType<typeof repositoryEvidenceState>>,
): boolean {
  return (
    result.commandIdentity === commandKey(result.command) &&
    Number.isInteger(result.exitCode) &&
    result.repoState.head === current.head &&
    (result.repoState.packageJsonHash === undefined ||
      result.repoState.packageJsonHash === current.packageJsonHash) &&
    (result.repoState.composerJsonHash === undefined ||
      result.repoState.composerJsonHash === current.composerJsonHash) &&
    JSON.stringify(result.repoState.gateHashes) ===
      JSON.stringify(current.gateHashes)
  );
}

/** The latest complete execution wins for an exact argv identity. */
export function currentVerifiedCommandResults(
  state: WorkflowState,
  current: Awaited<ReturnType<typeof repositoryEvidenceState>>,
): VerifiedCommandResult[] {
  const latest = new Map<string, VerifiedCommandResult>();
  for (const result of state.verifiedCommandResults) {
    if (
      isVerifiedCommandResultCurrent(result, current) &&
      (!latest.has(result.commandIdentity) ||
        latest.get(result.commandIdentity)!.completedAt <= result.completedAt)
    )
      latest.set(result.commandIdentity, result);
  }
  return [...latest.values()];
}

export type CommandOutcomeCategory =
  | "PASS"
  | "TEST_FAILURE"
  | "STATIC_FORMAT_FAILURE"
  | "STATIC_ANALYSIS_FAILURE"
  | "INVOCATION_ERROR"
  | "INFRASTRUCTURE_ERROR"
  | "INDETERMINATE";

export type CommandValidationType = "TEST" | "STATIC";

export type ClassifiedCommandOutcome = {
  category: CommandOutcomeCategory;
  validationType: CommandValidationType;
  validatorIdentity: ValidatorIdentity;
  reason: string;
  recoverable: boolean;
};

function withoutAnsi(value: string): string {
  return value.replace(
    /\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/g,
    "",
  );
}

export function classifyVerifiedCommand(
  result: VerifiedCommandResult,
): ClassifiedCommandOutcome {
  const validationType: CommandValidationType =
    result.command.purpose === "static" ? "STATIC" : "TEST";
  const validatorIdentity: ValidatorIdentity =
    result.command.purpose === "static"
      ? (result.validatorIdentity ??
        directStaticValidatorIdentity(result.command) ?? {
          tool: "UNKNOWN",
          source: "unknown",
        })
      : { tool: "UNKNOWN", source: "unknown" };
  const outcome = (
    category: CommandOutcomeCategory,
    reason: string,
    recoverable: boolean,
  ): ClassifiedCommandOutcome => ({
    category,
    validationType,
    validatorIdentity,
    reason,
    recoverable,
  });
  if (result.exitCode === 0)
    return outcome("PASS", "Command completed successfully", false);
  const output = withoutAnsi(
    [result.output, result.stdoutTail, result.stderrTail].join("\n"),
  );
  if (
    /no tests found matching|unknown option:?|invalid cli argument|unknown argument:?|option .* does not exist/i.test(
      output,
    )
  )
    return outcome(
      "INVOCATION_ERROR",
      "Validator rejected the invocation before producing a result",
      false,
    );
  if (
    /command timed out|(?:test runner|validator) failed to initialize|connection refused|ECONNREFUSED|permission denied|killed by signal|segmentation fault/i.test(
      output,
    )
  )
    return outcome(
      "INFRASTRUCTURE_ERROR",
      "Validation environment or runner failed",
      false,
    );
  if (
    result.command.purpose === "test" &&
    /(?:\b\d+\s+(?:tests?|test files?)\s+failed\b|\btests?:\s*\d+\s+failed\b|AssertionError:)/i.test(
      output,
    )
  )
    return outcome(
      "TEST_FAILURE",
      "Test runner reported failing tests or assertions",
      true,
    );
  if (
    result.command.purpose === "test" &&
    result.command.args.includes("--test") &&
    /(?:^|\n)\s*(?:#|ℹ)\s*fail\s+[1-9]\d*\b/i.test(output)
  )
    return outcome(
      "TEST_FAILURE",
      "Node test runner reported failing tests",
      true,
    );
  if (result.command.purpose === "static") {
    const tool = validatorIdentity.tool;
    if (
      tool === "LARAVEL_PINT" &&
      /\bFAIL\b[^\n]*\b\d+\s+files?\b[^\n]*\b\d+\s+style issues?\b/i.test(
        output,
      )
    )
      return outcome(
        "STATIC_FORMAT_FAILURE",
        "Laravel Pint reported formatting violations",
        true,
      );
    if (
      tool === "PHP_CS_FIXER" &&
      /found\s+\d+\s+of\s+\d+\s+files?\s+that\s+can\s+be\s+fixed/i.test(output)
    )
      return outcome(
        "STATIC_FORMAT_FAILURE",
        "PHP-CS-Fixer reported formatting violations",
        true,
      );
    if (
      tool === "PRETTIER" &&
      /code style issues found in|forgot to run prettier|would reformat/i.test(
        output,
      )
    )
      return outcome(
        "STATIC_FORMAT_FAILURE",
        "Prettier reported formatting violations",
        true,
      );
    if (
      tool === "ESLINT" &&
      /(?:\u2716|x)\s+\d+\s+problems?\s*\(\s*[1-9]\d*\s+errors?/i.test(output)
    )
      return outcome(
        "STATIC_ANALYSIS_FAILURE",
        "ESLint reported source diagnostics",
        true,
      );
    if (tool === "TYPESCRIPT" && /\berror TS\d+:/i.test(output))
      return outcome(
        "STATIC_ANALYSIS_FAILURE",
        "TypeScript reported source diagnostics",
        true,
      );
    if (
      tool === "PHPSTAN" &&
      /(?:\[ERROR\]\s*Found\s+[1-9]\d*\s+errors?|Found\s+[1-9]\d*\s+errors?)/i.test(
        output,
      )
    )
      return outcome(
        "STATIC_ANALYSIS_FAILURE",
        "PHPStan reported source diagnostics",
        true,
      );
    if (
      tool === "PSALM" &&
      /(?:ERRORS!|[1-9]\d*\s+errors?\s+found|ERROR:\s+\w+)/i.test(output)
    )
      return outcome(
        "STATIC_ANALYSIS_FAILURE",
        "Psalm reported source diagnostics",
        true,
      );
  }
  return outcome(
    "INDETERMINATE",
    result.command.purpose === "static" &&
      ["UNKNOWN", "COMPOSITE"].includes(validatorIdentity.tool)
      ? `Static validator identity is ${validatorIdentity.tool.toLowerCase()}; nonzero exit cannot be attributed from output alone`
      : "Nonzero exit without a recognized validation outcome",
    false,
  );
}

export function validationFailureFingerprint(
  failures: {
    item: VerifiedCommandResult;
    outcome: ClassifiedCommandOutcome;
  }[],
): string | undefined {
  const recoverable = failures
    .filter(({ outcome }) => outcome.recoverable)
    .map(({ item, outcome }) => ({
      commandIdentity: item.commandIdentity,
      validatorIdentity: outcome.validatorIdentity,
      category: outcome.category,
      output: withoutAnsi(item.output).replace(/\r\n/g, "\n").trim(),
      repoState: item.repoState,
    }))
    .sort((a, b) => a.commandIdentity.localeCompare(b.commandIdentity));
  if (!recoverable.length) return;
  return createHash("sha256").update(JSON.stringify(recoverable)).digest("hex");
}

type TestScope = {
  runner: "angular" | "vitest";
  files: string[];
  full: boolean;
};

async function testScope(
  result: VerifiedCommandResult,
  cwd: string,
): Promise<TestScope | undefined> {
  const { executable, args } = result.command;
  let invocation = [executable, ...args];
  if (
    executable === "npm" &&
    (args[0] === "test" || (args[0] === "run" && args[1] === "test"))
  ) {
    if (args.some((arg) => arg === "--")) return;
    try {
      const pkg = JSON.parse(await readFile(join(cwd, "package.json"), "utf8"));
      const script = pkg.scripts?.test;
      if (typeof script !== "string" || /[;&|`$]/.test(script)) return;
      invocation = script.trim().split(/\s+/);
    } catch {
      return;
    }
  }
  const joined = invocation.join(" ");
  const runner = /(?:^|\s)(?:ng|npx ng) test(?:\s|$)/.test(joined)
    ? "angular"
    : /(?:^|\s)(?:vitest|npx vitest)(?:\s+(?:run|watch))?(?:\s|$)/.test(joined)
      ? "vitest"
      : undefined;
  if (!runner) return;
  const includes = invocation.flatMap((arg, index) =>
    arg.startsWith("--include=")
      ? arg.slice(10).split(",")
      : arg === "--include"
        ? (invocation[index + 1] ?? "").split(",")
        : [],
  );
  if (
    invocation.some((arg) =>
      /^(?:--exclude|--testNamePattern|--project|--grep|--filter)(?:=|$)/.test(
        arg,
      ),
    )
  )
    return;
  const files = includes.filter(Boolean);
  const full =
    !files.length &&
    !invocation.some((arg) => /\.(?:spec|test)\.[cm]?[jt]sx?$/.test(arg));
  return { runner, files, full };
}

/** Only a later, current full-suite execution of the same runner can cover an invalid include. */
export async function supersedingInvocation(
  failed: VerifiedCommandResult,
  candidates: VerifiedCommandResult[],
  cwd: string,
): Promise<VerifiedCommandResult | undefined> {
  if (classifyVerifiedCommand(failed).category !== "INVOCATION_ERROR") return;
  const scope = await testScope(failed, cwd);
  if (
    !scope?.files.length ||
    scope.files.some(
      (file) => !/^[\w./-]+\.(?:spec|test)\.[cm]?[jt]sx?$/.test(file),
    )
  )
    return;
  for (const candidate of candidates) {
    // npm's script is part of the verification scope; older records without
    // its hash cannot establish what the command ran.
    if (candidate.command.executable === "npm") {
      const packageJsonHash = await readFile(join(cwd, "package.json"))
        .then((content) => createHash("sha256").update(content).digest("hex"))
        .catch(() => undefined);
      if (
        !packageJsonHash ||
        candidate.repoState.packageJsonHash !== packageJsonHash
      )
        continue;
    }
    if (
      candidate.agent !== "tester" ||
      candidate.exitCode !== 0 ||
      candidate.completedAt < failed.completedAt ||
      candidate.repoState.head !== failed.repoState.head ||
      JSON.stringify(candidate.repoState.gateHashes) !==
        JSON.stringify(failed.repoState.gateHashes)
    )
      continue;
    const coverage = await testScope(candidate, cwd);
    if (
      coverage?.runner === scope.runner &&
      coverage.full &&
      /(?:\bTests?\s+\d+\s+passed\b|\bTest Files?\s+\d+\s+passed\b)/i.test(
        candidate.output,
      )
    )
      return candidate;
  }
}
