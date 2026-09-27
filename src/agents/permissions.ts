import { realpath, lstat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { Role, Contract } from "./schemas.ts";
import type { TeamConfig } from "../config/schema.ts";
export const serenaRead = [
  "serena_status",
  "serena_list_tools",
  "serena_get_symbols_overview",
  "serena_find_symbol",
  "serena_find_referencing_symbols",
  "serena_find_declaration",
  "serena_find_implementations",
  "serena_search_for_pattern",
  "serena_get_current_config",
  "serena_get_diagnostics_for_file",
];
export const serenaWrite = [
  "serena_replace_symbol_body",
  "serena_insert_before_symbol",
  "serena_insert_after_symbol",
  "serena_rename_symbol",
  "serena_safe_delete_symbol",
  "serena_replace_content",
];
const docsRoles: Role[] = [
  "researcher",
  "solver1",
  "solver2",
  "solver3",
  "reviewer",
  "implementor",
  "codeReviewer",
  "securityReviewer",
];
export function allowedTools(role: Role, config: TeamConfig) {
  const tools = role === "orchestrator" ? [] : ["read", "grep", "find", "ls"];
  if (
    role === "implementor" ||
    (role === "tester" && config.tester.mayModifyTests)
  )
    tools.push("edit", "write");
  if (role === "implementor") tools.push("team_delete");
  if (
    role === "implementor" ||
    role === "tester" ||
    role === "codeReviewer" ||
    role === "pentester"
  )
    tools.push("team_command");
  if (["codeReviewer", "commitAgent", "researcher"].includes(role))
    tools.push("team_git_inspect");
  if (role === "pentester") tools.push("team_local_http");
  if (
    config.integrations.serena.enabled &&
    !["orchestrator", "tester", "commitAgent"].includes(role)
  )
    tools.push(...serenaRead, ...(role === "implementor" ? serenaWrite : []));
  if (config.integrations.context7.enabled && docsRoles.includes(role))
    tools.push("mcp");
  if (config.integrations.web.enabled && role === "researcher")
    tools.push("web_search", "fetch_content");
  return tools;
}
export function contractPaths(contract?: Contract) {
  return contract
    ? [
        ...contract.filesToModify,
        ...contract.filesToCreate,
        ...contract.filesToDelete,
      ]
    : [];
}
export function assertRelative(path: string) {
  if (
    !path ||
    isAbsolute(path) ||
    path.split(/[\\/]/).some((s) => s === ".." || s === ".git") ||
    /^[.](pi|serena)([\\/]|$)/.test(path)
  )
    throw new Error(`Path outside approved source boundary: ${path}`);
}
export async function assertWithin(cwd: string, path: string) {
  const root = await realpath(cwd);
  let target = resolve(root, path);
  const lexical = relative(root, target);
  if (lexical.startsWith("..") || isAbsolute(lexical))
    throw new Error("Path escapes repository");
  while (true) {
    try {
      const actual = await realpath(target);
      const r = relative(root, actual);
      if (r.startsWith("..") || isAbsolute(r))
        throw new Error("Symlink escapes repository");
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      const parent = dirname(target);
      if (parent === target) throw e;
      target = parent;
    }
  }
}
export async function checkTool(
  role: Role,
  name: string,
  input: Record<string, unknown>,
  cwd: string,
  config: TeamConfig,
  contract?: Contract,
  dirtyPolicy?: { dirtyPaths: string[]; approvedDirtyPaths: string[] },
) {
  if (!allowedTools(role, config).includes(name))
    throw new Error(`Tool ${name} denied for ${role}`);
  if (
    name.startsWith("serena_") &&
    input.project &&
    resolve(String(input.project)) !== resolve(cwd)
  )
    throw new Error("Serena project override denied");
  const path = input.path ?? input.relative_path;
  if (typeof path === "string") {
    await assertWithin(cwd, path);
    if (path.split(/[\\/]/).includes(".git"))
      throw new Error("Git internals are private");
  }
  const mutation = ["write", "edit", "team_delete", ...serenaWrite].includes(
    name,
  );
  if (mutation) {
    if (typeof path !== "string")
      throw new Error("Mutation requires an explicit repository path");
    assertRelative(path);
    if (
      dirtyPolicy?.dirtyPaths.includes(path) &&
      !dirtyPolicy.approvedDirtyPaths.includes(path)
    )
      throw new Error("Pre-existing dirty path requires explicit approval");
    if (role === "tester") {
      if (
        !config.tester.mayModifyTests ||
        !config.tester.testPaths.some((prefix) => path.startsWith(prefix))
      )
        throw new Error("Tester may only modify configured test paths");
    } else if (!contractPaths(contract).includes(path))
      throw new Error(`Path not in implementation contract: ${path}`);
    if (name === "team_delete" && !contract?.filesToDelete.includes(path))
      throw new Error(
        "Deletion requires filesToDelete in the implementation contract",
      );
    // Cross-file rename/delete can exceed the contract: use explicit edit operations instead.
    if (["serena_rename_symbol", "serena_safe_delete_symbol"].includes(name))
      throw new Error("Cross-file mutation denied; use contract-scoped edits");
  }
}
