import { mkdir, readFile, writeFile, copyFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { agentDir } from "../src/config/loader.ts";
const dir = agentDir();
await mkdir(dir, { recursive: true, mode: 0o700 });
async function readJson(path: string) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw e;
  }
}
const path = join(dir, "mcp-adapter.json"),
  mcp = await readJson(path);
mcp.mcpServers ??= {};
if (!mcp.mcpServers.context7) {
  const existing = await readJson(
    join(homedir(), ".config", "opencode", "opencode.json"),
  );
  const previous = existing.mcp?.context7?.headers?.Authorization;
  const headers = process.env.CONTEXT7_API_KEY
    ? { CONTEXT7_API_KEY: "${CONTEXT7_API_KEY}" }
    : previous
      ? { Authorization: previous }
      : {};
  mcp.mcpServers.context7 = {
    url: "https://mcp.context7.com/mcp",
    headers,
    includeTools: ["resolve-library-id", "query-docs"],
    exposeResources: false,
  };
  await writeFile(path, JSON.stringify(mcp, null, 2) + "\n", { mode: 0o600 });
}
const webPath = join(dir, "web-search.json"),
  web = await readJson(webPath);
if (!Object.keys(web).length) {
  await writeFile(
    webPath,
    JSON.stringify({ provider: "exa", curator: { enabled: false } }, null, 2) +
      "\n",
    { mode: 0o600 },
  );
}
for (const [source, target] of [
  ["config/team.example.yaml", join(dir, "team.yaml")],
  ["config/models.example.json", join(dir, "models.json")],
]) {
  try {
    await readFile(target);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    await copyFile(source, target);
  }
}
console.log(
  "Created missing Pi configuration only. Existing files preserved; credentials not printed.",
);
