import test from "node:test";
import assert from "node:assert/strict";
import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type Model,
} from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { configureNetworkRetry } from "../src/agents/network-retry.ts";
import { normalizedResponseForLog } from "../src/agents/normalized-response.ts";
import type { AgentRunner } from "../src/agents/runner.ts";
import { WorkflowEngine } from "../src/workflow/engine.ts";
import { AgentLogStore } from "../src/workflow/agent-logs.ts";
import { config, output, repository } from "./helpers.ts";

const model = {
  api: "openai-completions",
  provider: "local",
  id: "fixture",
} as Model<Api>;
function message(content: AssistantMessage["content"]): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: model.api,
    provider: model.provider,
    model: model.id,
    stopReason: "toolUse",
    timestamp: 0,
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

test("normalized response preserves empty and valid calls, order, text, and no reasoning", () => {
  const valid = {
    executable: "php",
    args: ["artisan", "test", "tests/Unit/ConfigTest.php"],
    purpose: "run test",
  };
  const source = message([
    { type: "text", text: "before" },
    { type: "toolCall", id: "empty", name: "team_command", arguments: {} },
    { type: "thinking", thinking: "hidden chain of thought" },
    { type: "text", text: "after" },
    { type: "toolCall", id: "valid", name: "team_command", arguments: valid },
  ]);
  const record = normalizedResponseForLog(source, 2);
  assert.deepEqual(
    record.content.map((item) => item.contentIndex),
    [0, 1, 3, 4],
  );
  assert.deepEqual(record.content[1], {
    type: "tool_call",
    contentIndex: 1,
    toolCallId: "empty",
    tool: "team_command",
    arguments: {},
  });
  assert.deepEqual(
    (record.content[3] as { arguments: unknown }).arguments,
    valid,
  );
  assert.equal(record.hasReasoning, true);
  assert.equal(record.reasoningChars, "hidden chain of thought".length);
  assert.doesNotMatch(JSON.stringify(record), /hidden chain of thought/);
  assert.deepEqual(source.content[4], {
    type: "toolCall",
    id: "valid",
    name: "team_command",
    arguments: valid,
  });
});

test("normalized arguments redact nested secrets and remain valid bounded JSON", () => {
  const source = message([
    {
      type: "toolCall",
      id: "secret",
      name: "team_command",
      arguments: {
        executable: "curl",
        args: [
          "-H",
          "Authorization: Bearer super-secret",
          "--token",
          "other-secret",
        ],
        nested: {
          password: "plain-secret",
          count: 3,
          enabled: true,
          none: null,
        },
      },
    },
    { type: "text", text: "x".repeat(20000) },
  ]);
  const record = normalizedResponseForLog(source, 1);
  const args = (record.content[0] as { arguments: any }).arguments;
  assert.deepEqual(args.args, [
    "-H",
    "Authorization: Bearer [REDACTED]",
    "--token",
    "[REDACTED]",
  ]);
  assert.deepEqual(args.nested, {
    password: "[REDACTED]",
    count: 3,
    enabled: true,
    none: null,
  });
  assert.equal(record.truncated, true);
  assert.doesNotMatch(
    JSON.stringify(record),
    /super-secret|other-secret|plain-secret/,
  );
  assert.ok(JSON.stringify(record).length < 10000);
  assert.ok(
    (
      normalizedResponseForLog(source, 1, "diagnostic").content[1] as {
        text: string;
      }
    ).text.length > (record.content[1] as { text: string }).text.length,
  );
});

test("plain final text is bounded and numeric argument trees have a node limit", () => {
  const final = message([
    { type: "text", text: '{"status":"PASS"}' + "x".repeat(9000) },
  ]);
  final.stopReason = "stop";
  const textRecord = normalizedResponseForLog(final, 3);
  assert.equal(textRecord.finishReason, "stop");
  assert.match(
    (textRecord.content[0] as { text: string }).text,
    /^\{"status":"PASS"\}/,
  );
  assert.equal(textRecord.truncated, true);
  const numbers = message([
    {
      type: "toolCall",
      id: "numbers",
      name: "team_read",
      arguments: {
        data: Array.from({ length: 64 }, () =>
          Array.from({ length: 64 }, (_, index) => index),
        ),
      },
    },
  ]);
  const bounded = normalizedResponseForLog(numbers, 4);
  assert.equal(bounded.truncated, true);
  assert.ok(JSON.stringify(bounded).length < 10000);
});

test("Pi completed response is observed after provider end and before stream delivery", async () => {
  const source = createAssistantMessageEventStream();
  const runtime = { streamSimple: () => source } as unknown as ModelRuntime;
  const order: string[] = [];
  configureNetworkRetry(
    runtime,
    { maxRetries: 0, delayMs: 1 },
    () => undefined,
    undefined,
    (event) => order.push(event.type),
    Date.now,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    (response, providerRequest) => {
      assert.equal(providerRequest, 1);
      assert.deepEqual(response.content[0], {
        type: "toolCall",
        id: "one",
        name: "team_command",
        arguments: {},
      });
      order.push("assistant_response");
    },
  );
  const delivered = runtime
    .streamSimple(model, { messages: [] })
    .result()
    .then(() => order.push("delivered"));
  source.push({ type: "start", partial: message([]) });
  source.push({
    type: "done",
    reason: "toolUse",
    message: message([
      { type: "toolCall", id: "one", name: "team_command", arguments: {} },
    ]),
  });
  source.end();
  await delivered;
  assert.deepEqual(order, [
    "provider_request_context",
    "provider_request_start",
    "provider_request_end",
    "assistant_response",
    "delivered",
  ]);
});

test("summary JSONL correlates model arguments with separate tool execution input", async () => {
  const cwd = await repository();
  const cfg = config();
  cfg.commands = [];
  const original = {
    executable: "php",
    args: ["artisan", "test"],
    purpose: "run test",
  };
  const runner: AgentRunner = {
    async run(...params: Parameters<AgentRunner["run"]>) {
      const role = params[0];
      const activity = params[3];
      const providerEvent = params[9];
      const normalizedResponse = params[14];
      providerEvent?.({
        type: "provider_tool_call_raw",
        providerRequest: 1,
        provider: "local",
        model: "fixture",
        api: "openai-completions",
        networkRetry: 0,
        requestStartedAt: new Date().toISOString(),
        toolCallIndex: 0,
        toolCallId: "empty",
        tool: "team_command",
        rawArguments: "{}",
        parseStatus: "ok",
      });
      providerEvent?.({
        type: "provider_tool_call_raw",
        providerRequest: 1,
        provider: "local",
        model: "fixture",
        api: "openai-completions",
        networkRetry: 0,
        requestStartedAt: new Date().toISOString(),
        toolCallIndex: 1,
        toolCallId: "valid",
        tool: "team_command",
        rawArguments: JSON.stringify(original),
        parseStatus: "ok",
      });
      providerEvent?.({
        type: "provider_request_end",
        providerRequest: 1,
        provider: "local",
        model: "fixture",
        api: "openai-completions",
        networkRetry: 0,
        requestStartedAt: new Date().toISOString(),
        success: true,
      });
      normalizedResponse?.(
        message([
          {
            type: "toolCall",
            id: "empty",
            name: "team_command",
            arguments: {},
          },
          {
            type: "toolCall",
            id: "valid",
            name: "team_command",
            arguments: original,
          },
        ]),
        1,
      );
      activity?.("team_command", "empty", undefined, undefined, {});
      activity?.(undefined, "empty", undefined, false, undefined, {
        content: [{ type: "text", text: "Received arguments: {}" }],
      });
      activity?.("team_command", "valid", undefined, undefined, original);
      activity?.(undefined, "valid", undefined, true, undefined, {
        details: { exitCode: 0, output: "ok" },
      });
      return output(role);
    },
  };
  const engine = new WorkflowEngine(cwd, runner, {
    progress: () => {},
    ask: async () => undefined,
  });
  const state = await engine.start("Fixture", cfg);
  await engine.invoke("researcher", state);
  const events = await new AgentLogStore(cwd).read(state.id, "researcher", 1);
  const raw = events.filter((event) => event.type === "provider_tool_call_raw");
  assert.deepEqual(
    raw.map((event) => [
      event.toolCallId,
      event.providerRequest,
      event.rawArguments,
    ]),
    [
      ["empty", 1, "{}"],
      ["valid", 1, JSON.stringify(original)],
    ],
  );
  const response = events.find((event) => event.type === "assistant_response")!;
  const content = response.content as Array<{ arguments?: unknown }>;
  assert.deepEqual(content[0].arguments, {});
  assert.deepEqual(content[1].arguments, original);
  const starts = events.filter((event) => event.type === "tool_start");
  assert.deepEqual(
    starts.map((event) => [event.toolCallId, event.providerRequest]),
    [
      ["empty", 1],
      ["valid", 1],
    ],
  );
  assert.deepEqual(
    events
      .filter((event) => event.type === "tool_end")
      .map((event) => event.providerRequest),
    [1, 1],
  );
  assert.ok(events.indexOf(response) < events.indexOf(starts[0]));
  assert.ok(events.indexOf(raw[0]) < events.indexOf(response));
  assert.ok(
    events.findIndex((event) => event.type === "provider_request_end") <
      events.indexOf(response),
  );
  assert.deepEqual(original, {
    executable: "php",
    args: ["artisan", "test"],
    purpose: "run test",
  });
});
