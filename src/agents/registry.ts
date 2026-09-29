import { readFile, realpath, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import type { Role } from "./schemas.ts";
import type { TeamConfig } from "../config/schema.ts";
import { contained, promptPath, teamRoot } from "../config/project.ts";
export function digest(content: string) {
  return createHash("sha256").update(content).digest("hex");
}
export async function rolePrompt(root: string, config: TeamConfig, slot: Role) {
  const definition = config.agents[slot];
  if (!definition) throw new Error(`Missing required agent: ${slot}`);
  if (slot === "reporter" && definition.prompt === "agents/reporter-compat.md")
    return readFile(
      new URL("../../templates/agents/reporter.md", import.meta.url),
      "utf8",
    );
  const path = promptPath(root, definition.prompt),
    base = teamRoot(root);
  let actual: string;
  try {
    actual = await realpath(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw new Error(
        `Missing agent prompt for "${slot}": .pi/team/${definition.prompt}. Run /team-init --repair or create the file manually.`,
      );
    throw error;
  }
  const realBase = await realpath(base);
  if (!contained(await realpath(root), realBase))
    throw new Error("Project team directory escapes repository");
  if (!contained(realBase, actual))
    throw new Error(
      `Agent prompt symlink escapes .pi/team: ${definition.prompt}`,
    );
  if (!(await stat(actual)).isFile())
    throw new Error(`Agent prompt is not a regular file: ${definition.prompt}`);
  const content = await readFile(actual, "utf8");
  if (!content.trim())
    throw new Error(`Agent prompt is empty: ${definition.prompt}`);
  return content;
}
export async function promptHashes(root: string, config: TeamConfig) {
  const result: Record<string, string> = {};
  for (const slot of Object.keys(config.agents) as Role[])
    result[slot] = digest(await rolePrompt(root, config, slot));
  return result;
}
