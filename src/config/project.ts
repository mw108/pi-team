import { realpath } from "node:fs/promises";
import { resolve, relative, isAbsolute, join } from "node:path";
import { execFile } from "node:child_process";
import { execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { realpathSync } from "node:fs";
const exec = promisify(execFile);
export async function projectRoot(cwd: string) {
  const canonical = await realpath(cwd);
  try {
    return await realpath(
      (
        await exec("git", ["rev-parse", "--show-toplevel"], {
          cwd: canonical,
          env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
          timeout: 10000,
        })
      ).stdout.trim(),
    );
  } catch {
    return canonical;
  }
}
export function projectRootSync(cwd: string) {
  const canonical = realpathSync(cwd);
  try {
    return realpathSync(
      execFileSync("git", ["rev-parse", "--show-toplevel"], {
        cwd: canonical,
        encoding: "utf8",
        timeout: 10000,
        stdio: ["ignore", "pipe", "ignore"],
      }).trim(),
    );
  } catch {
    return canonical;
  }
}
export function teamRoot(root: string) {
  return join(root, ".pi", "team");
}
export function contained(parent: string, child: string) {
  const path = relative(parent, child);
  return path !== "" && !path.startsWith("..") && !isAbsolute(path);
}
export function promptPath(root: string, value: string) {
  if (
    !value ||
    isAbsolute(value) ||
    value.includes("\\") ||
    value.split("/").some((part) => !part || part === "." || part === "..") ||
    value.includes("\0") ||
    !value.endsWith(".md")
  )
    throw new Error(`Invalid agent prompt path: ${value}`);
  const base = teamRoot(root),
    target = resolve(base, value);
  if (!contained(base, target))
    throw new Error(`Agent prompt escapes .pi/team: ${value}`);
  return target;
}
