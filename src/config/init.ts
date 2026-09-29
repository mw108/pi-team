import {
  readFile,
  readdir,
  mkdir,
  copyFile,
  writeFile,
  realpath,
} from "node:fs/promises";
import { constants } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { projectRoot, teamRoot, contained } from "./project.ts";
import { legacyGlobalConfig } from "./loader.ts";
import { configSchema } from "./schema.ts";
const templates = fileURLToPath(new URL("../../templates/", import.meta.url));
export type InitMode = "default" | "repair" | "from-global";
export async function initTeam(cwd: string, mode: InitMode = "default") {
  const root = await projectRoot(cwd),
    destination = teamRoot(root),
    created: string[] = [],
    existing: string[] = [];
  const present = await readdir(destination)
    .then(() => true)
    .catch((e) => {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw e;
    });
  if (present && mode === "default")
    return {
      root,
      created,
      existing: (await readdir(destination)).map((name) => `.pi/team/${name}`),
      message:
        "Project team already exists. No files were overwritten. Use /team-init --repair to add missing files.",
    };
  await mkdir(destination, { recursive: true });
  const realRoot = await realpath(root),
    realTeam = await realpath(destination);
  if (!contained(realRoot, realTeam))
    throw new Error("Project team directory escapes repository");
  const agentDir = join(destination, "agents");
  await mkdir(agentDir, { recursive: true });
  if (!contained(realTeam, await realpath(agentDir)))
    throw new Error("Project agent directory escapes .pi/team");
  const templateFiles = (await readdir(join(templates, "agents"))).filter(
    (name) => name.endsWith(".md"),
  );
  async function add(relative: string, source?: string, text?: string) {
    const target = join(destination, relative);
    try {
      await copyFile(source!, target, constants.COPYFILE_EXCL);
      created.push(`.pi/team/${relative}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      existing.push(`.pi/team/${relative}`);
    }
  }
  let configText = await readFile(join(templates, "team.yaml"), "utf8");
  if (mode === "from-global") {
    let legacy: string;
    try {
      legacy = await readFile(legacyGlobalConfig(), "utf8");
    } catch (error) {
      throw new Error(
        `Cannot migrate legacy config at ${legacyGlobalConfig()}: ${String(error)}. Nothing was deleted.`,
      );
    }
    const defaults = YAML.parse(configText),
      prior = YAML.parse(legacy);
    const merged = {
      ...defaults,
      ...prior,
      agents: Object.fromEntries(
        Object.entries(defaults.agents).map(([slot, definition]) => [
          slot,
          {
            ...(definition as object),
            ...prior.agents?.[slot],
            role: (definition as any).role,
            prompt: (definition as any).prompt,
          },
        ]),
      ),
    };
    configText =
      "# Migrated from the legacy global team.yaml. Original file was preserved.\n" +
      YAML.stringify(configSchema.parse(merged));
  }
  const configTarget = join(destination, "team.yaml");
  try {
    const file = await import("node:fs/promises").then((fs) =>
      fs.open(configTarget, "wx"),
    );
    try {
      await file.writeFile(configText);
    } finally {
      await file.close();
    }
    created.push(".pi/team/team.yaml");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    existing.push(".pi/team/team.yaml");
    if (mode === "repair") {
      const document = YAML.parseDocument(await readFile(configTarget, "utf8"));
      if (!document.hasIn(["agents", "reporter"])) {
        const defaults = YAML.parse(configText);
        document.setIn(["agents", "reporter"], defaults.agents.reporter);
        await writeFile(configTarget, String(document));
        created.push(".pi/team/team.yaml reporter entry");
      }
    }
  }
  for (const name of templateFiles)
    await add(`agents/${name}`, join(templates, "agents", name));
  const ignore = join(destination, ".gitignore");
  try {
    const file = await import("node:fs/promises").then((fs) =>
      fs.open(ignore, "wx"),
    );
    try {
      await file.writeFile("state/\n");
    } finally {
      await file.close();
    }
    created.push(".pi/team/.gitignore");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    existing.push(".pi/team/.gitignore");
  }
  await mkdir(join(destination, "state"), { recursive: true, mode: 0o700 });
  if (!contained(realTeam, await realpath(join(destination, "state"))))
    throw new Error("Project state directory escapes .pi/team");
  return {
    root,
    created,
    existing,
    message: `Created ${created.length} project team files; preserved ${existing.length} existing files. Consider committing .pi/team/team.yaml and .pi/team/agents/. State remains ignored.`,
  };
}
