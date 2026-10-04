import { posix } from "node:path";

/** Identity for policy decisions only. Keep the caller's spelling for filesystem IO. */
export function policyPath(path: string): string {
  if (!path || path.includes("\0")) throw new Error("Invalid repository path");
  const slash = path.normalize("NFC").replace(/\\/g, "/");
  if (slash.startsWith("/") || /^[a-zA-Z]:/.test(slash))
    throw new Error("Absolute repository path denied");
  if (slash.split("/").includes(".."))
    throw new Error("Repository path traversal denied");
  const normalized = posix.normalize(slash);
  if (normalized === ".") throw new Error("Repository root is not a file");
  return normalized.toLowerCase();
}

export function isWithinPath(path: string, directory: string): boolean {
  const key = policyPath(path);
  const root = policyPath(directory.replace(/\/+$/, ""));
  return key.startsWith(`${root}/`);
}

export type PathPolicy = "normal" | "requires_user_approval" | "forbidden";
/** Conservative, component-boundary globs for trusted project configuration. */
export function permissionPattern(pattern: string): string {
  const key = policyPath(pattern);
  if (
    key.split("/").some((part) => part === ".git") ||
    [".pi", ".serena"].includes(key.split("/")[0]) ||
    key.split("/").some((part) => part === "*")
  )
    throw new Error(`Forbidden file permission pattern: ${pattern}`);
  if (/[?\[\]{}\0\r\n]/.test(key) || key.includes("**"))
    throw new Error("Only single-component * globs are supported");
  return key;
}

export function permissionPatternMatches(
  pattern: string,
  path: string,
): boolean {
  const parts = permissionPattern(pattern).split("/");
  const candidate = policyPath(path).split("/");
  return (
    parts.length === candidate.length &&
    parts.every((part, index) => {
      const expression = part
        .split("*")
        .map((piece) => piece.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join("[^/]*");
      return new RegExp(`^${expression}$`, "u").test(candidate[index]);
    })
  );
}
/** LLM-facing content reads use the same normalized path identity as writes. */
export function isSensitiveReadPath(path: string): boolean {
  const key = policyPath(path);
  const parts = key.split("/");
  const name = parts.at(-1) ?? "";
  return (
    classifyPath(path) === "forbidden" ||
    parts.some((part) => [".ssh", ".aws", ".gnupg"].includes(part)) ||
    parts.some((part) => part === ".env" || part.startsWith(".env.")) ||
    /^(?:id_rsa|id_ed25519|auth\.json|credentials(?:\..*)?)$/.test(name) ||
    /\.(?:pem|key|p12|pfx)$/.test(name)
  );
}
export function classifyPath(path: string): PathPolicy {
  const key = policyPath(path);
  const parts = key.split("/");
  const name = parts.at(-1);
  if (parts.includes(".git") || [".pi", ".serena"].includes(parts[0]))
    return "forbidden";
  if (
    (parts[0] === ".github" && parts[1] === "workflows") ||
    parts[0] === ".husky" ||
    key === ".vscode/tasks.json" ||
    [".gitmodules", ".gitattributes"].includes(key) ||
    parts.some((part) => [".ssh", ".aws", ".gnupg"].includes(part)) ||
    parts.some((part) => part === ".env" || part.startsWith(".env.")) ||
    /^(?:id_rsa|id_ed25519|auth\.json|credentials(?:\..*)?)$/.test(
      name ?? "",
    ) ||
    /\.(?:pem|key|p12|pfx)$/.test(name ?? "") ||
    [
      "package.json",
      "composer.json",
      "pyproject.toml",
      "cargo.toml",
      "makefile",
      "package-lock.json",
      "npm-shrinkwrap.json",
      "yarn.lock",
      "pnpm-lock.yaml",
      "composer.lock",
      "cargo.lock",
      "poetry.lock",
      "uv.lock",
      "bun.lock",
      "bun.lockb",
      "pipfile.lock",
      "gemfile.lock",
      "pdm.lock",
    ].includes(name ?? "")
  )
    return "requires_user_approval";
  return "normal";
}
