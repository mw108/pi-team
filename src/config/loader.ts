import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import YAML from "yaml";
import { configSchema } from "./schema.ts";
export function agentDir() {
  return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}
export async function loadConfig(cwd: string) {
  const candidates = process.env.PI_TEAM_CONFIG
    ? [process.env.PI_TEAM_CONFIG]
    : [join(cwd, ".pi", "team.yaml"), join(agentDir(), "team.yaml")];
  for (const path of candidates) {
    let source: string;
    try {
      source = await readFile(path, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw e;
    }
    return { path, config: configSchema.parse(YAML.parse(source)) };
  }
  throw new Error(
    "No team configuration. Copy config/team.example.yaml to .pi/team.yaml and set real provider/model IDs.",
  );
}
