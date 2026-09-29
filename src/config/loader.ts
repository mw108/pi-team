import { readFile, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import YAML from "yaml";
import { configSchema, type TeamConfig } from "./schema.ts";
import { contained, projectRoot, teamRoot } from "./project.ts";
import { digest, promptHashes } from "../agents/registry.ts";
function compatibleConfig(source: string): TeamConfig {
  const value = YAML.parse(source, { uniqueKeys: true });
  if (value?.agents && !value.agents.reporter && value.agents.orchestrator) {
    value.agents.reporter = {
      role: "reporter",
      prompt: "agents/reporter-compat.md",
      provider: value.agents.orchestrator.provider,
      model: value.agents.orchestrator.model,
      temperature: 0.1,
      thinking: "off",
      timeoutMs: 600000,
    };
  }
  return configSchema.parse(value);
}
export function agentDir() {
  return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}
export function legacyGlobalConfig() {
  return join(agentDir(), "team.yaml");
}
export interface TeamDefinition {
  path: string;
  config: TeamConfig;
  configHash: string;
  agentPromptHashes: Record<string, string>;
}
export async function loadConfig(cwd: string): Promise<TeamDefinition> {
  const root = await projectRoot(cwd),
    base = teamRoot(root);
  const path = process.env.PI_TEAM_CONFIG
    ? resolve(root, process.env.PI_TEAM_CONFIG)
    : join(base, "team.yaml");
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw new Error(
        `No Pi Team configuration found. Expected: ${join(base, "team.yaml")}. Run /team-init to initialize this repository. Legacy global config is never used automatically.`,
      );
    throw error;
  }
  try {
    const realRoot = await realpath(root),
      realBase = await realpath(base);
    if (!contained(realRoot, realBase))
      throw new Error("Project .pi/team symlink escapes the repository");
    if (
      !process.env.PI_TEAM_CONFIG &&
      !contained(realBase, await realpath(path))
    )
      throw new Error("Project team.yaml symlink escapes .pi/team");
    const config = compatibleConfig(source);
    return {
      path,
      config,
      configHash: digest(source),
      agentPromptHashes: await promptHashes(root, config),
    };
  } catch (error) {
    throw new Error(
      `Invalid Pi Team configuration or prompts at ${path}: ${String(error)}`,
    );
  }
}
export async function snapshotDefinition(
  root: string,
  config: TeamConfig,
  path?: string,
) {
  const actual = path ?? join(teamRoot(root), "team.yaml");
  const source = await readFile(actual, "utf8");
  return {
    path: actual,
    configHash: digest(source),
    agentPromptHashes: await promptHashes(root, config),
  };
}
