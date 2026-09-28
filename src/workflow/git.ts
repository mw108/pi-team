import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, lstat, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  assertRelative,
  assertWithin,
  contractPaths,
} from "../agents/permissions.ts";
import { contractSchema } from "../agents/schemas.ts";
import type { WorkflowState } from "./state.ts";
const exec = promisify(execFile);
export async function git(cwd: string, args: string[]) {
  return (
    await exec("git", args, {
      cwd,
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    })
  ).stdout;
}
export async function head(cwd: string) {
  try {
    return (await git(cwd, ["rev-parse", "HEAD"])).trim();
  } catch {
    return null;
  }
}
export async function dirtyPaths(cwd: string) {
  const status = await git(cwd, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
  ]);
  const entries = status.split("\0");
  const paths: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (!entry) continue;
    paths.push(entry.slice(3));
    if (/[RC]/.test(entry.slice(0, 2))) paths.push(entries[++i]);
  }
  return [...new Set(paths.filter(Boolean))];
}
export async function baseline(cwd: string) {
  const canonical = await realpath(cwd);
  await git(cwd, ["rev-parse", "--show-toplevel"]).then((root) => {
    if (root.trim() !== canonical)
      throw new Error("Start /team at the Git repository root");
  });
  return {
    head: await head(cwd),
    dirtyPaths: await dirtyPaths(cwd),
    status: await git(cwd, ["status", "--short"]),
    diff: await git(cwd, ["diff", "--no-ext-diff"]),
    cachedDiff: await git(cwd, ["diff", "--cached", "--no-ext-diff"]),
  };
}
export async function actualDiff(cwd: string) {
  let diff = await git(cwd, [
    "diff",
    "--no-ext-diff",
    "HEAD",
    "--",
    ".",
    ":(exclude).pi/team/**",
  ]).catch(() =>
    git(cwd, ["diff", "--no-ext-diff", "--", ".", ":(exclude).pi/team/**"]),
  );
  const untracked = (
    await git(cwd, ["ls-files", "--others", "--exclude-standard", "-z"])
  )
    .split("\0")
    .filter((path) => Boolean(path) && !path.startsWith(".pi/team/"));
  for (const path of untracked) {
    assertRelative(path);
    await assertWithin(cwd, path);
    const stat = await lstat(join(cwd, path));
    if (stat.isSymbolicLink())
      throw new Error("Untracked symlink requires user review");
    if (stat.size > 200000)
      throw new Error(`Untracked file too large to review: ${path}`);
    diff += `\nNEW FILE ${path}\n${await readFile(join(cwd, path), "utf8")}`;
  }
  if (diff.length > 300000)
    throw new Error("Diff too large for automatic review; split the task");
  return diff;
}
export async function hashes(cwd: string, paths: string[]) {
  const result: Record<string, string> = {};
  for (const path of paths) {
    if (path.startsWith(".pi/team/")) continue;
    assertRelative(path);
    await assertWithin(cwd, path);
    try {
      const stat = await lstat(join(cwd, path));
      if (!stat.isFile())
        throw new Error("Only regular files may be committed automatically");
      result[path] = createHash("sha256")
        .update(await readFile(join(cwd, path)))
        .digest("hex");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT")
        result[path] = "DELETED";
      else throw e;
    }
  }
  return result;
}
export function gitInspectTool(cwd: string): ToolDefinition {
  return {
    name: "team_git_inspect",
    label: "Inspect Git",
    description: "Read repository status and actual tracked/untracked diff.",
    parameters: Type.Object({}),
    async execute() {
      const info = {
        status: await git(cwd, ["status", "--short"]),
        diff: await actualDiff(cwd),
        staged: await git(cwd, ["diff", "--cached", "--no-ext-diff"]),
      };
      return {
        content: [{ type: "text", text: JSON.stringify(info) }],
        details: {},
      };
    },
  };
}
export async function prepareCommit(
  s: WorkflowState,
  files: string[],
  message: string,
) {
  if (
    s.config.qualityGates.codeReview.enabled &&
    (s.results.codeReviewer as any)?.status !== "APPROVED"
  )
    throw new Error("Code review has not passed");
  if (
    s.config.qualityGates.testing.enabled &&
    (s.results.tester as any)?.status !== "PASS"
  )
    throw new Error("Testing has not passed");
  if (
    s.config.qualityGates.pentest.enabled &&
    (!s.results.securityReviewer ||
      (s.results.securityReviewer as any).findings.some(
        (f: any) =>
          f.classification === "CONFIRMED" ||
          f.classification === "ACCEPTED_RISK",
      ))
  )
    throw new Error("Security gate has not passed");
  if ((await head(s.cwd)) !== s.baseline.head)
    throw new Error("Git HEAD changed since workflow start");
  const contract = contractSchema.parse(s.results.reviewer),
    allowed = contractPaths(contract),
    dirty = await dirtyPaths(s.cwd);
  if (
    s.gateHashes &&
    JSON.stringify(await hashes(s.cwd, dirty)) !== JSON.stringify(s.gateHashes)
  )
    throw new Error("Reviewed files changed before commit");
  if (!files.length || new Set(files).size !== files.length)
    throw new Error("Commit files must be unique and nonempty");
  for (const path of files) {
    assertRelative(path);
    if (
      !allowed.includes(path) ||
      s.baseline.dirtyPaths.includes(path) ||
      !dirty.includes(path)
    )
      throw new Error(`Cannot safely attribute commit path: ${path}`);
  }
  const produced = dirty.filter(
    (p) => !s.baseline.dirtyPaths.includes(p) && !p.startsWith(".pi/team/"),
  );
  if (produced.some((p) => !files.includes(p)))
    throw new Error(
      "Commit excludes workflow changes or includes unexpected generated files",
    );
  if ((await git(s.cwd, ["diff", "--cached", "--name-only"])).trim())
    throw new Error("Existing staged changes prevent automatic commit");
  for (const path of files) {
    if (/(^|\/)(\.env(?:\..*)?|auth\.json|.*\.(pem|key)|id_rsa)$/.test(path))
      throw new Error("Credential-like file denied");
    try {
      const content = await readFile(join(s.cwd, path), "utf8");
      if (
        /-----BEGIN .*PRIVATE KEY-----|(?:sk-proj-|ctx7sk-)[A-Za-z0-9_-]{10,}|(?:api[_-]?key|password|secret)\s*[:=]\s*["'][^"']{12,}["']/i.test(
          content,
        )
      )
        throw new Error(`Potential secret in ${path}`);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
  return {
    head: s.baseline.head,
    files,
    message,
    hashes: await hashes(s.cwd, files),
  };
}
export async function createCommit(s: WorkflowState) {
  const intent = s.commitIntent;
  if (!intent) throw new Error("No commit intent");
  // Revalidate gates and baseline attribution immediately before staging, even
  // when called independently or after preparing a persisted intent.
  await prepareCommit(s, intent.files, intent.message);
  if ((await head(s.cwd)) !== intent.head)
    throw new Error("HEAD changed; inspect commit recovery manually");
  if (
    JSON.stringify(await hashes(s.cwd, intent.files)) !==
    JSON.stringify(intent.hashes)
  )
    throw new Error("Files changed after commit preparation");
  await git(s.cwd, ["add", "--", ...intent.files]);
  const staged = (await git(s.cwd, ["diff", "--cached", "--name-only", "-z"]))
    .split("\0")
    .filter(Boolean);
  if (
    staged.some((p) => !intent.files.includes(p)) ||
    intent.files.some((p) => !staged.includes(p))
  )
    throw new Error("Staged changes do not match commit intent");
  await git(s.cwd, [
    ...(s.config.commit.runHooks ? [] : ["-c", "core.hooksPath=/dev/null"]),
    "commit",
    "-m",
    intent.message,
  ]);
  const hash = await head(s.cwd);
  if (!hash) throw new Error("Commit hash unavailable");
  return { hash, files: intent.files };
}
