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

export const buildTaskRelevanceStatuses = [
  "RELEVANT",
  "UNRELATED",
  "AMBIGUOUS",
] as const;
export type BuildTaskRelevanceStatus =
  (typeof buildTaskRelevanceStatuses)[number];

export interface BuildRequirementAssessment {
  runtimeDependency: {
    status: "DETECTED" | "NOT_DETECTED" | "AMBIGUOUS";
    evidence: ValidationApplicabilityEvidence[];
  };
  taskRelevance: {
    status: BuildTaskRelevanceStatus;
    evidence: ValidationApplicabilityEvidence[];
  };
  gateRequirement: {
    status: ValidationApplicabilityStatus;
    reasonCode: string;
    explanation: string;
    evidence: ValidationApplicabilityEvidence[];
  };
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
  buildAssessment?: BuildRequirementAssessment;
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
  detected?: ValidationApplicabilityEvidence[];
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
  const detected: ValidationApplicabilityEvidence[] = [];
  let ambiguous: ValidationApplicabilityEvidence | undefined;
  for (const path of assetViews) {
    const name = viewName(cwd, path);
    const usage = new RegExp(
      `(?:view|View::make|Route::view)\\s*\\([^)]*['\"]${escaped(name)}['\"]`,
      "i",
    );
    const consumers = await matchingFiles(cwd, usage, { excludeViews: true });
    if (consumers.length) {
      detected.push(
        {
          source: "runtime_asset_consumer",
          reference: repositoryReference(cwd, path),
          detail: `Referenced by ${repositoryReference(cwd, consumers[0])}.`,
        },
        {
          source: "runtime_entry_point",
          reference: repositoryReference(cwd, consumers[0]),
          detail: `Renders ${repositoryReference(cwd, path)}.`,
        },
      );
      continue;
    }
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
  for (const path of directConsumers)
    detected.push({
      source: "runtime_asset_consumer",
      reference: repositoryReference(cwd, path),
      detail: "Runtime application code directly consumes generated assets.",
    });
  if (detected.length) return { detected, ignored };
  return { ambiguous, ignored };
}

function decision(
  discovered: DiscoveredCommand,
  status: ValidationApplicabilityStatus,
  reasonCode: string,
  explanation: string,
  evidence: ValidationApplicabilityEvidence[],
  context?: Omit<BuildRequirementAssessment, "gateRequirement">,
): ValidationApplicability {
  const boundedEvidence = evidence.slice(0, 8);
  return {
    command: discovered.command,
    discovery: "DISCOVERED",
    status,
    reasonCode,
    explanation,
    evidence: boundedEvidence,
    source: discovered.source,
    category: discovered.category,
    ...(context
      ? {
          buildAssessment: {
            ...context,
            gateRequirement: {
              status,
              reasonCode,
              explanation,
              evidence: boundedEvidence,
            },
          },
        }
      : {}),
  };
}

function normalizedScopePath(path: string) {
  return path.replaceAll("\\", "/").replace(/^\.\//, "").toLowerCase();
}

function buildContext(
  contract: ContractEvidence,
  runtime: RuntimeAssetEvidence,
): Omit<BuildRequirementAssessment, "gateRequirement"> {
  const scoped = new Set(contract.paths.map(normalizedScopePath));
  const frontendPaths = frontendScope(contract.paths);
  const changedRuntimePaths = (runtime.detected ?? [])
    .map((evidence) => evidence.reference)
    .filter((reference): reference is string => Boolean(reference))
    .filter((reference) => scoped.has(normalizedScopePath(reference)));
  const buildConfigurationPaths = contract.paths.filter((path) =>
    /^(?:package(?:-lock)?\.json|vite\.config\.[^/]+|webpack\.[^/]+|angular\.json|tsconfig(?:\.[^/]+)?\.json)$/i.test(
      path.replaceAll("\\", "/"),
    ),
  );
  const relevant = [
    ...frontendPaths,
    ...changedRuntimePaths,
    ...buildConfigurationPaths,
  ].filter((path, index, all) => all.indexOf(path) === index);
  const taskRelevance: BuildRequirementAssessment["taskRelevance"] =
    relevant.length
      ? {
          status: "RELEVANT",
          evidence: [
            {
              source: "implementation_contract",
              reference: "file scope",
              detail: `Build-relevant paths: ${relevant.slice(0, 5).join(", ")}.`,
            },
          ],
        }
      : runtime.ambiguous
        ? {
            status: "AMBIGUOUS",
            evidence: [runtime.ambiguous],
          }
        : {
            status: "UNRELATED",
            evidence: [
              {
                source: "implementation_contract",
                reference: "file scope",
                detail:
                  "No frontend source, build configuration, or detected runtime asset consumer is changed by this task.",
              },
            ],
          };
  return {
    runtimeDependency: runtime.detected
      ? { status: "DETECTED", evidence: runtime.detected.slice(0, 8) }
      : runtime.ambiguous
        ? { status: "AMBIGUOUS", evidence: [runtime.ambiguous] }
        : {
            status: "NOT_DETECTED",
            evidence: [
              ...runtime.ignored.slice(0, 7),
              {
                source: "runtime_analysis",
                detail:
                  "No verified runtime entry point requires generated frontend assets.",
              },
            ],
          },
    taskRelevance,
  };
}

async function buildApplicability(
  state: WorkflowState,
  discovered: DiscoveredCommand,
): Promise<ValidationApplicability> {
  const { command } = discovered;
  const contract = contractEvidence(state);
  const runtime = await runtimeAssetEvidence(state.cwd);
  const context = buildContext(contract, runtime);
  const explicit = contractBuildRequirement(contract, command);
  if (explicit)
    return decision(
      discovered,
      "REQUIRED",
      "EXPLICIT_CONTRACT_REQUIREMENT",
      "The Implementation Contract explicitly requires this build.",
      [explicit],
      context,
    );

  const ciFile = await ciReferencesCommand(state.cwd, command);
  if (ciFile)
    return decision(
      discovered,
      "REQUIRED",
      "EXPLICIT_CI_REQUIREMENT",
      "The checked-in CI pipeline explicitly requires this build.",
      [{ source: "ci_configuration", reference: ciFile }],
      context,
    );

  const scriptReferences = await projectScriptReferences(state.cwd, command);
  const nonGateScriptEvidence = scriptReferences
    .filter((reference) =>
      ["SETUP", "DEVELOPMENT", "BUILD"].includes(reference.context),
    )
    .slice(0, 3)
    .map((reference) => ({
      source: "project_script",
      reference: reference.reference,
      detail: `${reference.detail} This context does not establish a Tester quality gate.`,
    }));
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
      context,
    );

  if (await exists(join(state.cwd, "angular.json")))
    return decision(
      discovered,
      "REQUIRED",
      "NATIVE_FRAMEWORK_BUILD",
      "The discovered build is the native validation gate for this Angular workspace.",
      [{ source: "framework_configuration", reference: "angular.json" }],
      context,
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
      context,
    );

  if (runtime.detected && context.taskRelevance.status === "RELEVANT")
    return decision(
      discovered,
      "REQUIRED",
      "ACTIVE_FRONTEND_TASK_SCOPE",
      "The current task changes build inputs, configuration, or a runtime path that consumes generated assets.",
      [...runtime.detected, ...context.taskRelevance.evidence],
      context,
    );

  if (runtime.detected && context.taskRelevance.status === "UNRELATED")
    return decision(
      discovered,
      "NOT_APPLICABLE",
      "TASK_UNRELATED_RUNTIME_ASSET_DEPENDENCY",
      "The application has a runtime asset dependency, but the existing consumer is outside the current task scope and no explicit build quality gate requires it.",
      [
        ...runtime.detected,
        ...context.taskRelevance.evidence,
        ...nonGateScriptEvidence,
      ],
      context,
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
      context,
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
      context,
    );

  if (runtime.ambiguous)
    return decision(
      discovered,
      "AMBIGUOUS",
      "UNRESOLVED_RUNTIME_ASSET_DEPENDENCY",
      "A view consumes built assets, but the available repository evidence does not establish whether that view is used at runtime.",
      [runtime.ambiguous],
      context,
    );

  const frontendPaths = frontendScope(contract.paths);
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
      context,
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
      context,
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
    context,
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
  const values: ValidationApplicability[] = [];
  for (const command of state.config.commands.filter((command) =>
    ["test", "static"].includes(command.purpose),
  )) {
    const identity = await resolveEffectiveValidationIdentity(
      command,
      state.cwd,
    );
    const evidence = [
      {
        source: "workflow_configuration",
        reference: "workflow.commands",
      },
    ];
    const status = "REQUIRED" as const;
    const reasonCode = "EXPLICIT_WORKFLOW_CONFIGURATION";
    const explanation =
      "The command is explicitly configured as a workflow quality gate.";
    let buildAssessment: BuildRequirementAssessment | undefined;
    if (identity?.validationType === "BUILD") {
      const context = buildContext(
        contractEvidence(state),
        await runtimeAssetEvidence(state.cwd),
      );
      buildAssessment = {
        ...context,
        gateRequirement: { status, reasonCode, explanation, evidence },
      };
    }
    values.push({
      command,
      discovery: "CONFIGURED" as const,
      status,
      reasonCode,
      explanation,
      evidence,
      ...(buildAssessment ? { buildAssessment } : {}),
    });
  }
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
