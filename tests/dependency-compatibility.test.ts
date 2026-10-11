import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DefaultResourceLoader,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  context7Config,
  loadMcpAdapterFactory,
} from "../src/integrations/resources.ts";

const json = async (path: string) => JSON.parse(await readFile(path, "utf8"));

test("package metadata keeps runtime, host peer, and lockfile contracts aligned", async () => {
  const manifest = await json(join(process.cwd(), "package.json"));
  const lock = await json(join(process.cwd(), "package-lock.json"));
  const root = lock.packages[""];

  for (const name of [
    "@bacnh85/pi-serena",
    "@eko24ive/pi-ask",
    "pi-mcp-adapter",
    "pi-web-access",
    "yaml",
    "zod",
    "zod-to-json-schema",
  ])
    assert.equal(
      typeof manifest.dependencies[name],
      "string",
      `${name} must be installed for production runtime use`,
    );

  for (const name of [
    "@earendil-works/pi-ai",
    "@earendil-works/pi-coding-agent",
    "@earendil-works/pi-tui",
    "typebox",
  ]) {
    assert.equal(manifest.peerDependencies[name], "*");
    assert.equal(typeof manifest.devDependencies[name], "string");
  }

  assert.deepEqual(root.dependencies, manifest.dependencies);
  assert.deepEqual(root.devDependencies, manifest.devDependencies);
  assert.deepEqual(root.peerDependencies, manifest.peerDependencies);
  assert.deepEqual(root.engines, manifest.engines);
  assert.equal(lock.packages["node_modules/pi-mcp-adapter"].version, "5.2.0");
  assert.match(
    lock.packages["node_modules/pi-mcp-adapter"].peerDependencies[
      "@earendil-works/pi-ai"
    ],
    /\^0\.99\.0/,
  );
  assert.equal(manifest.dependencies["pi-web-access"], "0.38.0");
  assert.equal(lock.packages["node_modules/pi-web-access"].version, "0.38.0");
  assert.equal(
    lock.packages["node_modules/@modelcontextprotocol/sdk"].version,
    "1.32.1",
  );
  assert.equal(
    lock.packages["node_modules/pi-web-access"].dependencies[
      "@modelcontextprotocol/sdk"
    ],
    "1.32.1",
  );
});

test("missing optional Context7 user config produces an isolated usable config", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-team-context7-"));
  try {
    assert.deepEqual(await context7Config(directory), {
      mcpServers: {
        context7: {
          url: "https://mcp.context7.com/mcp",
          headers: {},
          lifecycle: "lazy",
          includeTools: ["resolve-library-id", "query-docs"],
          exposeResources: false,
        },
      },
      settings: {},
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("pi-mcp-adapter 5 factory loads and registers the expected Pi surface", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-team-adapter-"));
  let shutdownHandlers: Array<(...args: any[]) => unknown> = [];
  try {
    const createMcpAdapter = await loadMcpAdapterFactory();
    const loader = new DefaultResourceLoader({
      cwd: directory,
      agentDir: join(directory, "agent"),
      settingsManager: SettingsManager.inMemory({
        packages: [],
        extensions: [],
      }),
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      extensionFactories: [
        createMcpAdapter({ config: { mcpServers: {}, settings: {} } }),
      ],
    });

    await loader.reload();
    const result = loader.getExtensions();
    assert.deepEqual(result.errors, []);
    assert.equal(result.extensions.length, 1);
    assert.ok(result.extensions[0].tools.has("mcp"));
    assert.ok(result.extensions[0].commands.has("mcp-adapter"));
    assert.ok(result.extensions[0].handlers.has("session_shutdown"));
    shutdownHandlers = [
      ...(result.extensions[0].handlers.get("session_shutdown") ?? []),
    ];
  } finally {
    for (const handler of shutdownHandlers)
      await handler({ type: "session_shutdown", reason: "quit" }, {});
    await rm(directory, { recursive: true, force: true });
  }
});
