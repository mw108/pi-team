import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { agentDir } from "../config/loader.ts";
const require = createRequire(import.meta.url);
export function packagePath(name: string, relativePath: string) {
  try {
    return join(dirname(require.resolve(`${name}/package.json`)), relativePath);
  } catch {
    let dir = dirname(fileURLToPath(import.meta.resolve(name)));
    while (true) {
      const manifest = join(dir, "package.json");
      if (
        existsSync(manifest) &&
        JSON.parse(readFileSync(manifest, "utf8")).name === name
      )
        return join(dir, relativePath);
      const parent = dirname(dir);
      if (parent === dir) throw new Error(`Cannot locate package ${name}`);
      dir = parent;
    }
  }
}
export async function context7Config() {
  let headers: Record<string, string> = {};
  try {
    const config = JSON.parse(
      await readFile(join(agentDir(), "mcp-adapter.json"), "utf8"),
    );
    headers = config.mcpServers?.context7?.headers ?? {};
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  // Environment authentication takes precedence over user-private configuration.
  if (process.env.CONTEXT7_API_KEY)
    headers = { CONTEXT7_API_KEY: process.env.CONTEXT7_API_KEY };
  return {
    mcpServers: {
      context7: {
        url: "https://mcp.context7.com/mcp",
        headers,
        lifecycle: "lazy",
        includeTools: ["resolve-library-id", "query-docs"],
        exposeResources: false,
      },
    },
    settings: {},
  };
}
