import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createAssistantMessageEventStream,
  getCurrentTools,
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
  type ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import { configureNetworkRetry } from "../src/agents/network-retry.ts";
import { recoverTextualToolCallMessage } from "../src/agents/runner.ts";
import { repository } from "./helpers.ts";

const model = {
  api: "openai-completions",
  provider: "fixture",
  id: "fixture",
  name: "Fixture",
  contextWindow: 100000,
  maxTokens: 4096,
} as Model<Api>;

function response(text: string): AssistantMessage {
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

test("output repair recovers a textual call through Pi execution and continues", async () => {
  const cwd = await repository();
  const contexts: unknown[] = [];
  const events: string[] = [];
  const calls: unknown[] = [];
  const answers = [
    "invalid final",
    `<tool_call><function=team_command><parameter=executable>ng</parameter><parameter=args>["test", "--include=**/register-verify.component.spec.ts"]</parameter><parameter=purpose>Run tests</parameter></function></tool_call>`,
    JSON.stringify({
      status: "IMPLEMENTED",
      summary: "Fixed the unit test.",
      changedFiles: [],
      checks: [],
    }),
  ];
  const runtime = {
    hasConfiguredAuth: () => true,
    checkAuth: async () => "fixture-key",
    getModel: () => model,
    streamSimple: (_model: unknown, context: unknown) => {
      contexts.push(context);
      const stream = createAssistantMessageEventStream();
      stream.push({
        type: "done",
        reason: "stop",
        message: response(answers.shift()!),
      });
      stream.end();
      return stream;
    },
  } as unknown as ModelRuntime;
  let repair = false;
  configureNetworkRetry(
    runtime,
    { maxRetries: 1, delayMs: 0 },
    () => undefined,
    undefined,
    undefined,
    Date.now,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    "summary",
    () => repair,
  );
  const settings = SettingsManager.inMemory({
    packages: [],
    extensions: [],
    compaction: { enabled: false },
    retry: { enabled: false, maxRetries: 0 },
    cacheWarming: "off",
  });
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: cwd,
    settingsManager: settings,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    extensionFactories: [
      (pi) => {
        pi.on("message_end", async (event) => {
          if (event.message.role !== "assistant") return;
          const recovered = recoverTextualToolCallMessage(
            "implementor",
            event.message,
          );
          if (!recovered) return;
          events.push("textual_tool_call_recovered");
          repair = false;
          return { message: recovered.message };
        });
        pi.on("tool_execution_start", async () => {
          events.push("tool_start");
        });
        pi.on("tool_execution_end", async () => {
          events.push("tool_end");
        });
      },
    ],
    systemPromptOverride: () => "Return JSON",
  });
  await loader.reload();
  const { session } = await createAgentSession({
    cwd,
    agentDir: cwd,
    modelRuntime: runtime,
    model,
    thinkingLevel: "off",
    settingsManager: settings,
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(cwd),
    tools: ["team_command"],
    customTools: [
      {
        name: "team_command",
        label: "Approved command",
        description: "Run an approved command",
        parameters: Type.Object({
          executable: Type.String(),
          args: Type.Array(Type.String()),
          purpose: Type.String(),
        }),
        async execute(_id, args) {
          calls.push(args);
          return { content: [{ type: "text", text: "passed" }], details: {} };
        },
      },
    ],
  });
  await session.bindExtensions({ mode: "print" });
  try {
    await session.prompt("Start", { expandPromptTemplates: false });
    assert.equal(session.getLastAssistantText(), "invalid final");
    repair = true;
    await session.prompt("Return JSON only; tools are disabled", {
      expandPromptTemplates: false,
    });
    assert.deepEqual(calls, [
      {
        executable: "ng",
        args: ["test", "--include=**/register-verify.component.spec.ts"],
        purpose: "Run tests",
      },
    ]);
    assert.deepEqual(events, [
      "textual_tool_call_recovered",
      "tool_start",
      "tool_end",
    ]);
    assert.equal(
      session.getLastAssistantText(),
      answers.length
        ? ""
        : JSON.stringify({
            status: "IMPLEMENTED",
            summary: "Fixed the unit test.",
            changedFiles: [],
            checks: [],
          }),
    );
    assert.equal(contexts.length, 3);
    assert.equal(getCurrentTools((contexts[1] as any).messages).length, 0);
    assert.equal(getCurrentTools((contexts[2] as any).messages).length, 1);
    answers.push(
      `<tool_call><function=unavailable_tool><parameter=value>1</parameter></function></tool_call>`,
      JSON.stringify({
        status: "IMPLEMENTED",
        summary: "Still done.",
        changedFiles: [],
        checks: [],
      }),
    );
    await session.prompt("Continue", { expandPromptTemplates: false });
    assert.equal(calls.length, 1);
    assert.equal(
      session.getLastAssistantText(),
      JSON.stringify({
        status: "IMPLEMENTED",
        summary: "Still done.",
        changedFiles: [],
        checks: [],
      }),
    );
    assert.equal(contexts.length, 5);
    assert.deepEqual(events.slice(-3), [
      "textual_tool_call_recovered",
      "tool_start",
      "tool_end",
    ]);
  } finally {
    session.dispose();
  }
});
