import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Command } from "../config/schema.ts";

export const commandMutationRisks = [
  "READ_ONLY",
  "GENERATED_OUTPUT",
  "DEPENDENCY_MUTATION",
  "SOURCE_MUTATION",
  "UNKNOWN",
] as const;
export type CommandMutationRisk = (typeof commandMutationRisks)[number];

export interface CommandMutationClassification {
  risk: CommandMutationRisk;
  reason: string;
  potentialRepositoryChanges: string[];
  packageManager?: "npm" | "pnpm" | "yarn" | "bun" | "composer";
  script?: string;
}

function executableName(value: string) {
  return (
    value.replaceAll("\\", "/").split("/").at(-1)?.toLowerCase() ?? ""
  ).replace(/\.(?:cmd|bat|exe)$/i, "");
}

const dependencySubcommands: Record<string, ReadonlySet<string>> = {
  npm: new Set(["i", "install", "ci", "update", "uninstall", "remove", "exec"]),
  pnpm: new Set(["i", "install", "add", "update", "up", "remove", "dlx"]),
  yarn: new Set(["install", "add", "upgrade", "up", "remove", "dlx"]),
  bun: new Set(["install", "add", "update", "remove", "x"]),
  composer: new Set(["install", "update", "require", "remove"]),
};

const readOnlySubcommands: Record<string, ReadonlySet<string>> = {
  npm: new Set(["list", "ls", "view", "help", "--version", "-v"]),
  pnpm: new Set(["list", "ls", "why", "help", "--version", "-v"]),
  yarn: new Set(["list", "why", "info", "help", "--version", "-v"]),
  bun: new Set(["pm", "help", "--version", "-v"]),
  composer: new Set([
    "show",
    "validate",
    "diagnose",
    "help",
    "--version",
    "-v",
  ]),
};

function packageChanges(manager: string) {
  return manager === "composer"
    ? ["composer.lock", "vendor/"]
    : manager === "npm"
      ? ["package-lock.json", "npm-shrinkwrap.json", "node_modules/"]
      : manager === "pnpm"
        ? ["pnpm-lock.yaml", "node_modules/"]
        : manager === "yarn"
          ? ["yarn.lock", "node_modules/"]
          : ["bun.lock", "bun.lockb", "node_modules/"];
}

function splitScript(source: string): string[] {
  return source
    .split(/(?:&&|\|\||[;|])/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function scriptInvocation(part: string) {
  const tokens = part
    .match(/(?:"[^"]*"|'[^']*'|[^\s]+)/g)
    ?.map((token) => token.replace(/^(?:"(.*)"|'(.*)')$/s, "$1$2"));
  if (!tokens?.length) return undefined;
  const manager = executableName(tokens[0]);
  if (!Object.hasOwn(dependencySubcommands, manager)) return undefined;
  const first = tokens.find(
    (token, index) => index > 0 && !token.startsWith("-"),
  );
  return { manager, subcommand: first?.toLowerCase(), tokens };
}

function dependencyInScript(source: string) {
  for (const part of splitScript(source)) {
    const invocation = scriptInvocation(part);
    if (
      invocation?.subcommand &&
      dependencySubcommands[invocation.manager].has(invocation.subcommand)
    )
      return invocation.manager;
    if (/^(?:npx|npm\s+exec)(?:\s|$)/i.test(part)) return "npm";
  }
  return undefined;
}

async function packageScriptClassification(
  manager: "npm" | "pnpm" | "yarn" | "bun" | "composer",
  script: string,
  cwd: string,
): Promise<CommandMutationClassification> {
  const manifest = manager === "composer" ? "composer.json" : "package.json";
  try {
    const source = await readFile(join(cwd, manifest));
    if (source.byteLength > 262_144)
      throw new Error("manifest is too large to inspect safely");
    const document = JSON.parse(source.toString("utf8"));
    const scripts = document?.scripts;
    if (!scripts || typeof scripts !== "object" || Array.isArray(scripts))
      throw new Error("manifest scripts are unavailable");
    const pending = [script];
    const visited = new Set<string>();
    let recognizedValidation = true;
    while (pending.length) {
      const name = pending.shift()!;
      if (visited.has(name)) continue;
      visited.add(name);
      if (visited.size > 32) throw new Error("script graph is too large");
      const definition = scripts[name];
      const lines =
        typeof definition === "string"
          ? [definition]
          : Array.isArray(definition) &&
              definition.every((item) => typeof item === "string")
            ? definition
            : undefined;
      if (!lines) throw new Error(`scripts.${name} is not inspectable`);
      for (const line of lines) {
        const mutationManager = dependencyInScript(line);
        if (mutationManager)
          return {
            risk: "DEPENDENCY_MUTATION",
            packageManager:
              mutationManager as CommandMutationClassification["packageManager"],
            script,
            reason: `${manifest} scripts.${name} invokes a dependency-changing command`,
            potentialRepositoryChanges: packageChanges(mutationManager),
          };
        for (const part of splitScript(line)) {
          const nested = scriptInvocation(part);
          const nestedName =
            nested &&
            ((nested.manager === "composer" &&
              (nested.tokens[1] === "run" ||
                nested.tokens[1] === "run-script") &&
              nested.tokens[2]) ||
              (nested.manager !== "composer" &&
                ["run", "run-script"].includes(nested.tokens[1]) &&
                nested.tokens[2]));
          if (nestedName && Object.hasOwn(scripts, nestedName))
            pending.push(nestedName);
          else if (
            !/^(?:php(?:\.exe)?\s+(?:artisan\s+test|[^\s]*phpunit)|(?:[^\s/]+\/)*phpunit|(?:[^\s/]+\/)*(?:jest|vitest|mocha|eslint|tsc|vite|webpack)|node\s+--test|cargo\s+(?:test|clippy)|go\s+test)\b/i.test(
              part,
            )
          )
            recognizedValidation = false;
        }
      }
    }
    return recognizedValidation
      ? {
          risk: "GENERATED_OUTPUT",
          script,
          packageManager: manager,
          reason: `${manifest} script graph was inspected and contains recognized validation/build tools`,
          potentialRepositoryChanges: ["generated test or build output"],
        }
      : {
          risk: "UNKNOWN",
          script,
          packageManager: manager,
          reason: `${manifest} script graph contains commands whose side effects are not host-classified`,
          potentialRepositoryChanges: ["unknown project files"],
        };
  } catch (error) {
    return {
      risk: "UNKNOWN",
      script,
      packageManager: manager,
      reason: `Cannot safely inspect ${manifest} script: ${error instanceof Error ? error.message : "unknown error"}`,
      potentialRepositoryChanges: ["unknown project files"],
    };
  }
}

export async function classifyCommandMutation(
  command: Pick<Command, "executable" | "args">,
  cwd: string,
): Promise<CommandMutationClassification> {
  const executable = executableName(command.executable);
  if (executable === "npx")
    return {
      risk: "DEPENDENCY_MUTATION",
      packageManager: "npm",
      reason:
        "npx may download and execute a package when it is not already available",
      potentialRepositoryChanges: packageChanges("npm"),
    };
  if (!Object.hasOwn(dependencySubcommands, executable))
    return {
      risk: "UNKNOWN",
      reason: "Executable side effects are not host-classified",
      potentialRepositoryChanges: ["unknown project files"],
    };
  const manager = executable as CommandMutationClassification["packageManager"];
  const subcommand = command.args
    .find((arg) => !arg.startsWith("-"))
    ?.toLowerCase();
  if (!subcommand)
    return {
      risk: "UNKNOWN",
      packageManager: manager,
      reason: "Package-manager invocation has no unambiguous subcommand",
      potentialRepositoryChanges: ["unknown project files"],
    };
  if (dependencySubcommands[executable].has(subcommand))
    return {
      risk: "DEPENDENCY_MUTATION",
      packageManager: manager,
      reason: `${executable} ${subcommand} changes dependency state`,
      potentialRepositoryChanges: packageChanges(executable),
    };
  if (readOnlySubcommands[executable].has(subcommand))
    return {
      risk: "READ_ONLY",
      packageManager: manager,
      reason: `${executable} ${subcommand} is a recognized inspection command`,
      potentialRepositoryChanges: [],
    };
  const script =
    executable === "composer"
      ? ["run", "run-script"].includes(subcommand)
        ? command.args[command.args.indexOf(subcommand) + 1]
        : Object.hasOwn(readOnlySubcommands, executable)
          ? subcommand
          : undefined
      : ["run", "run-script"].includes(subcommand)
        ? command.args[command.args.indexOf(subcommand) + 1]
        : subcommand === "test"
          ? "test"
          : undefined;
  if (script) return packageScriptClassification(manager!, script, cwd);
  return {
    risk: "UNKNOWN",
    packageManager: manager,
    reason: `Unknown ${executable} subcommand is not assumed safe`,
    potentialRepositoryChanges: ["unknown project files"],
  };
}
