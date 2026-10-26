import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAssistantMessageEventStream,
  Type,
  type Api,
  type AssistantMessage,
  type Model,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  type ExtensionAPI,
  type ExtensionFactory,
  type ModelRuntime,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

const model = {
  api: "openai-completions",
  provider: "fixture",
  id: "fixture",
  name: "Fixture",
  contextWindow: 100_000,
  maxTokens: 4096,
} as Model<Api>;

function response(text = "ok"): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    stopReason: "stop",
    timestamp: Date.now(),
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}

function fixtureRuntime(contexts: unknown[] = []) {
  return {
    hasConfiguredAuth: () => true,
    checkAuth: async () => "fixture-key",
    getModel: () => model,
    streamSimple: (_model: unknown, context: unknown) => {
      contexts.push(context);
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "done", reason: "stop", message: response() });
      stream.end();
      return stream;
    },
  } as unknown as ModelRuntime;
}

function settings(overrides: Record<string, unknown> = {}) {
  return SettingsManager.inMemory({
    packages: [],
    extensions: [],
    compaction: { enabled: false },
    retry: { enabled: false, maxRetries: 0 },
    cacheWarming: "off",
    ...overrides,
  });
}

function loader(
  cwd: string,
  agentDir: string,
  settingsManager: SettingsManager,
  extensionFactories: ExtensionFactory[] = [],
) {
  return new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories,
    systemPromptOverride: () => "Compatibility fixture",
  });
}

test("Pi 1.4 file loader registers every Pi-Team command from the real entry point", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-team-loader-"));
  try {
    const resourceLoader = new DefaultResourceLoader({
      cwd: process.cwd(),
      agentDir,
      settingsManager: settings(),
      additionalExtensionPaths: [join(process.cwd(), "index.ts")],
      disabledBuiltinExtensions: ["mcp", "codemode", "tool-search"],
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await resourceLoader.reload();
    const loaded = resourceLoader.getExtensions();
    assert.deepEqual(loaded.errors, []);
    assert.equal(loaded.extensions.length, 1);
    assert.deepEqual([...loaded.extensions[0].commands.keys()].sort(), [
      "team",
      "team-abort",
      "team-continue",
      "team-init",
      "team-log",
      "team-report",
      "team-retry",
      "team-status",
      "team-steer",
      "team-stop",
    ]);
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("Pi 1.4 distinguishes user and triggerTurn custom before_agent_start events", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-team-events-"));
  const contexts: unknown[] = [];
  const starts: any[] = [];
  let api!: ExtensionAPI;
  let customSettled!: () => void;
  const customDone = new Promise<void>((resolve) => (customSettled = resolve));
  try {
    const settingsManager = settings();
    const resourceLoader = loader(directory, directory, settingsManager, [
      (extensionApi: ExtensionAPI) => {
        api = extensionApi;
        extensionApi.on("before_agent_start", (event) => {
          starts.push(event);
        });
        extensionApi.on("agent_settled", () => {
          if (starts.length === 2) customSettled();
        });
      },
    ]);
    await resourceLoader.reload();
    const { session } = await createAgentSession({
      cwd: directory,
      agentDir: directory,
      modelRuntime: fixtureRuntime(contexts),
      model,
      thinkingLevel: "off",
      settingsManager,
      resourceLoader,
      sessionManager: SessionManager.inMemory(directory),
      tools: [],
    });
    await session.bindExtensions({ mode: "print" });
    try {
      await session.prompt("user prompt", { expandPromptTemplates: false });
      assert.equal(starts[0].messageType, "user");
      assert.equal(starts[0].prompt, "user prompt");
      assert.equal("message" in starts[0], false);

      api.sendMessage(
        {
          customType: "pi-team:compatibility",
          content: "custom run",
          display: false,
        },
        { triggerTurn: true },
      );
      await customDone;
      assert.equal(starts[1].messageType, "custom");
      assert.equal(starts[1].message.customType, "pi-team:compatibility");
      assert.equal(starts[1].message.content, "custom run");
      assert.equal("prompt" in starts[1], false);
      assert.equal(contexts.length, 2);
    } finally {
      session.dispose();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Pi 1.4 resume restores recorded tools without activating disabled tools", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-team-tools-"));
  const sessionManager = SessionManager.inMemory(directory);
  const tools: ToolDefinition[] = [
    {
      name: "allowed_fixture",
      label: "Allowed fixture",
      description: "Allowed compatibility fixture",
      parameters: Type.Object({}),
      defaultActive: false,
      async execute() {
        return { content: [{ type: "text", text: "allowed" }], details: {} };
      },
    },
    {
      name: "disabled_fixture",
      label: "Disabled fixture",
      description: "Permission-sensitive compatibility fixture",
      parameters: Type.Object({}),
      defaultActive: false,
      async execute() {
        return { content: [{ type: "text", text: "disabled" }], details: {} };
      },
    },
  ];
  try {
    const firstSettings = settings({ defaultTools: ["allowed_fixture"] });
    const firstLoader = loader(directory, directory, firstSettings);
    await firstLoader.reload();
    const { session: first } = await createAgentSession({
      cwd: directory,
      agentDir: directory,
      modelRuntime: fixtureRuntime(),
      model,
      thinkingLevel: "off",
      settingsManager: firstSettings,
      resourceLoader: firstLoader,
      sessionManager,
      customTools: tools,
    });
    await first.bindExtensions({ mode: "print" });
    assert.deepEqual(first.getActiveToolNames(), ["allowed_fixture"]);
    await first.prompt("record loadout", { expandPromptTemplates: false });
    first.dispose();

    const resumedSettings = settings({ defaultTools: ["disabled_fixture"] });
    const resumedLoader = loader(directory, directory, resumedSettings);
    await resumedLoader.reload();
    const { session: resumed } = await createAgentSession({
      cwd: directory,
      agentDir: directory,
      modelRuntime: fixtureRuntime(),
      model,
      thinkingLevel: "off",
      settingsManager: resumedSettings,
      resourceLoader: resumedLoader,
      sessionManager,
      customTools: tools,
    });
    await resumed.bindExtensions({ mode: "print" });
    try {
      assert.deepEqual(resumed.getActiveToolNames(), ["allowed_fixture"]);
      assert.equal(
        resumed.getActiveToolNames().includes("disabled_fixture"),
        false,
      );
    } finally {
      resumed.dispose();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
