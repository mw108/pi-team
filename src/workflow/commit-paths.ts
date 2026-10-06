import { posix } from "node:path";
import { policyPath } from "../agents/path-policy.ts";
import type { TeamConfig } from "../config/schema.ts";

export const defaultNonCommittablePaths = [".env", ".env.testing"] as const;

/** Configured paths add to, and cannot remove, the local-only defaults. */
export function nonCommittablePaths(config: TeamConfig): string[] {
  return [
    ...new Set(
      [...defaultNonCommittablePaths, ...config.commit.excludePaths].map(
        policyPath,
      ),
    ),
  ];
}

export function isNonCommittablePath(
  config: TeamConfig,
  path: string,
): boolean {
  return nonCommittablePaths(config).includes(policyPath(path));
}

export function classifyCommitPaths(config: TeamConfig, proposed: string[]) {
  if (!proposed.length)
    throw new Error("Commit files must be unique and nonempty");
  const excluded = new Set(nonCommittablePaths(config));
  const normalized = proposed.map((path) => {
    policyPath(path); // Reject traversal and absolute paths before normalization.
    return posix.normalize(path.normalize("NFC").replace(/\\/g, "/"));
  });
  if (new Set(normalized.map(policyPath)).size !== normalized.length)
    throw new Error("Commit files must be unique and nonempty");
  return {
    requestedPaths: [...proposed],
    excludedPaths: normalized.filter((path) => excluded.has(policyPath(path))),
    commitFiles: normalized.filter((path) => !excluded.has(policyPath(path))),
  };
}
