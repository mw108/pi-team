import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { agentDir } from "../config/loader.ts";

export type CreateMcpAdapter = (options?: {
  config?: unknown;
  configPath?: string;
}) => ExtensionFactory;

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

/** Resolve the published Pi extension entry used by child agent sessions. */
export function webAccessExtensionPath() {
  return packagePath("pi-web-access", "dist/index.js");
}

/** Load the adapter's published TypeScript entry through the active TS loader. */
export async function loadMcpAdapterFactory(): Promise<CreateMcpAdapter> {
  const entry = pathToFileURL(packagePath("pi-mcp-adapter", "index.ts")).href;
  const module = (await import(entry)) as {
    createMcpAdapter?: CreateMcpAdapter;
  };
  if (typeof module.createMcpAdapter !== "function")
    throw new Error(
      "Incompatible pi-mcp-adapter: createMcpAdapter export is unavailable",
    );
  return module.createMcpAdapter;
}

export async function context7Config(directory = agentDir()) {
  let headers: Record<string, string> = {};
  try {
    const config = JSON.parse(
      await readFile(join(directory, "mcp-adapter.json"), "utf8"),
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
