import { realpath, lstat, stat } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  relative,
  resolve,
  join,
} from "node:path";
import {
  classifyPath,
  isSensitiveReadPath,
  policyPath,
  isWithinPath,
  permissionPatternMatches,
} from "./path-policy.ts";
import { createHash } from "node:crypto";
import type { Role, Contract } from "./schemas.ts";
import type { TeamConfig } from "../config/schema.ts";
import type { WorkflowState } from "../workflow/state.ts";
import { getActiveSolverIds } from "../config/solvers.ts";
import { serenaCapability, serenaRead, serenaWrite } from "./serena-policy.ts";
export { serenaRead, serenaWrite } from "./serena-policy.ts";
const docsRoles: Role[] = [
  "researcher",
  "reviewer",
  "implementor",
  "codeReviewer",
  "securityReviewer",
];
export function allowedTools(role: Role, config: TeamConfig) {
  const tools =
    role === "orchestrator" || role === "reporter"
      ? []
      : ["read", "grep", "find", "ls"];
  if (
    role === "implementor" ||
    (role === "tester" && config.tester.mayModifyTests)
  )
    tools.push("edit", "write");
  if (role === "implementor") tools.push("team_delete");
  if (
    role === "implementor" ||
    (role === "tester" && config.tester.mayModifyTests)
  )
    tools.push("team_request_contract_path");
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
  if (
    config.integrations.context7.enabled &&
    (docsRoles.includes(role) ||
      getActiveSolverIds(config).includes(role as any))
  )
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
export type ContractOperation = "create" | "modify" | "delete";
export function isContractOperationAllowed(
  contract: Contract | undefined,
  path: string,
  operation: ContractOperation,
): boolean {
  if (!contract) return false;
  switch (operation) {
    case "create":
      return contract.filesToCreate.includes(path);
    case "modify":
      return contract.filesToModify.includes(path);
    case "delete":
      return contract.filesToDelete.includes(path);
  }
}
export type ContractPathApproval = {
  path: string;
  operation: ContractOperation;
};
export function effectiveContractPaths(
  contract: Contract | undefined,
  approvals: ContractPathApproval[] = [],
) {
  return [
    ...new Set([...contractPaths(contract), ...approvals.map((a) => a.path)]),
  ];
}
export function workflowScopePaths(s: WorkflowState): string[] {
  return [
    ...new Set([
      ...effectiveContractPaths(
        s.results.reviewer as Contract | undefined,
        s.workflowApprovedContractPaths,
      ),
      ...s.completedOneShotContractPaths,
    ]),
  ];
}
export function contractIdentity(contract: Contract): string {
  return createHash("sha256").update(JSON.stringify(contract)).digest("hex");
}
export function assertRelative(path: string) {
  if (classifyPath(path) === "forbidden")
    throw new Error(`Path outside approved source boundary: ${path}`);
}
export async function assertWithin(cwd: string, path: string) {
  policyPath(path);
  const root = await realpath(cwd);
  let target = resolve(root, path);
  const missing: string[] = [];
  const lexical = relative(root, target);
  if (lexical.startsWith("..") || isAbsolute(lexical))
    throw new Error("Path escapes repository");
  while (true) {
    try {
      const actual = await realpath(target);
      const r = relative(root, resolve(actual, ...missing));
      if (r.startsWith("..") || isAbsolute(r))
        throw new Error("Symlink escapes repository");
      return r;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      try {
        if ((await lstat(target)).isSymbolicLink())
          throw new Error("Unresolved repository symlink denied");
      } catch (linkError) {
        if ((linkError as NodeJS.ErrnoException).code !== "ENOENT")
          throw linkError;
      }
      const parent = dirname(target);
      if (parent === target) throw e;
      missing.unshift(basename(target));
      target = parent;
    }
  }
}
export async function validateContractPathRequest(cwd: string, path: string) {
  assertRelative(path);
  const key = policyPath(path);
  if (key !== path || /[?*\[\]]/.test(path))
    throw new Error(
      "Contract approval requires an exact normalized repository-relative path",
    );
  const actual = await assertWithin(cwd, path);
  if (policyPath(actual) !== key || classifyPath(path) === "forbidden")
    throw new Error(
      "Contract path is outside the approved repository boundary",
    );
  return key;
}
export async function validateContractPaths(cwd: string, contract: Contract) {
  for (const path of contractPaths(contract)) {
    assertRelative(path);
    const actual = await assertWithin(cwd, path);
    if (policyPath(actual) !== policyPath(path))
      throw new Error(`Contract path aliases another repository path: ${path}`);
  }
  for (const path of [
    ...contract.requiredTests.flatMap((test) => (test.file ? [test.file] : [])),
  ]) {
    assertRelative(path);
    await assertWithin(cwd, path);
  }
}
export async function checkTool(
  role: Role,
  name: string,
  input: Record<string, unknown>,
  cwd: string,
  config: TeamConfig,
  contract?: Contract,
  dirtyPolicy?: {
    dirtyPaths: string[];
    approvedDirtyPaths: string[];
    approvedSensitivePaths?: string[];
    authorizeSensitive?: (
      operation: "read" | "write",
      path: string,
    ) => Promise<boolean>;
    workflowContractApprovals?: ContractPathApproval[];
    consumeContractOnce?: (
      operation: ContractOperation,
      path: string,
    ) => boolean;
  },
) {
  const serenaScope = name.startsWith("serena_")
    ? serenaCapability(name)
    : undefined;
  if (serenaScope === "unknown")
    throw new Error(
      "Access denied: Serena operation may expose sensitive repository content.",
    );
  if (!allowedTools(role, config).includes(name))
    throw new Error(`Tool ${name} denied for ${role}`);
  if (
    name.startsWith("serena_") &&
    input.project &&
    resolve(String(input.project)) !== resolve(cwd)
  )
    throw new Error("Serena project override denied");
  if (serenaScope === "mutation")
    throw new Error("Access denied: Serena mutation is not permitted.");
  if (
    serenaScope === "cross-file-results" ||
    serenaScope === "unbounded-content"
  )
    throw new Error(
      "Access denied: Serena operation may expose sensitive repository content.",
    );
  if (
    serenaScope === "file-read" &&
    (typeof input.relative_path !== "string" || !input.relative_path)
  )
    throw new Error(
      "Access denied: Serena requires a specific non-sensitive file.",
    );
  if (name === "grep" && typeof input.path !== "string")
    throw new Error(
      "Access denied: grep requires a specific non-sensitive file.",
    );
  const path =
    name === "team_request_contract_path"
      ? undefined
      : serenaScope
        ? input.relative_path
        : input.path;
  let actualPath: string | undefined;
  if (typeof path === "string") {
    actualPath = await assertWithin(cwd, path);
    if (
      classifyPath(path) === "forbidden" ||
      classifyPath(actualPath) === "forbidden"
    )
      throw new Error("Protected repository path is private");
    if (name === "grep" && (await stat(join(cwd, actualPath))).isDirectory())
      throw new Error(
        "Access denied: grep requires a specific non-sensitive file.",
      );
  }
  const mutation = ["write", "edit", "team_delete", ...serenaWrite].includes(
    name,
  );
  if (mutation) {
    if (typeof path !== "string")
      throw new Error("Mutation requires an explicit repository path");
    assertRelative(path);
    if (policyPath(actualPath!) !== policyPath(path))
      throw new Error("Mutation through repository path alias denied");
    if (
      dirtyPolicy?.dirtyPaths.includes(path) &&
      !dirtyPolicy.approvedDirtyPaths.includes(path)
    )
      throw new Error("Pre-existing dirty path requires explicit approval");
    const operation: ContractOperation =
      name === "team_delete"
        ? "delete"
        : name === "edit"
          ? "modify"
          : await stat(join(cwd, actualPath!)).then(
              () => "modify" as const,
              (error: NodeJS.ErrnoException) => {
                if (error.code !== "ENOENT") throw error;
                return "create" as const;
              },
            );
    if (role === "tester") {
      if (
        !config.tester.mayModifyTests ||
        !config.tester.testPaths.some((prefix) => isWithinPath(path, prefix))
      )
        throw new Error("Tester may only modify configured test paths");
    }
    const inContract = isContractOperationAllowed(contract, path, operation);
    const approved = dirtyPolicy?.workflowContractApprovals?.some(
      (item) => item.operation === operation && item.path === path,
    );
    if (
      !inContract &&
      !approved &&
      !dirtyPolicy?.consumeContractOnce?.(operation, path)
    )
      throw new Error(
        `Path not in implementation contract: ${path}. Call team_request_contract_path with the path, ${operation} operation, and a concise reason before retrying.`,
      );
    // Cross-file rename/delete can exceed the contract: use explicit edit operations instead.
    if (["serena_rename_symbol", "serena_safe_delete_symbol"].includes(name))
      throw new Error("Cross-file mutation denied; use contract-scoped edits");
  }
  if (typeof path === "string" && actualPath) {
    const operation = mutation ? "write" : "read";
    const sensitive = mutation
      ? classifyPath(actualPath) === "requires_user_approval"
      : (["read", "grep"].includes(name) || serenaScope === "file-read") &&
        (isSensitiveReadPath(path) || isSensitiveReadPath(actualPath));
    if (sensitive) {
      const key = policyPath(actualPath);
      const configured = (
        operation === "read"
          ? config.permissions.files.allowRead
          : config.permissions.files.allowWrite
      ).some((pattern) => permissionPatternMatches(pattern, key));
      const legacy =
        operation === "write" &&
        dirtyPolicy?.approvedSensitivePaths?.includes(key);
      if (
        !configured &&
        !legacy &&
        !(await dirtyPolicy?.authorizeSensitive?.(operation, key))
      )
        throw new Error(
          `Sensitive path is classified as sensitive; ${operation} authorization denied for ${key}`,
        );
    }
    if (
      serenaScope === "file-read" &&
      !(await stat(join(cwd, actualPath))).isFile()
    )
      throw new Error("Access denied: Serena requires a specific file.");
  }
}
