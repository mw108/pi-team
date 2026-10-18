import { readFile } from "node:fs/promises";
import { basename, dirname, join, posix } from "node:path";
import { git } from "./git.ts";
import type { WorkflowState } from "./state.ts";

const manifestNames = new Set(["package.json", "composer.json", "Cargo.toml"]);
const javascriptLocks = [
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
] as const;

function sibling(directory: string, name: string) {
  return directory === "." ? name : posix.join(directory, name);
}

function explicitManager(text: string) {
  if (/\bpnpm\s+(?:add|install|remove|update|up)\b/i.test(text)) return "pnpm";
  if (/\byarn\s+(?:add|install|remove|upgrade)\b/i.test(text)) return "yarn";
  if (/\bbun\s+(?:add|install|remove|update)\b/i.test(text)) return "bun";
  if (/\bnpm\s+(?:i|install|uninstall|remove|update)\b/i.test(text))
    return "npm";
  if (/\bcomposer\s+(?:install|require|remove|update)\b/i.test(text))
    return "composer";
  if (/\bcargo\s+(?:add|remove|update)\b/i.test(text)) return "cargo";
  return undefined;
}

export async function packageManagerContractGuidance(s: WorkflowState) {
  const files = (
    await git(s.cwd, ["ls-files", "-co", "--exclude-standard", "-z"])
  )
    .split("\0")
    .filter(Boolean);
  const present = new Set(files);
  const evidence = [s.task, ...s.requirements].join("\n");
  const requestedManager = explicitManager(evidence);
  const dependencyChangeRequired =
    requestedManager !== undefined ||
    /\b(?:dependency|dependencies|package|packages|lockfile)\b.{0,80}\b(?:add|install|remove|update|upgrade|change|modify)\b|\b(?:add|install|remove|update|upgrade|change|modify)\b.{0,80}\b(?:dependency|dependencies|package|packages|lockfile)\b/i.test(
      evidence,
    );
  const projects = [] as {
    manifest: string;
    manager?: string;
    lockfile?: string;
    lockfileExists?: boolean;
    basis: string;
  }[];
  for (const manifest of files.filter((path) =>
    manifestNames.has(basename(path)),
  )) {
    const directory = dirname(manifest).replaceAll("\\", "/");
    if (basename(manifest) === "composer.json") {
      const lockfile = sibling(directory, "composer.lock");
      projects.push({
        manifest,
        manager: "composer",
        lockfile,
        lockfileExists: present.has(lockfile),
        basis: "manifest convention",
      });
      continue;
    }
    if (basename(manifest) === "Cargo.toml") {
      const lockfile = sibling(directory, "Cargo.lock");
      projects.push({
        manifest,
        manager: "cargo",
        lockfile,
        lockfileExists: present.has(lockfile),
        basis: "manifest convention",
      });
      continue;
    }
    let declared: string | undefined;
    try {
      const parsed = JSON.parse(await readFile(join(s.cwd, manifest), "utf8"));
      if (typeof parsed.packageManager === "string")
        declared = parsed.packageManager.split("@", 1)[0];
    } catch {
      // The Reviewer still receives observed lockfiles when package.json is invalid.
    }
    const existing = javascriptLocks.filter((name) =>
      present.has(sibling(directory, name)),
    );
    const manager =
      declared ??
      (existing.length === 1
        ? existing[0].startsWith("pnpm")
          ? "pnpm"
          : existing[0].startsWith("yarn")
            ? "yarn"
            : existing[0].startsWith("bun")
              ? "bun"
              : "npm"
        : requestedManager &&
            ["npm", "pnpm", "yarn", "bun"].includes(requestedManager)
          ? requestedManager
          : undefined);
    const lockName =
      manager === "npm"
        ? existing.includes("npm-shrinkwrap.json")
          ? "npm-shrinkwrap.json"
          : "package-lock.json"
        : manager === "pnpm"
          ? "pnpm-lock.yaml"
          : manager === "yarn"
            ? "yarn.lock"
            : manager === "bun"
              ? existing.includes("bun.lockb")
                ? "bun.lockb"
                : "bun.lock"
              : undefined;
    const lockfile = lockName ? sibling(directory, lockName) : undefined;
    projects.push({
      manifest,
      ...(manager ? { manager } : {}),
      ...(lockfile ? { lockfile, lockfileExists: present.has(lockfile) } : {}),
      basis: declared
        ? "packageManager declaration"
        : existing.length === 1
          ? "observed lockfile"
          : requestedManager === manager
            ? "explicit task command"
            : "package manager is ambiguous",
    });
  }
  return {
    dependencyChangeRequired,
    requestedManager,
    projects,
    instruction:
      "When dependency installation or modification is explicitly required, include only the matching manifest and lockfile in the initial Implementation Contract. Use modify for an existing lockfile and create when the selected manager's lockfile does not yet exist. Do not include lockfiles for other managers.",
  };
}
