import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, lstat, realpath, unlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  assertRelative,
  contractIdentity,
  assertWithin,
  contractPaths,
  workflowScopePaths,
} from "../agents/permissions.ts";
import { contractSchema } from "../agents/schemas.ts";
import {
  classifyPath,
  isSensitiveReadPath,
  policyPath,
  permissionPatternMatches,
} from "../agents/path-policy.ts";
import { scanCommitSecrets } from "../security/secret-scan.ts";
import { redactVisibleText } from "../agents/redaction.ts";
import type { WorkflowState } from "./state.ts";
import { classifyCommitPaths, isNonCommittablePath } from "./commit-paths.ts";
import { matchingSecurityRiskReview } from "./security-risk-review.ts";
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
    // Dirty-path metadata is enough for attribution. Raw pre-existing user
    // diffs must not be persisted or sent to a provider.
    diff: "",
    cachedDiff: "",
  };
}
export async function providerDiff(s: WorkflowState): Promise<string> {
  const contract = s.results.reviewer
    ? contractSchema.safeParse(s.results.reviewer)
    : undefined;
  const paths = [
    ...new Set([
      ...(contract?.success ? workflowScopePaths(s) : []),
      ...s.approvedDirtyPaths,
    ]),
  ].filter((path) => !isSensitiveReadPath(path));
  if (!paths.length) return "";
  for (const path of paths) {
    assertRelative(path);
    if (isSensitiveReadPath(await assertWithin(s.cwd, path)))
      throw new Error("Provider diff contains a sensitive path alias");
  }
  let diff = await git(s.cwd, [
    "diff",
    "--no-ext-diff",
    "HEAD",
    "--",
    ...paths,
  ]);
  const untracked = new Set(
    (await git(s.cwd, ["ls-files", "--others", "--exclude-standard", "-z"]))
      .split("\0")
      .filter(Boolean),
  );
  for (const path of paths) {
    if (!untracked.has(path)) continue;
    const stat = await lstat(join(s.cwd, path));
    if (!stat.isFile() || stat.size > 200000)
      throw new Error("Untracked review file requires manual inspection");
    diff += `\nNEW FILE ${path}\n${await readFile(join(s.cwd, path), "utf8")}`;
  }
  if (diff.length > 300000)
    throw new Error("Diff too large for automatic review");
  return redactVisibleText(diff);
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
/** Gate contents are the contract, pre-existing dirty files, and files already reviewed. */
export async function gateSnapshot(s: WorkflowState) {
  const contract = s.results.reviewer
    ? contractSchema.safeParse(s.results.reviewer)
    : undefined;
  const paths = [
    ...new Set([
      ...Object.keys(s.gateHashes ?? {}),
      ...s.baseline.dirtyPaths,
      ...(contract?.success ? workflowScopePaths(s) : []),
    ]),
  ];
  return hashes(s.cwd, paths.sort());
}

/** Only a narrow set of known, untracked command outputs is excluded. */
export async function runtimeArtifacts(cwd: string): Promise<Set<string>> {
  const untracked = (
    await git(cwd, ["ls-files", "--others", "--exclude-standard", "-z"])
  )
    .split("\0")
    .filter(Boolean);
  return new Set(untracked.filter((path) => path === ".phpunit.result.cache"));
}
export async function unexpectedWorkflowPaths(
  s: WorkflowState,
): Promise<string[]> {
  const contract = s.results.reviewer
    ? contractSchema.safeParse(s.results.reviewer)
    : undefined;
  const allowed = new Set([
    ...s.baseline.dirtyPaths,
    ...(contract?.success ? workflowScopePaths(s) : []),
  ]);
  const artifacts = await runtimeArtifacts(s.cwd);
  return (await dirtyPaths(s.cwd)).filter(
    (path) =>
      !path.startsWith(".pi/team/") &&
      !allowed.has(path) &&
      !artifacts.has(path),
  );
}
type DiscardEvidence = NonNullable<WorkflowState["priorImplementation"]>;
export async function classifyAttributedImplementation(
  s: WorkflowState,
  prior: DiscardEvidence | undefined,
  scope: "orphan" | "interrupted",
) {
  if (!prior) return { discardable: [] as string[], ambiguous: [] as string[] };
  const allowed =
    scope === "orphan"
      ? new Set(workflowScopePaths(s).map(policyPath))
      : new Set<string>();
  const baseline = new Set(s.baseline.dirtyPaths.map(policyPath));
  const artifacts =
    scope === "orphan" ? await runtimeArtifacts(s.cwd) : new Set<string>();
  const dirty = await dirtyPaths(s.cwd);
  const candidates = dirty.filter(
    (path) =>
      !path.startsWith(".pi/team/") &&
      (!baseline.has(policyPath(path)) ||
        (scope === "orphan"
          ? Object.hasOwn(prior.hashes, path)
          : s.observedImplementorMutations.some(
              (mutation) =>
                mutation.attempt === prior.attempt &&
                mutation.identity === policyPath(path),
            ))) &&
      !allowed.has(policyPath(path)) &&
      !artifacts.has(path),
  );
  const current: Record<string, string> = {};
  for (const path of candidates) {
    try {
      Object.assign(current, await hashes(s.cwd, [path]));
    } catch {
      // Non-regular files and unsafe path aliases remain ambiguous.
    }
  }
  const staged = new Set(
    (await git(s.cwd, ["diff", "--cached", "--name-only", "-z"]))
      .split("\0")
      .filter(Boolean)
      .map(policyPath),
  );
  const untracked = new Set(
    (await git(s.cwd, ["ls-files", "--others", "--exclude-standard", "-z"]))
      .split("\0")
      .filter(Boolean),
  );
  const headUnchanged = (await head(s.cwd)) === s.baseline.head;
  const observed = new Set(
    s.observedImplementorMutations
      .filter((mutation) => mutation.attempt === prior.attempt)
      .map((mutation) => mutation.identity),
  );
  const discardable = candidates.filter(
    (path) =>
      headUnchanged &&
      !baseline.has(policyPath(path)) &&
      prior.discardablePaths.includes(path) &&
      observed.has(policyPath(path)) &&
      Object.hasOwn(current, path) &&
      Object.hasOwn(prior.hashes, path) &&
      prior.hashes[path] === current[path] &&
      !staged.has(policyPath(path)) &&
      prior.createdPaths.includes(path) === untracked.has(path),
  );
  const safe = new Set(discardable);
  return {
    discardable,
    ambiguous: candidates.filter((path) => !safe.has(path)),
  };
}
export function classifyOrphanedImplementation(s: WorkflowState) {
  return classifyAttributedImplementation(s, s.priorImplementation, "orphan");
}
export async function discardAttributedImplementation(
  s: WorkflowState,
  paths: string[],
  evidence: DiscardEvidence,
) {
  for (const path of paths) {
    assertRelative(path);
    await assertWithin(s.cwd, path);
    if (evidence.createdPaths.includes(path)) await unlink(join(s.cwd, path));
    else
      await git(s.cwd, ["restore", "--source=HEAD", "--worktree", "--", path]);
  }
}
export function gitInspectTool(s: WorkflowState): ToolDefinition {
  return {
    name: "team_git_inspect",
    label: "Inspect Git",
    description: "Read repository status and actual tracked/untracked diff.",
    parameters: Type.Object({}),
    async execute() {
      const info = {
        status: redactVisibleText(await git(s.cwd, ["status", "--short"])),
        diff: await providerDiff(s),
      };
      return {
        content: [{ type: "text", text: JSON.stringify(info) }],
        details: {},
      };
    },
  };
}
/** Repository and contract evidence, never LLM output, determines staging paths. */
export async function determineAuthoritativeCommitSelection(s: WorkflowState) {
  const unexpected = await unexpectedWorkflowPaths(s);
  if (unexpected.length)
    throw new Error(
      `Repository contains changes outside the Implementation Contract: ${unexpected.join(", ")}`,
    );
  const allowed = new Set(workflowScopePaths(s));
  const baselineDirty = new Set(s.baseline.dirtyPaths);
  const visible = (await dirtyPaths(s.cwd)).filter(
    (path) => allowed.has(path) && !baselineDirty.has(path),
  );
  // Git status omits ignored local-only files. Compare host snapshots taken
  // immediately before implementation to include those workflow changes.
  const excludedContractPaths = [...allowed].filter((path) =>
    isNonCommittablePath(s.config, path),
  );
  const currentExcluded = await hashes(s.cwd, excludedContractPaths);
  const changedExcluded = excludedContractPaths.filter(
    (path) =>
      (s.implementationStartHashes?.[path] !== undefined &&
        s.implementationStartHashes[path] !== currentExcluded[path]) ||
      s.observedImplementorMutations.some((mutation) => mutation.path === path),
  );
  const workflowPaths = [...new Set([...visible, ...changedExcluded])].sort();
  const selection = classifyCommitPaths(s.config, workflowPaths);
  // Apply all commit safety checks, including secret scanning, before the model
  // sees the selection. prepareCommit repeats them after message generation.
  await prepareCommit(
    s,
    selection.commitPaths,
    "commit selection validation",
    true,
  );
  return selection;
}
export async function prepareCommit(
  s: WorkflowState,
  files: string[],
  message: string,
  allowEmpty = false,
) {
  if (
    s.config.qualityGates.codeReview.enabled &&
    s.results.codeReviewer?.status !== "APPROVED"
  )
    throw new Error("Code review has not passed");
  if (
    s.config.qualityGates.testing.enabled &&
    s.results.tester?.status !== "PASS"
  )
    throw new Error("Testing has not passed");
  if (
    !s.results.securityReviewer ||
    s.results.securityReviewer.findings.some(
      (f) =>
        f.classification === "CONFIRMED" ||
        (f.classification === "ACCEPTED_RISK" &&
          !(
            s.securityRiskReview?.status === "accepted" &&
            matchingSecurityRiskReview(s)
          )),
    )
  )
    throw new Error("Security gate has not passed");
  if ((await head(s.cwd)) !== s.baseline.head)
    throw new Error("Git HEAD changed since workflow start");
  const contract = contractSchema.parse(s.results.reviewer),
    allowed = workflowScopePaths(s),
    dirty = await dirtyPaths(s.cwd);
  const writeAuthorized = (path: string) =>
    s.config.permissions.files.allowWrite.some((pattern) =>
      permissionPatternMatches(pattern, path),
    ) ||
    s.runtimeFileApprovals.some(
      (grant) =>
        grant.role === "implementor" &&
        grant.operation === "write" &&
        grant.path === policyPath(path),
    ) ||
    (s.sensitiveApprovalContractHash === contractIdentity(contract) &&
      s.approvedSensitivePaths.includes(policyPath(path)));
  for (const path of allowed) {
    assertRelative(path);
    if (policyPath(await assertWithin(s.cwd, path)) !== policyPath(path))
      throw new Error(`Commit path aliases another repository path: ${path}`);
    if (
      classifyPath(path) === "requires_user_approval" &&
      !writeAuthorized(path)
    )
      throw new Error(`Sensitive path approval missing: ${path}`);
  }
  if (
    s.gateHashes &&
    JSON.stringify(await gateSnapshot(s)) !== JSON.stringify(s.gateHashes)
  )
    throw new Error("Reviewed files changed before commit");
  const unexpected = await unexpectedWorkflowPaths(s);
  if (unexpected.length)
    throw new Error(
      `Repository contains changes outside the Implementation Contract: ${unexpected.join(", ")}`,
    );
  if ((!files.length && !allowEmpty) || new Set(files).size !== files.length)
    throw new Error("Commit files must be unique and nonempty");
  for (const path of files) {
    assertRelative(path);
    if (isNonCommittablePath(s.config, path))
      throw new Error(`Non-committable path cannot be staged: ${path}`);
    if (
      !allowed.includes(path) ||
      s.baseline.dirtyPaths.includes(path) ||
      !dirty.includes(path)
    )
      throw new Error(`Cannot safely attribute commit path: ${path}`);
  }
  const artifacts = await runtimeArtifacts(s.cwd);
  const produced = dirty.filter(
    (p) =>
      !s.baseline.dirtyPaths.includes(p) &&
      !p.startsWith(".pi/team/") &&
      !isNonCommittablePath(s.config, p) &&
      !(artifacts.has(p) && !allowed.includes(p)),
  );
  const missing = produced.filter((path) => !files.includes(path));
  if (missing.length)
    throw new Error(
      `Commit selection no longer matches repository changes: ${missing.join(", ")}`,
    );
  if ((await git(s.cwd, ["diff", "--cached", "--name-only"])).trim())
    throw new Error("Existing staged changes prevent automatic commit");
  for (const path of files) {
    if (
      /(^|\/)(\.env(?:\..*)?|auth\.json|.*\.(pem|key)|id_rsa)$/.test(path) &&
      !/(^|\/)\.env\.example$/.test(path)
    )
      throw new Error("Credential-like file denied");
  }
  const scan = await scanCommitSecrets(s.cwd, files);
  if (scan.findings.length) {
    const finding = scan.findings[0];
    throw new Error(
      `Commit blocked: possible ${finding.kind} in ${redactVisibleText(finding.path)}${finding.line ? `:${finding.line}` : ""} (${scan.scanner})`,
    );
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
  if (!intent.files.length) throw new Error("Empty commit intent denied");
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
  return { hash, files: intent.files, message: intent.message };
}
