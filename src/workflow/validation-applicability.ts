import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import type { Command, DiscoveredCommand } from "../config/schema.ts";
import { commandKey } from "../agents/discovery.ts";
import { contractSchema } from "../agents/schemas.ts";
import type { WorkflowState } from "./state.ts";
import { resolveEffectiveValidationIdentity } from "./verified-commands.ts";

export const validationApplicabilityStatuses = [
  "REQUIRED",
  "OPTIONAL",
  "NOT_APPLICABLE",
  "AMBIGUOUS",
] as const;
export type ValidationApplicabilityStatus =
  (typeof validationApplicabilityStatuses)[number];

export const validationScriptContexts = [
  "SETUP",
  "DEVELOPMENT",
  "BUILD",
  "TEST",
  "CI",
  "DEPLOYMENT",
  "UNKNOWN",
] as const;
export type ValidationScriptContext = (typeof validationScriptContexts)[number];

export interface ValidationApplicabilityEvidence {
  source: string;
  reference?: string;
  detail?: string;
}

export interface ValidationApplicability {
  command: Command;
  discovery: "CONFIGURED" | "DISCOVERED";
  status: ValidationApplicabilityStatus;
  reasonCode: string;
  explanation: string;
  evidence: ValidationApplicabilityEvidence[];
  source?: string;
  category?: DiscoveredCommand["category"];
}

interface ContractEvidence {
  paths: string[];
  statements: { reference: string; text: string; requiredField: boolean }[];
  requiredTests: number;
}

interface ScriptReference {
  context: ValidationScriptContext;
  reference: string;
  detail: string;
}

interface RuntimeAssetEvidence {
  required?: ValidationApplicabilityEvidence;
  ambiguous?: ValidationApplicabilityEvidence;
  ignored: ValidationApplicabilityEvidence[];
}

const assetConsumerPattern =
  /@vite\s*\(|Vite::asset\s*\(|mix\s*\(|(?:asset|public_path|base_path)\s*\([^)]*(?:manifest|build|dist)/i;

async function readSmall(path: string): Promise<string | undefined> {
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > 262144) return;
    return await readFile(path, "utf8");
  } catch {
    return;
  }
}

async function exists(path: string): Promise<boolean> {
  return stat(path)
    .then(() => true)
    .catch(() => false);
}

function repositoryReference(cwd: string, path: string) {
  return relative(cwd, path).replaceAll("\\", "/");
}

function renderedCommand(command: Pick<Command, "executable" | "args">) {
  return [command.executable, ...command.args].join(" ");
}

function escaped(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function ciReferencesCommand(
  cwd: string,
  command: Command,
): Promise<string | undefined> {
  const files = [".gitlab-ci.yml", ".gitlab-ci.yaml"];
  const workflows = join(cwd, ".github", "workflows");
  for (const name of await readdir(workflows).catch(() => []))
    if (/\.ya?ml$/i.test(name)) files.push(`.github/workflows/${name}`);
  const expected = renderedCommand(command).replace(/\s+/g, " ").trim();
  for (const file of files) {
    const text = await readSmall(join(cwd, file));
    if (
      text
        ?.split(/\r?\n/)
        .some(
          (line) => line.trim().replace(/^(?:-\s*)?run:\s*/, "") === expected,
        )
    )
      return file;
  }
}

async function matchingFiles(
  root: string,
  pattern: RegExp,
  options: { limit?: number; excludeViews?: boolean } = {},
): Promise<string[]> {
  const pending = [root];
  const matches: string[] = [];
  let inspected = 0;
  const limit = options.limit ?? 512;
  while (pending.length && inspected < limit && matches.length < 20) {
    const directory = pending.shift()!;
    for (const entry of await readdir(directory, { withFileTypes: true }).catch(
      () => [],
    )) {
      if (
        entry.name.startsWith(".") ||
        ["node_modules", "vendor", "storage"].includes(entry.name)
      )
        continue;
      const path = join(directory, entry.name);
      const normalized = path.replaceAll("\\", "/");
      if (
        entry.isDirectory() &&
        !(options.excludeViews && /\/resources\/views$/i.test(normalized))
      )
        pending.push(path);
      else if (entry.isFile() && /(?:\.blade)?\.php$/i.test(entry.name)) {
        inspected++;
        const text = await readSmall(path);
        pattern.lastIndex = 0;
        if (text && pattern.test(text)) matches.push(path);
      }
    }
  }
  return matches;
}

function contractEvidence(state: WorkflowState): ContractEvidence {
  const parsed = contractSchema.safeParse(state.results.reviewer);
  if (!parsed.success) return { paths: [], statements: [], requiredTests: 0 };
  const contract = parsed.data;
  const statements: ContractEvidence["statements"] = [];
  const add = (reference: string, values: string[], requiredField = false) =>
    values.forEach((text, index) =>
      statements.push({
        reference: `${reference}[${index}]`,
        text,
        requiredField,
      }),
    );
  statements.push({
    reference: "goal",
    text: contract.goal,
    requiredField: false,
  });
  add("requiredChanges", contract.requiredChanges, true);
  add("technicalDecisions", contract.technicalDecisions);
  add("constraints", contract.constraints);
  add("acceptanceCriteria", contract.acceptanceCriteria, true);
  contract.requiredTests.forEach((test, index) => {
    statements.push({
      reference: `requiredTests[${index}].description`,
      text: test.description,
      requiredField: true,
    });
    (test.acceptanceCriteria ?? []).forEach((text, criterion) =>
      statements.push({
        reference: `requiredTests[${index}].acceptanceCriteria[${criterion}]`,
        text,
        requiredField: true,
      }),
    );
  });
  return {
    paths: [
      ...contract.filesToModify,
      ...contract.filesToCreate,
      ...contract.filesToDelete,
      ...contract.requiredTests.flatMap((test) =>
        test.file ? [test.file] : [],
      ),
      ...state.observedImplementorMutations.map((mutation) => mutation.path),
    ],
    statements,
    requiredTests: contract.requiredTests.length,
  };
}

function isNegatedBuildStatement(text: string) {
  return [
    /\b(?:do|does|did|must|should|need)\s+not\b[^.\n]{0,100}\b(?:build|compile|bundle|npm\s+run\s+build)\b/i,
    /\b(?:no|not)\b[^.\n]{0,60}\b(?:build|compile|bundle)\b[^.\n]{0,60}\b(?:required|needed|necessary|applicable)\b/i,
    /\b(?:build|compile|bundle|npm\s+run\s+build)\b[^.\n]{0,60}\b(?:is|are)?\s*(?:not|optional|required\s+only\s+for)\b/i,
    /\b(?:without|exclude|excluding|skip)\b[^.\n]{0,80}\b(?:build|compile|bundle|npm\s+run\s+build)\b/i,
  ].some((pattern) => pattern.test(text));
}

function contractBuildRequirement(
  contract: ContractEvidence,
  command: Command,
): ValidationApplicabilityEvidence | undefined {
  const exact = new RegExp(`\\b${escaped(renderedCommand(command))}\\b`, "i");
  const build = /\b(?:build|compile|bundle)(?:ing)?\b/i;
  const positive =
    /\b(?:must|shall|required|require|verify|verification|validate|validation|pass|succeed)\b/i;
  const imperative =
    /^\s*(?:run|execute)\s+(?:the\s+)?(?:npm\s+run\s+build|build|compile|bundle)\b/i;
  for (const statement of contract.statements) {
    if (
      (!exact.test(statement.text) && !build.test(statement.text)) ||
      isNegatedBuildStatement(statement.text)
    )
      continue;
    if (
      statement.requiredField ||
      positive.test(statement.text) ||
      imperative.test(statement.text)
    )
      return {
        source: "implementation_contract",
        reference: statement.reference,
        detail: exact.test(statement.text)
          ? `Explicitly requires ${renderedCommand(command)}.`
          : "Explicitly requires build verification.",
      };
  }
}

export function classifyValidationScriptContext(
  name: string,
): ValidationScriptContext {
  const normalized = name.trim().toLowerCase();
  if (
    ["setup", "install", "bootstrap", "init", "initialize"].includes(normalized)
  )
    return "SETUP";
  if (
    ["dev", "develop", "development", "serve", "start", "watch"].includes(
      normalized,
    )
  )
    return "DEVELOPMENT";
  if (["build", "compile", "bundle"].includes(normalized)) return "BUILD";
  if (["test", "tests", "check", "verify", "validate"].includes(normalized))
    return "TEST";
  if (["ci", "continuous-integration"].includes(normalized)) return "CI";
  if (["deploy", "deployment", "release", "publish"].includes(normalized))
    return "DEPLOYMENT";
  return "UNKNOWN";
}

function scriptLines(value: unknown): string[] {
  if (typeof value === "string") return [value];
  return Array.isArray(value)
    ? value.filter((line): line is string => typeof line === "string")
    : [];
}

function referencedLocalScripts(
  manager: "npm" | "composer",
  line: string,
): string[] {
  const names: string[] = [];
  const pattern =
    manager === "npm"
      ? /\bnpm\s+run\s+([\w:-]+)/gi
      : /(?:^|\s)@([\w:-]+)(?=\s|$)|\bcomposer\s+(?:run\s+)?([\w:-]+)/gi;
  for (const match of line.matchAll(pattern)) names.push(match[1] ?? match[2]);
  return names;
}

function lineInvokesCommand(line: string, command: Command) {
  const expected = escaped(renderedCommand(command));
  return new RegExp(
    `(?:^|[;&|]\\s*|\\s)${expected}(?=\\s*(?:$|[;&|]))`,
    "i",
  ).test(line.trim());
}

async function projectScriptReferences(
  cwd: string,
  command: Command,
): Promise<ScriptReference[]> {
  const references: ScriptReference[] = [];
  for (const [file, manager] of [
    ["package.json", "npm"],
    ["composer.json", "composer"],
  ] as const) {
    let scripts: Record<string, unknown>;
    try {
      const document = JSON.parse((await readSmall(join(cwd, file))) ?? "");
      if (
        !document.scripts ||
        typeof document.scripts !== "object" ||
        Array.isArray(document.scripts)
      )
        continue;
      scripts = document.scripts;
    } catch {
      continue;
    }
    for (const root of Object.keys(scripts)) {
      const context = classifyValidationScriptContext(root);
      const pending = [root];
      const visited = new Set<string>();
      while (pending.length) {
        const name = pending.shift()!;
        if (visited.has(name)) continue;
        visited.add(name);
        for (const line of scriptLines(scripts[name])) {
          if (lineInvokesCommand(line, command)) {
            references.push({
              context,
              reference: `${file} scripts.${root}`,
              detail:
                name === root
                  ? `${context} script invokes ${renderedCommand(command)}.`
                  : `${context} script invokes ${renderedCommand(command)} transitively through scripts.${name}.`,
            });
          }
          for (const child of referencedLocalScripts(manager, line))
            if (Object.hasOwn(scripts, child)) pending.push(child);
        }
      }
    }
  }
  return references.filter(
    (reference, index, all) =>
      all.findIndex(
        (candidate) =>
          candidate.context === reference.context &&
          candidate.reference === reference.reference &&
          candidate.detail === reference.detail,
      ) === index,
  );
}

function frontendScope(paths: string[]): string[] {
  return paths.filter((path) => {
    const normalized = path.replaceAll("\\", "/");
    return (
      !/^(?:tests?|spec)\//i.test(normalized) &&
      !/\.(?:spec|test)\.[cm]?[jt]sx?$/i.test(normalized) &&
      /^(?:resources\/(?:js|css)|src\/|projects\/|app\/frontend\/|frontend\/|client\/)|\.(?:[cm]?[jt]sx?|css|scss|sass|less|vue|svelte)$/i.test(
        normalized,
      )
    );
  });
}

function phpScope(paths: string[]): boolean {
  return paths.some((path) => /\.(?:php|blade\.php)$/i.test(path));
}

function viewName(cwd: string, path: string) {
  return repositoryReference(join(cwd, "resources", "views"), path)
    .replace(/\.blade\.php$/i, "")
    .replaceAll("/", ".");
}

async function runtimeAssetEvidence(
  cwd: string,
): Promise<RuntimeAssetEvidence> {
  const viewsRoot = join(cwd, "resources", "views");
  const assetViews = await matchingFiles(viewsRoot, assetConsumerPattern);
  const ignored: ValidationApplicabilityEvidence[] = [];
  let ambiguous: ValidationApplicabilityEvidence | undefined;
  for (const path of assetViews) {
    const name = viewName(cwd, path);
    const usage = new RegExp(
      `(?:view|View::make|Route::view)\\s*\\([^)]*['\"]${escaped(name)}['\"]`,
      "i",
    );
    const consumers = await matchingFiles(cwd, usage, { excludeViews: true });
    if (consumers.length)
      return {
        required: {
          source: "runtime_asset_consumer",
          reference: repositoryReference(cwd, path),
          detail: `Referenced by ${repositoryReference(cwd, consumers[0])}.`,
        },
        ignored,
      };
    const reference = repositoryReference(cwd, path);
    if (name === "welcome")
      ignored.push({
        source: "incidental_framework_scaffold",
        reference,
        detail:
          "The default welcome view consumes assets but has no verified runtime reference.",
      });
    else
      ambiguous ??= {
        source: "unresolved_asset_consumer",
        reference,
        detail:
          "The view consumes built assets, but its runtime usage could not be verified.",
      };
  }
  const directConsumers = await matchingFiles(cwd, assetConsumerPattern, {
    excludeViews: true,
  });
  if (directConsumers.length)
    return {
      required: {
        source: "runtime_asset_consumer",
        reference: repositoryReference(cwd, directConsumers[0]),
        detail: "Runtime application code directly consumes generated assets.",
      },
      ignored,
    };
  return { ambiguous, ignored };
}

function decision(
  discovered: DiscoveredCommand,
  status: ValidationApplicabilityStatus,
  reasonCode: string,
  explanation: string,
  evidence: ValidationApplicabilityEvidence[],
): ValidationApplicability {
  return {
    command: discovered.command,
    discovery: "DISCOVERED",
    status,
    reasonCode,
    explanation,
    evidence,
    source: discovered.source,
    category: discovered.category,
  };
}

async function buildApplicability(
  state: WorkflowState,
  discovered: DiscoveredCommand,
): Promise<ValidationApplicability> {
  const { command } = discovered;
  const contract = contractEvidence(state);
  const explicit = contractBuildRequirement(contract, command);
  if (explicit)
    return decision(
      discovered,
      "REQUIRED",
      "EXPLICIT_CONTRACT_REQUIREMENT",
      "The Implementation Contract explicitly requires this build.",
      [explicit],
    );

  const ciFile = await ciReferencesCommand(state.cwd, command);
  if (ciFile)
    return decision(
      discovered,
      "REQUIRED",
      "EXPLICIT_CI_REQUIREMENT",
      "The checked-in CI pipeline explicitly requires this build.",
      [{ source: "ci_configuration", reference: ciFile }],
    );

  const scriptReferences = await projectScriptReferences(state.cwd, command);
  const testScript = scriptReferences.find((reference) =>
    ["TEST", "CI"].includes(reference.context),
  );
  if (testScript)
    return decision(
      discovered,
      "REQUIRED",
      "VERIFIED_QUALITY_SCRIPT_REQUIREMENT",
      "A project test or CI script explicitly invokes this build.",
      [
        {
          source: "project_script",
          reference: testScript.reference,
          detail: testScript.detail,
        },
      ],
    );

  if (await exists(join(state.cwd, "angular.json")))
    return decision(
      discovered,
      "REQUIRED",
      "NATIVE_FRAMEWORK_BUILD",
      "The discovered build is the native validation gate for this Angular workspace.",
      [{ source: "framework_configuration", reference: "angular.json" }],
    );

  const composer = await readSmall(join(state.cwd, "composer.json"));
  const laravel = Boolean(
    composer &&
    /"laravel\/framework"\s*:/.test(composer) &&
    (await exists(join(state.cwd, "artisan"))),
  );
  const identity = await resolveEffectiveValidationIdentity(command, state.cwd);
  if (
    !laravel &&
    identity?.validationType === "BUILD" &&
    identity.tool === "TYPESCRIPT" &&
    (await exists(join(state.cwd, "tsconfig.json")))
  )
    return decision(
      discovered,
      "REQUIRED",
      "TYPESCRIPT_COMPILER_GATE",
      "The package build resolves to the compiler gate for this TypeScript project.",
      [
        { source: "package_script", reference: discovered.source },
        { source: "compiler_configuration", reference: "tsconfig.json" },
      ],
    );

  const runtime = await runtimeAssetEvidence(state.cwd);
  const frontendPaths = frontendScope(contract.paths);
  if (runtime.required)
    return decision(
      discovered,
      "REQUIRED",
      frontendPaths.length
        ? "ACTIVE_FRONTEND_TASK_SCOPE"
        : "VERIFIED_RUNTIME_ASSET_DEPENDENCY",
      frontendPaths.length
        ? "The current task changes frontend assets consumed by verified runtime code."
        : "Verified runtime application code consumes the generated asset build.",
      [
        runtime.required,
        ...(frontendPaths.length
          ? [
              {
                source: "implementation_contract",
                reference: "file scope",
                detail: `Frontend paths: ${frontendPaths.slice(0, 5).join(", ")}.`,
              },
            ]
          : []),
      ],
    );

  const deployment = scriptReferences.find(
    (reference) => reference.context === "DEPLOYMENT",
  );
  if (deployment)
    return decision(
      discovered,
      "AMBIGUOUS",
      "UNRESOLVED_DEPLOYMENT_BUILD_REQUIREMENT",
      "A deployment script invokes this build, but no Contract or CI policy establishes it as a Tester quality gate.",
      [
        {
          source: "project_script",
          reference: deployment.reference,
          detail: deployment.detail,
        },
      ],
    );

  const unknownScript = scriptReferences.find(
    (reference) => reference.context === "UNKNOWN",
  );
  if (unknownScript)
    return decision(
      discovered,
      "AMBIGUOUS",
      "UNKNOWN_SCRIPT_BUILD_CONTEXT",
      "A project script invokes this build, but the script's intent is not established.",
      [
        {
          source: "project_script",
          reference: unknownScript.reference,
          detail: unknownScript.detail,
        },
      ],
    );

  if (runtime.ambiguous)
    return decision(
      discovered,
      "AMBIGUOUS",
      "UNRESOLVED_RUNTIME_ASSET_DEPENDENCY",
      "A view consumes built assets, but the available repository evidence does not establish whether that view is used at runtime.",
      [runtime.ambiguous],
    );

  if (frontendPaths.length)
    return decision(
      discovered,
      laravel ? "AMBIGUOUS" : "REQUIRED",
      laravel ? "UNRESOLVED_FRONTEND_BUILD_REQUIREMENT" : "FRONTEND_TASK_SCOPE",
      laravel
        ? "The task changes frontend sources, but no active Laravel asset consumer was verified."
        : "The current workflow changes frontend sources governed by the discovered build.",
      [
        {
          source: "implementation_contract",
          reference: "file scope",
          detail: `Frontend paths: ${frontendPaths.slice(0, 5).join(", ")}.`,
        },
      ],
    );

  const setup = scriptReferences.filter((reference) =>
    ["SETUP", "DEVELOPMENT", "BUILD"].includes(reference.context),
  );
  if (laravel)
    return decision(
      discovered,
      "NOT_APPLICABLE",
      "NO_FRONTEND_BUILD_REQUIREMENT",
      "The task changes only backend or server-rendered files, and no required frontend asset consumer was identified.",
      [
        {
          source: "implementation_contract",
          reference: "file scope",
          detail: "No JavaScript or CSS source changes are in scope.",
        },
        ...setup.slice(0, 3).map((reference) => ({
          source: "project_script",
          reference: reference.reference,
          detail: `${reference.detail} This context does not establish a Tester quality gate.`,
        })),
        ...runtime.ignored.slice(0, 2),
        {
          source: "runtime_analysis",
          detail:
            "No verified runtime entry point requires generated frontend assets.",
        },
      ],
    );

  return decision(
    discovered,
    "AMBIGUOUS",
    "UNRESOLVED_BUILD_DEPENDENCY",
    "A build script exists, but no decisive quality-gate requirement or exclusion was found.",
    [
      { source: "package_script", reference: discovered.source },
      ...setup.slice(0, 2).map((reference) => ({
        source: "project_script",
        reference: reference.reference,
        detail: reference.detail,
      })),
    ],
  );
}

async function discoveredApplicability(
  state: WorkflowState,
  discovered: DiscoveredCommand,
): Promise<ValidationApplicability> {
  if (discovered.category === "build")
    return buildApplicability(state, discovered);
  const contract = contractEvidence(state);
  const executable = discovered.command.executable.toLowerCase();
  const phpCommand =
    executable === "php" ||
    executable === "composer" ||
    /(?:^|\/)vendor\/bin\/(?:phpunit|pint|phpstan|psalm)/i.test(executable);
  const javascriptCommand = ["npm", "pnpm", "yarn", "bun", "npx"].includes(
    executable,
  );
  const laravel =
    (await exists(join(state.cwd, "artisan"))) &&
    Boolean(
      (await readSmall(join(state.cwd, "composer.json")))?.includes(
        '"laravel/framework"',
      ),
    );
  const scopeMatches = phpCommand
    ? phpScope(contract.paths) || laravel
    : javascriptCommand
      ? frontendScope(contract.paths).length > 0 || !laravel
      : true;
  const knownProjectGate =
    discovered.confidence === "high" &&
    scopeMatches &&
    (discovered.category === "test"
      ? contract.requiredTests > 0
      : phpScope(contract.paths) || frontendScope(contract.paths).length > 0);
  return decision(
    discovered,
    knownProjectGate ? "REQUIRED" : "OPTIONAL",
    knownProjectGate
      ? "DISCOVERED_VALIDATION_MATCHES_SCOPE"
      : "OPTIONAL_DISCOVERED_VALIDATION",
    knownProjectGate
      ? "High-confidence project validation matches the current Contract scope."
      : "The discovered command may provide useful evidence but is not established as a required gate.",
    [
      {
        source: "command_discovery",
        reference: discovered.source,
        detail: `${discovered.category}; ${discovered.confidence} confidence.`,
      },
    ],
  );
}

export async function validationApplicability(
  state: WorkflowState,
): Promise<ValidationApplicability[]> {
  const values: ValidationApplicability[] = state.config.commands
    .filter((command) => ["test", "static"].includes(command.purpose))
    .map((command) => ({
      command,
      discovery: "CONFIGURED" as const,
      status: "REQUIRED" as const,
      reasonCode: "EXPLICIT_WORKFLOW_CONFIGURATION",
      explanation:
        "The command is explicitly configured as a workflow quality gate.",
      evidence: [
        {
          source: "workflow_configuration",
          reference: "workflow.commands",
        },
      ],
    }));
  const seen = new Set(values.map((value) => commandKey(value.command)));
  for (const discovered of state.discoveredCommands) {
    if (
      seen.has(commandKey(discovered.command)) ||
      !["test", "static"].includes(discovered.command.purpose)
    )
      continue;
    seen.add(commandKey(discovered.command));
    values.push(await discoveredApplicability(state, discovered));
  }
  return values;
}

export function requiredValidationCommands(
  applicability: ValidationApplicability[],
): Command[] {
  return applicability
    .filter((item) => item.status === "REQUIRED")
    .map((item) => item.command);
}
