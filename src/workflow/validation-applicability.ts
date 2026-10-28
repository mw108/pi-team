import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
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

export interface ValidationApplicability {
  command: Command;
  discovery: "CONFIGURED" | "DISCOVERED";
  status: ValidationApplicabilityStatus;
  reason: string;
  evidence: string[];
  source?: string;
  category?: DiscoveredCommand["category"];
}

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

function renderedCommand(command: Pick<Command, "executable" | "args">) {
  return [command.executable, ...command.args].join(" ");
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

async function filesContaining(
  root: string,
  pattern: RegExp,
  limit = 512,
): Promise<string | undefined> {
  const pending = [root];
  let inspected = 0;
  while (pending.length && inspected < limit) {
    const directory = pending.shift()!;
    for (const entry of await readdir(directory, { withFileTypes: true }).catch(
      () => [],
    )) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (
        entry.isFile() &&
        /\.(?:php|blade\.php|html|twig)$/i.test(entry.name)
      ) {
        inspected++;
        const text = await readSmall(path);
        if (text && pattern.test(text)) return path;
      }
    }
  }
}

function contractEvidence(state: WorkflowState) {
  const parsed = contractSchema.safeParse(state.results.reviewer);
  if (!parsed.success)
    return { paths: [] as string[], text: "", requiredTests: 0 };
  const contract = parsed.data;
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
    text: [
      contract.goal,
      ...contract.requiredChanges,
      ...contract.technicalDecisions,
      ...contract.constraints,
      ...contract.acceptanceCriteria,
      ...contract.requiredTests.flatMap((test) => [
        test.description,
        ...(test.acceptanceCriteria ?? []),
      ]),
    ]
      .join("\n")
      .toLowerCase(),
    requiredTests: contract.requiredTests.length,
  };
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

async function buildApplicability(
  state: WorkflowState,
  discovered: DiscoveredCommand,
): Promise<ValidationApplicability> {
  const { command } = discovered;
  const contract = contractEvidence(state);
  const evidence: string[] = [];
  const explicitCommand = renderedCommand(command).toLowerCase();
  if (
    contract.text.includes(explicitCommand) ||
    /\b(?:run|require|required|verify|verification|validate)\b[^.\n]{0,80}\b(?:build|compile|bundle)(?:ing)?\b/i.test(
      contract.text,
    ) ||
    /\b(?:build|compile|bundle)(?:ing)?\b[^.\n]{0,80}\b(?:require|required|verify|verification|validate)\b/i.test(
      contract.text,
    )
  ) {
    evidence.push("The Implementation Contract explicitly requires a build.");
    return {
      command,
      discovery: "DISCOVERED",
      status: "REQUIRED",
      reason: "The build is an explicit workflow requirement.",
      evidence,
      source: discovered.source,
      category: discovered.category,
    };
  }
  const ciFile = await ciReferencesCommand(state.cwd, command);
  if (ciFile) {
    evidence.push(`Project CI invokes the exact command in ${ciFile}.`);
    return {
      command,
      discovery: "DISCOVERED",
      status: "REQUIRED",
      reason: "The project's checked-in CI configuration requires this build.",
      evidence,
      source: discovered.source,
      category: discovered.category,
    };
  }
  const frontendPaths = frontendScope(contract.paths);
  if (frontendPaths.length) {
    evidence.push(
      `The workflow scope includes frontend assets: ${frontendPaths.slice(0, 5).join(", ")}.`,
    );
    return {
      command,
      discovery: "DISCOVERED",
      status: "REQUIRED",
      reason:
        "Frontend files in the current workflow require build verification.",
      evidence,
      source: discovered.source,
      category: discovered.category,
    };
  }
  if (await exists(join(state.cwd, "angular.json"))) {
    evidence.push("angular.json establishes an Angular application workspace.");
    return {
      command,
      discovery: "DISCOVERED",
      status: "REQUIRED",
      reason:
        "The discovered build is the native build gate for this Angular project.",
      evidence,
      source: discovered.source,
      category: discovered.category,
    };
  }
  const runtimeReference = await filesContaining(
    join(state.cwd, "resources", "views"),
    /@vite\s*\(|Vite::asset\s*\(|mix\s*\(|(?:public_path|base_path)\s*\([^)]*(?:manifest|build)/i,
  );
  if (runtimeReference) {
    evidence.push(
      "A checked-in server-rendered entry point consumes built assets.",
    );
    return {
      command,
      discovery: "DISCOVERED",
      status: "REQUIRED",
      reason: "Runtime application code references the generated asset build.",
      evidence,
      source: discovered.source,
      category: discovered.category,
    };
  }
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
  ) {
    evidence.push(
      "The package build resolves to tsc and tsconfig.json is present.",
    );
    return {
      command,
      discovery: "DISCOVERED",
      status: "REQUIRED",
      reason: "The TypeScript project build is its compiler validation gate.",
      evidence,
      source: discovered.source,
      category: discovered.category,
    };
  }
  if (laravel && !runtimeReference && !frontendPaths.length) {
    evidence.push(
      "Laravel is present, but the current Contract changes no frontend files.",
    );
    evidence.push(
      "No server-rendered runtime entry point references built assets.",
    );
    return {
      command,
      discovery: "DISCOVERED",
      status: "NOT_APPLICABLE",
      reason:
        "The build was discovered from project metadata, but host evidence does not connect frontend asset compilation to this workflow.",
      evidence,
      source: discovered.source,
      category: discovered.category,
    };
  }
  evidence.push(
    "A build script exists, but no decisive requirement or exclusion was found.",
  );
  return {
    command,
    discovery: "DISCOVERED",
    status: "AMBIGUOUS",
    reason:
      "Build applicability is ambiguous; execution approval alone does not authorize omitting or requiring this quality gate.",
    evidence,
    source: discovered.source,
    category: discovered.category,
  };
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
  return {
    command: discovered.command,
    discovery: "DISCOVERED",
    status: knownProjectGate ? "REQUIRED" : "OPTIONAL",
    reason: knownProjectGate
      ? "High-confidence project validation matches the current Contract scope."
      : "The command is useful discovered evidence but is not established as a required gate.",
    evidence: [
      `${discovered.source} discovered this ${discovered.category} command with ${discovered.confidence} confidence.`,
    ],
    source: discovered.source,
    category: discovered.category,
  };
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
      reason:
        "The command is explicitly configured as a workflow quality gate.",
      evidence: ["workflow.commands explicitly configures this command."],
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
