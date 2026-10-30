import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
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
  "PHP_LINT",
] as const;
export type StaticValidatorTool = (typeof staticValidatorTools)[number];
export const buildValidatorTools = [
  "VITE",
  "WEBPACK",
  "NEXT",
  "ANGULAR",
] as const;
export type BuildValidatorTool = (typeof buildValidatorTools)[number];
export const validationTools = [
  ...staticValidatorTools,
  ...buildValidatorTools,
  "PHPUNIT",
  "PHP_DIAGNOSTIC",
] as const;
export type ValidationTool = (typeof validationTools)[number];
export const validatorIdentitySchema = z.object({
  tool: z.enum([...validationTools, "UNKNOWN", "COMPOSITE"]),
  source: z.enum(["direct", "interpreter", "package_script", "unknown"]),
  scriptName: z.string().optional(),
  underlyingTools: z.array(z.enum(validationTools)).optional(),
});
export type ValidatorIdentity = z.infer<typeof validatorIdentitySchema>;

export const effectiveValidationIdentitySchema = z
  .object({
    validationType: z.enum(["TEST", "STATIC", "BUILD", "DIAGNOSTIC"]),
    tool: z.enum([...validationTools, "COMPOSITE"]),
    source: z.enum(["direct", "interpreter", "package_script"]),
    scriptName: z.string().optional(),
    underlyingTools: z.array(z.enum(validationTools)).optional(),
  })
  .superRefine((identity, ctx) => {
    if (
      (identity.validationType === "STATIC" &&
        ![...staticValidatorTools, "COMPOSITE"].includes(
          identity.tool as any,
        )) ||
      (identity.validationType === "BUILD" &&
        ![...buildValidatorTools, "TYPESCRIPT", "COMPOSITE"].includes(
          identity.tool as any,
        )) ||
      (identity.validationType === "TEST" &&
        !["PHPUNIT", "COMPOSITE"].includes(identity.tool)) ||
      (identity.validationType === "DIAGNOSTIC" &&
        !["PHP_DIAGNOSTIC", "COMPOSITE"].includes(identity.tool))
    )
      ctx.addIssue({
        code: "custom",
        message: "Detected tool contradicts its effective validation type",
      });
    if (
      identity.underlyingTools?.some((tool) =>
        identity.validationType === "STATIC"
          ? !staticValidatorTools.includes(tool as StaticValidatorTool)
          : identity.validationType === "BUILD"
            ? ![...buildValidatorTools, "TYPESCRIPT"].includes(tool as any)
            : identity.validationType === "TEST"
              ? tool !== "PHPUNIT"
              : tool !== "PHP_DIAGNOSTIC",
      )
    )
      ctx.addIssue({
        code: "custom",
        message: "Composite tools contradict the effective validation type",
      });
  });
export type EffectiveValidationIdentity = z.infer<
  typeof effectiveValidationIdentitySchema
>;

export const verifiedCommandResultSchema = z.object({
  executionId: z.string().uuid(),
  command: z.object({
    id: z.string(),
    executable: z.string(),
    args: z.array(z.string()),
    purpose: z.string(),
    verificationId: z.string().optional(),
  }),
  commandIdentity: z.string(),
  validatorIdentity: validatorIdentitySchema.optional(),
  effectiveValidationIdentity: effectiveValidationIdentitySchema.optional(),
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
    validationConfigHashes: z.record(z.string()).optional(),
    projectPathHash: z.string().optional(),
  }),
  execution: z
    .object({
      processStarted: z.boolean().optional(),
      platform: z.string().optional(),
      requestedExecutable: z.string().optional(),
      resolvedExecutable: z.string().optional(),
    })
    .optional(),
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
  const validationPaths = new Set([
    "phpunit.xml",
    "phpunit.xml.dist",
    ".env.testing",
    "composer.lock",
  ]);
  for (const configName of ["phpunit.xml", "phpunit.xml.dist"]) {
    const source = await readFile(join(state.cwd, configName), "utf8").catch(
      () => undefined,
    );
    const bootstrap = source?.match(/\bbootstrap\s*=\s*["']([^"']+)["']/i)?.[1];
    if (!bootstrap) continue;
    const absolute = resolve(state.cwd, bootstrap);
    const repositoryRelative = relative(state.cwd, absolute).replace(
      /\\/g,
      "/",
    );
    if (
      repositoryRelative &&
      repositoryRelative !== ".." &&
      !repositoryRelative.startsWith("../")
    )
      validationPaths.add(repositoryRelative);
  }
  const validationConfigHashes: Record<string, string> = {};
  for (const name of [...validationPaths].sort()) {
    const hash = await metadataHash(name);
    if (hash) validationConfigHashes[name] = hash;
  }
  return {
    head: await head(state.cwd),
    gateHashes: await gateSnapshot(state),
    packageJsonHash,
    composerJsonHash,
    validationConfigHashes,
    projectPathHash: createHash("sha256")
      .update(
        process.platform === "win32"
          ? resolve(state.cwd).toLowerCase()
          : resolve(state.cwd),
      )
      .digest("hex"),
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
  if (executable === "php" && args[0] === "-l")
    return { tool: "PHP_LINT", source: "interpreter" };
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

export function directBuildValidatorIdentity(
  command: Pick<Command, "executable" | "args">,
  preferTypescriptBuild = false,
): EffectiveValidationIdentity | undefined {
  const executable = executableName(command.executable);
  const args = command.args.map(interpreterTarget);
  const invocation =
    executable === "npx" && args.length
      ? { executable: executableName(args[0]), args: args.slice(1) }
      : { executable, args };
  const tool: BuildValidatorTool | "TYPESCRIPT" | undefined =
    invocation.executable === "vite" && invocation.args[0] === "build"
      ? "VITE"
      : invocation.executable === "webpack"
        ? "WEBPACK"
        : invocation.executable === "next" && invocation.args[0] === "build"
          ? "NEXT"
          : ["ng", "angular"].includes(invocation.executable) &&
              invocation.args[0] === "build"
            ? "ANGULAR"
            : invocation.executable === "tsc" &&
                (preferTypescriptBuild ||
                  invocation.args.some((arg) =>
                    ["-b", "--build"].includes(arg),
                  ))
              ? "TYPESCRIPT"
              : undefined;
  return tool
    ? {
        validationType: "BUILD",
        tool,
        source: executable === invocation.executable ? "direct" : "interpreter",
      }
    : undefined;
}

export function directDiagnosticIdentity(
  command: Pick<Command, "executable" | "args">,
): EffectiveValidationIdentity | undefined {
  const executable = executableName(command.executable);
  const args = command.args.map(interpreterTarget);
  const phpDiagnostic =
    executable === "php" &&
    (args[0] === "-r" ||
      (/(?:^|\/)artisan$/.test(args[0] ?? "") &&
        (args[1] === "tinker" ||
          args[1] === "config:show" ||
          args[1] === "migrate:status")));
  if (phpDiagnostic)
    return {
      validationType: "DIAGNOSTIC",
      tool: "PHP_DIAGNOSTIC",
      source: "interpreter",
    };
}

export function directTestRunnerIdentity(
  command: Pick<Command, "executable" | "args">,
): EffectiveValidationIdentity | undefined {
  const executable = executableName(command.executable);
  const args = command.args.map(interpreterTarget);
  if (executable === "phpunit")
    return { validationType: "TEST", tool: "PHPUNIT", source: "direct" };
  if (executable === "php") {
    const target = args[0] ?? "";
    if (/(?:^|\/)vendor\/bin\/phpunit$/.test(target))
      return {
        validationType: "TEST",
        tool: "PHPUNIT",
        source: "interpreter",
      };
    if (/(?:^|\/)artisan$/.test(target) && args[1] === "test")
      return {
        validationType: "TEST",
        tool: "PHPUNIT",
        source: "interpreter",
      };
  }
  if (executable === "artisan" && args[0] === "test")
    return { validationType: "TEST", tool: "PHPUNIT", source: "direct" };
}

function directEffectiveValidationIdentity(
  command: Pick<Command, "executable" | "args">,
): EffectiveValidationIdentity | undefined {
  const build = directBuildValidatorIdentity(command);
  if (build) return build;
  const validator = directStaticValidatorIdentity(command);
  if (
    validator &&
    validator.tool !== "UNKNOWN" &&
    validator.tool !== "COMPOSITE"
  )
    return {
      validationType: "STATIC",
      tool: validator.tool,
      source: validator.source as "direct" | "interpreter",
    };
  return directTestRunnerIdentity(command) ?? directDiagnosticIdentity(command);
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

function scriptEffectiveValidationIdentity(
  value: string,
  scriptName: string,
): EffectiveValidationIdentity | undefined {
  const text = value.trim().replace(/^@php\s+/, "php ");
  if (!text || /[`$<>\r\n'"\\]/.test(text)) return;
  const [executable, ...args] = text.split(/\s+/);
  const build = directBuildValidatorIdentity(
    { executable, args },
    /^(?:build|compile)(?:[:_-]|$)/.test(scriptName),
  );
  if (build) return build;
  return directEffectiveValidationIdentity({ executable, args });
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

function packageScriptEffectiveValidationIdentity(
  definition: unknown,
  scriptName: string,
): EffectiveValidationIdentity | undefined {
  const commands =
    typeof definition === "string"
      ? definition.split(/(?:&&|\|\||[;|])/).map((part) => part.trim())
      : Array.isArray(definition) &&
          definition.every((item) => typeof item === "string")
        ? definition
        : [];
  if (!commands.length) return;
  const identities = commands.map((command) =>
    scriptEffectiveValidationIdentity(command, scriptName),
  );
  if (identities.some((identity) => !identity)) return;
  const recognized = identities as EffectiveValidationIdentity[];
  const validationTypes = [
    ...new Set(recognized.map((identity) => identity.validationType)),
  ];
  if (validationTypes.length !== 1) return;
  if (recognized.length === 1)
    return {
      validationType: recognized[0].validationType,
      tool: recognized[0].tool,
      source: "package_script",
      scriptName,
    };
  return {
    validationType: validationTypes[0],
    tool: "COMPOSITE",
    source: "package_script",
    scriptName,
    underlyingTools: [
      ...new Set(
        recognized.flatMap((identity) =>
          identity.tool === "COMPOSITE"
            ? (identity.underlyingTools ?? [])
            : [identity.tool],
        ),
      ),
    ],
  };
}

export async function resolveEffectiveValidationIdentity(
  command: Pick<Command, "executable" | "args" | "purpose">,
  cwd: string,
): Promise<EffectiveValidationIdentity | undefined> {
  const direct = directEffectiveValidationIdentity(command);
  if (direct) return direct;
  const request = packageScriptRequest(command);
  if (!request) return;
  try {
    const source = await readFile(join(cwd, request.file));
    if (source.byteLength > 262144) return;
    const document = JSON.parse(source.toString("utf8"));
    return packageScriptEffectiveValidationIdentity(
      document?.scripts?.[request.name],
      request.name,
    );
  } catch {
    return;
  }
}

export async function resolveStaticValidatorIdentity(
  command: Pick<Command, "executable" | "args" | "purpose">,
  cwd: string,
): Promise<ValidatorIdentity> {
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
  const effectiveValidationIdentity = await resolveEffectiveValidationIdentity(
    command,
    state.cwd,
  );
  const validatorIdentity: ValidatorIdentity | undefined =
    effectiveValidationIdentity
      ? {
          tool: effectiveValidationIdentity.tool,
          source: effectiveValidationIdentity.source,
          ...(effectiveValidationIdentity.scriptName
            ? { scriptName: effectiveValidationIdentity.scriptName }
            : {}),
          ...(effectiveValidationIdentity.underlyingTools
            ? { underlyingTools: effectiveValidationIdentity.underlyingTools }
            : {}),
        }
      : undefined;
  return {
    executionId: evidence.executionId ?? randomUUID(),
    command: {
      id: command.id,
      executable: command.executable,
      args: [...command.args],
      purpose: command.purpose,
      ...(command.verificationId
        ? { verificationId: command.verificationId }
        : {}),
    },
    commandIdentity: commandKey(command),
    ...(validatorIdentity ? { validatorIdentity } : {}),
    ...(effectiveValidationIdentity ? { effectiveValidationIdentity } : {}),
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
    execution: {
      processStarted: evidence.processStarted,
      platform: evidence.platform,
      requestedExecutable: evidence.requestedExecutable,
      resolvedExecutable: evidence.resolvedExecutable,
    },
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
    (result.repoState.validationConfigHashes === undefined ||
      JSON.stringify(result.repoState.validationConfigHashes) ===
        JSON.stringify(current.validationConfigHashes)) &&
    (result.repoState.projectPathHash === undefined ||
      result.repoState.projectPathHash === current.projectPathHash) &&
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

export type ValidationObligationMatch = {
  requiredCommandId: string;
  executedCommandId: string;
  executionId: string;
  matchType: "EXACT" | "VERIFIED_EQUIVALENT";
  reasonCode:
    | "EXACT_COMMAND_IDENTITY"
    | "PHPUNIT_OUTPUT_ONLY_ARGUMENT_DIFFERENCE"
    | "PHPUNIT_VERIFIED_WRAPPER_EQUIVALENCE";
  evidence: string[];
};

type PhpunitObligation = {
  runner: "PROJECT_PHPUNIT" | "PATH_PHPUNIT";
  wrapper: "DIRECT" | "LARAVEL_ARTISAN" | "COMPOSER_SCRIPT";
  presentation: string[];
  evidence: string[];
};

function normalizedTarget(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
}

/**
 * Parse only PHPUnit options verified to alter console presentation. Any
 * unknown, selection, configuration, bootstrap, coverage, or exit-semantics
 * argument makes the invocation ineligible for equivalence.
 */
function phpunitPresentationOptions(args: string[]): string[] | undefined {
  const options: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    let normalized: string | undefined;
    if (argument === "--no-progress") normalized = "--no-progress";
    else if (/^--colors=(?:never|auto)$/.test(argument)) normalized = argument;
    else if (
      argument === "--colors" &&
      /^(?:never|auto)$/.test(args[index + 1] ?? "")
    )
      normalized = `--colors=${args[++index]}`;
    else return;
    if (seen.has(normalized)) return;
    seen.add(normalized);
    options.push(normalized);
  }
  return options.sort();
}

function directPhpunitObligation(
  command: Pick<Command, "executable" | "args">,
): PhpunitObligation | undefined {
  const executable = executableName(command.executable);
  const target = normalizedTarget(command.executable);
  let runner: PhpunitObligation["runner"] | undefined;
  let args: string[] | undefined;
  if (
    executable === "php" &&
    /(?:^|\/)vendor\/bin\/phpunit$/.test(
      normalizedTarget(command.args[0] ?? ""),
    )
  ) {
    runner = "PROJECT_PHPUNIT";
    args = command.args.slice(1);
  } else if (/(?:^|\/)vendor\/bin\/phpunit$/.test(target)) {
    runner = "PROJECT_PHPUNIT";
    args = command.args;
  } else if (executable === "phpunit") {
    runner = "PATH_PHPUNIT";
    args = command.args;
  }
  if (!runner || !args) return;
  const presentation = phpunitPresentationOptions(args);
  if (!presentation) return;
  return {
    runner,
    wrapper: "DIRECT",
    presentation,
    evidence: [
      runner === "PROJECT_PHPUNIT"
        ? "The command invokes the repository PHPUnit runner."
        : "The command invokes the same PATH-resolved PHPUnit runner.",
    ],
  };
}

async function verifiedLaravelProject(cwd: string): Promise<boolean> {
  try {
    const [composer, artisan] = await Promise.all([
      readFile(join(cwd, "composer.json"), "utf8"),
      readFile(join(cwd, "artisan")),
    ]);
    if (artisan.byteLength > 262144) return false;
    const document = JSON.parse(composer);
    return Boolean(
      document?.require?.["laravel/framework"] ??
      document?.["require-dev"]?.["laravel/framework"],
    );
  } catch {
    return false;
  }
}

async function artisanPhpunitObligation(
  command: Pick<Command, "executable" | "args">,
  cwd: string,
): Promise<PhpunitObligation | undefined> {
  const executable = executableName(command.executable);
  const executableTarget = normalizedTarget(command.executable);
  const phpArtisan =
    executable === "php" &&
    /(?:^|\/)artisan$/.test(normalizedTarget(command.args[0] ?? "")) &&
    command.args[1] === "test";
  const directArtisan =
    /(?:^|\/)artisan$/.test(executableTarget) && command.args[0] === "test";
  if (!phpArtisan && !directArtisan) return;
  // Wrapper arguments are not silently translated into PHPUnit arguments.
  // This proves only the wrapper's unmodified default full-suite behavior.
  if (command.args.slice(phpArtisan ? 2 : 1).length) return;
  if (!(await verifiedLaravelProject(cwd))) return;
  return {
    runner: "PROJECT_PHPUNIT",
    wrapper: "LARAVEL_ARTISAN",
    presentation: [],
    evidence: [
      "The checked-in Laravel Artisan test wrapper resolves to the project PHPUnit runner.",
      "The wrapper has no scope, configuration, environment, or failure-handling arguments.",
    ],
  };
}

function singleComposerScriptCommand(
  definition: unknown,
): { executable: string; args: string[] } | undefined {
  const value = Array.isArray(definition)
    ? definition.length === 1 && typeof definition[0] === "string"
      ? definition[0]
      : undefined
    : typeof definition === "string"
      ? definition
      : undefined;
  if (!value) return;
  const text = value.trim().replace(/^@php\s+/, "php ");
  if (!text || /[;&|`$<>\r\n'"\\]/.test(text)) return;
  const [executable, ...args] = text.split(/\s+/);
  return executable ? { executable, args } : undefined;
}

async function composerPhpunitObligation(
  command: Pick<Command, "executable" | "args">,
  cwd: string,
): Promise<PhpunitObligation | undefined> {
  if (executableName(command.executable) !== "composer") return;
  const scriptName =
    command.args[0] === "run" ? command.args[1] : command.args[0];
  const expectedLength = command.args[0] === "run" ? 2 : 1;
  if (!scriptName || command.args.length !== expectedLength) return;
  try {
    const source = await readFile(join(cwd, "composer.json"));
    if (source.byteLength > 262144) return;
    const document = JSON.parse(source.toString("utf8"));
    const inner = singleComposerScriptCommand(document?.scripts?.[scriptName]);
    if (!inner) return;
    const obligation =
      directPhpunitObligation(inner) ??
      (await artisanPhpunitObligation(inner, cwd));
    if (!obligation) return;
    return {
      ...obligation,
      wrapper: "COMPOSER_SCRIPT",
      evidence: [
        `The checked-in Composer script ${scriptName} contains one deterministic test command.`,
        ...obligation.evidence,
      ],
    };
  } catch {
    return;
  }
}

async function phpunitObligation(
  command: Pick<Command, "executable" | "args">,
  cwd: string,
): Promise<PhpunitObligation | undefined> {
  return (
    directPhpunitObligation(command) ??
    (await artisanPhpunitObligation(command, cwd)) ??
    (await composerPhpunitObligation(command, cwd))
  );
}

function identityIsPhpunit(
  identity: EffectiveValidationIdentity | undefined,
): boolean {
  return identity?.validationType === "TEST" && identity.tool === "PHPUNIT";
}

/** Match exact argv first, then a narrowly proven PHPUnit obligation. */
export async function matchValidationObligation(
  required: Pick<Command, "id" | "executable" | "args" | "purpose">,
  executed: VerifiedCommandResult,
  cwd: string,
): Promise<ValidationObligationMatch | undefined> {
  if (executed.commandIdentity !== commandKey(executed.command)) return;
  if (!["test", "static"].includes(executed.command.purpose)) return;
  if (commandKey(required) === executed.commandIdentity)
    return {
      requiredCommandId: required.id,
      executedCommandId: executed.command.id,
      executionId: executed.executionId,
      matchType: "EXACT",
      reasonCode: "EXACT_COMMAND_IDENTITY",
      evidence: ["Executable and argument identity match exactly."],
    };

  const [requiredIdentity, executedIdentity, requiredScope, executedScope] =
    await Promise.all([
      resolveEffectiveValidationIdentity(required, cwd),
      resolveEffectiveValidationIdentity(
        {
          ...executed.command,
          purpose: executed.command.purpose as Command["purpose"],
        },
        cwd,
      ),
      phpunitObligation(required, cwd),
      phpunitObligation(executed.command, cwd),
    ]);
  if (
    !identityIsPhpunit(requiredIdentity) ||
    !identityIsPhpunit(executedIdentity) ||
    !requiredScope ||
    !executedScope ||
    requiredScope.runner !== executedScope.runner
  )
    return;
  if (
    executed.effectiveValidationIdentity &&
    !identityIsPhpunit(executed.effectiveValidationIdentity)
  )
    return;

  const wrapperDifference = requiredScope.wrapper !== executedScope.wrapper;
  return {
    requiredCommandId: required.id,
    executedCommandId: executed.command.id,
    executionId: executed.executionId,
    matchType: "VERIFIED_EQUIVALENT",
    reasonCode: wrapperDifference
      ? "PHPUNIT_VERIFIED_WRAPPER_EQUIVALENCE"
      : "PHPUNIT_OUTPUT_ONLY_ARGUMENT_DIFFERENCE",
    evidence: [
      ...requiredScope.evidence.map((item) => `Required: ${item}`),
      ...executedScope.evidence.map((item) => `Executed: ${item}`),
      wrapperDifference
        ? "Both verified invocations select the same default full PHPUnit suite."
        : "Only allowlisted PHPUnit console presentation options differ.",
    ],
  };
}

/**
 * Resolve one current execution per obligation. The latest equivalent evidence
 * wins, while one execution cannot collapse two independently required gates.
 */
export async function resolveValidationObligationMatches(
  required: Pick<Command, "id" | "executable" | "args" | "purpose">[],
  candidates: VerifiedCommandResult[],
  cwd: string,
): Promise<ValidationObligationMatch[]> {
  const available = new Set(
    candidates.map((candidate) => candidate.executionId),
  );
  const matches: ValidationObligationMatch[] = [];
  for (const command of required) {
    const possible: {
      match: ValidationObligationMatch;
      completedAt: string;
    }[] = [];
    for (const candidate of candidates) {
      if (!available.has(candidate.executionId)) continue;
      const match = await matchValidationObligation(command, candidate, cwd);
      if (match) possible.push({ match, completedAt: candidate.completedAt });
    }
    possible.sort(
      (left, right) =>
        right.completedAt.localeCompare(left.completedAt) ||
        (left.match.matchType === "EXACT" ? -1 : 1),
    );
    const selected = possible[0]?.match;
    if (!selected) continue;
    matches.push(selected);
    available.delete(selected.executionId);
  }
  return matches;
}

export type CommandOutcomeCategory =
  | "PASS"
  | "TEST_FAILURE"
  | "STATIC_FORMAT_FAILURE"
  | "STATIC_ANALYSIS_FAILURE"
  | "BUILD_FAILURE"
  | "DIAGNOSTIC_FAILURE"
  | "TOOL_UNAVAILABLE"
  | "NOT_APPLICABLE"
  | "INVOCATION_ERROR"
  | "INFRASTRUCTURE_ERROR"
  | "INDETERMINATE";

export type CommandValidationType = "TEST" | "STATIC" | "BUILD" | "DIAGNOSTIC";

export type ClassifiedCommandOutcome = {
  category: CommandOutcomeCategory;
  validationType: CommandValidationType;
  validatorIdentity: ValidatorIdentity;
  purposeMismatch?: {
    declaredPurpose: "test" | "static";
    effectiveValidationType: CommandValidationType;
    detectedTool: EffectiveValidationIdentity["tool"];
    source: EffectiveValidationIdentity["source"];
  };
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
  const storedValidator = result.validatorIdentity;
  const directValidator = directStaticValidatorIdentity(result.command);
  const directEffective = directEffectiveValidationIdentity(result.command);
  const storedValidationType: CommandValidationType | undefined =
    storedValidator?.tool === "PHPUNIT"
      ? "TEST"
      : storedValidator?.tool === "PHP_DIAGNOSTIC"
        ? "DIAGNOSTIC"
        : storedValidator &&
            ([...buildValidatorTools] as readonly string[]).includes(
              storedValidator.tool,
            )
          ? "BUILD"
          : storedValidator &&
              ([...staticValidatorTools] as readonly string[]).includes(
                storedValidator.tool,
              )
            ? "STATIC"
            : undefined;
  const effectiveValidationIdentity: EffectiveValidationIdentity | undefined =
    result.effectiveValidationIdentity ??
    (storedValidator &&
    storedValidationType &&
    storedValidator.source !== "unknown"
      ? {
          validationType: storedValidationType,
          tool: storedValidator.tool as EffectiveValidationIdentity["tool"],
          source: storedValidator.source,
          ...(storedValidator.scriptName
            ? { scriptName: storedValidator.scriptName }
            : {}),
          ...(storedValidator.underlyingTools
            ? { underlyingTools: storedValidator.underlyingTools }
            : {}),
        }
      : directEffective);
  const declaredValidationType: CommandValidationType =
    result.command.purpose === "static" ? "STATIC" : "TEST";
  const validationType =
    effectiveValidationIdentity?.validationType ?? declaredValidationType;
  const validatorIdentity: ValidatorIdentity =
    storedValidator ??
    directValidator ??
    (effectiveValidationIdentity
      ? {
          tool: effectiveValidationIdentity.tool,
          source: effectiveValidationIdentity.source,
          ...(effectiveValidationIdentity.scriptName
            ? { scriptName: effectiveValidationIdentity.scriptName }
            : {}),
          ...(effectiveValidationIdentity.underlyingTools
            ? { underlyingTools: effectiveValidationIdentity.underlyingTools }
            : {}),
        }
      : { tool: "UNKNOWN", source: "unknown" });
  const purposeMismatch =
    ["test", "static"].includes(result.command.purpose) &&
    Boolean(effectiveValidationIdentity) &&
    effectiveValidationIdentity?.validationType !== declaredValidationType
      ? {
          declaredPurpose: result.command.purpose as "test" | "static",
          effectiveValidationType: validationType,
          detectedTool: effectiveValidationIdentity!.tool,
          source: effectiveValidationIdentity!.source,
        }
      : undefined;
  const outcome = (
    category: CommandOutcomeCategory,
    reason: string,
    recoverable: boolean,
  ): ClassifiedCommandOutcome => ({
    category,
    validationType,
    validatorIdentity,
    ...(purposeMismatch ? { purposeMismatch } : {}),
    reason,
    recoverable,
  });
  if (result.exitCode === 0)
    return outcome("PASS", "Command completed successfully", false);
  const output = withoutAnsi(
    [result.output, result.stdoutTail, result.stderrTail].join("\n"),
  );
  if (
    validationType === "DIAGNOSTIC" &&
    /(?:^|\n)\s*(?:PARSE ERROR|PHP Parse error:)|syntax error,\s*unexpected/i.test(
      output,
    )
  )
    return outcome(
      "INVOCATION_ERROR",
      "The PHP diagnostic expression contains a syntax error; this does not establish an application test failure",
      false,
    );
  if (
    /no tests found matching|unknown option:?|invalid cli argument|unknown argument:?|option .* does not exist|missing script:\s*["']|unknown command:?/i.test(
      output,
    )
  )
    return outcome(
      "INVOCATION_ERROR",
      "Validator rejected the invocation before producing a result",
      false,
    );
  const toolNames: Partial<Record<ValidationTool, string[]>> = {
    VITE: ["vite"],
    WEBPACK: ["webpack"],
    NEXT: ["next"],
    ANGULAR: ["ng", "angular"],
    TYPESCRIPT: ["tsc"],
    ESLINT: ["eslint"],
    PRETTIER: ["prettier"],
  };
  const expectedTools =
    validatorIdentity.tool === "COMPOSITE"
      ? (validatorIdentity.underlyingTools ?? []).flatMap(
          (tool) => toolNames[tool] ?? [],
        )
      : validatorIdentity.tool === "UNKNOWN"
        ? []
        : (toolNames[validatorIdentity.tool] ?? []);
  const missingTool = expectedTools.find((tool) => {
    const escaped = tool.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(
      `(?:['\"]?${escaped}['\"]?\\s+is not recognized as an internal or external command|Der Befehl [\"']${escaped}[\"'] ist entweder falsch geschrieben|(?:^|\\n)\\s*(?:sh:\\s*\\d+:\\s*)?${escaped}:\\s*(?:command )?not found|spawn\\s+${escaped}\\s+ENOENT|Cannot find module[^\\n]*${escaped})`,
      "i",
    ).test(output);
  });
  if (missingTool)
    return outcome(
      "TOOL_UNAVAILABLE",
      `The required ${missingTool} executable could not be found; validation did not run`,
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
    validationType === "TEST" &&
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
    validationType === "TEST" &&
    result.command.args.includes("--test") &&
    /(?:^|\n)\s*(?:#|ℹ)\s*fail\s+[1-9]\d*\b/i.test(output)
  )
    return outcome(
      "TEST_FAILURE",
      "Node test runner reported failing tests",
      true,
    );
  if (validationType === "STATIC") {
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
      tool === "PHP_LINT" &&
      /(?:PHP Parse error:|Errors parsing\s+\S+|syntax error,\s*unexpected)/i.test(
        output,
      )
    )
      return outcome(
        "STATIC_ANALYSIS_FAILURE",
        "PHP lint reported a source-file syntax error",
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
  if (validationType === "BUILD" && validatorIdentity.tool !== "UNKNOWN")
    return outcome(
      "BUILD_FAILURE",
      `${validatorIdentity.tool === "COMPOSITE" ? "The build toolchain" : validatorIdentity.tool} reported a build failure`,
      true,
    );
  if (validationType === "DIAGNOSTIC")
    return outcome(
      "DIAGNOSTIC_FAILURE",
      "The valid diagnostic invocation reported that its checked invariant was not satisfied",
      true,
    );
  return outcome(
    "INDETERMINATE",
    ["STATIC", "BUILD"].includes(validationType) &&
      ["UNKNOWN", "COMPOSITE"].includes(validatorIdentity.tool)
      ? `${validationType === "BUILD" ? "Build tool" : "Static validator"} identity is ${validatorIdentity.tool.toLowerCase()}; nonzero exit cannot be attributed from output alone`
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
      validationType: outcome.validationType,
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
  const failedOutcome = classifyVerifiedCommand(failed);
  if (failedOutcome.category !== "INVOCATION_ERROR") return;
  const sameSnapshot = (candidate: VerifiedCommandResult) =>
    candidate.repoState.head === failed.repoState.head &&
    candidate.repoState.packageJsonHash === failed.repoState.packageJsonHash &&
    candidate.repoState.composerJsonHash ===
      failed.repoState.composerJsonHash &&
    JSON.stringify(candidate.repoState.gateHashes) ===
      JSON.stringify(failed.repoState.gateHashes);
  if (
    failed.command.verificationId &&
    failedOutcome.validationType === "DIAGNOSTIC"
  )
    for (const candidate of candidates) {
      const candidateOutcome = classifyVerifiedCommand(candidate);
      if (
        candidate.executionId !== failed.executionId &&
        candidate.agent === failed.agent &&
        candidate.attempt === failed.attempt &&
        candidate.completedAt > failed.completedAt &&
        sameSnapshot(candidate) &&
        candidate.command.verificationId === failed.command.verificationId &&
        candidateOutcome.validationType === "DIAGNOSTIC" &&
        candidateOutcome.validatorIdentity.tool ===
          failedOutcome.validatorIdentity.tool &&
        candidateOutcome.category === "PASS"
      )
        return candidate;
    }
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
      !sameSnapshot(candidate)
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
