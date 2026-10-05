import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type Model,
} from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { RawToolCallCollector } from "../src/agents/provider-tool-calls.ts";
import {
  configureNetworkRetry,
  type ProviderRequestEvent,
} from "../src/agents/network-retry.ts";
import { AgentLogStore } from "../src/workflow/agent-logs.ts";
import { config, repository } from "./helpers.ts";

const chunk = (calls: unknown[], extra: Record<string, unknown> = {}) => ({
  choices: [
    {
      delta: {
        tool_calls: calls,
        reasoning_content: "private thoughts",
        ...extra,
      },
    },
  ],
});
const part = (
  index: number,
  arguments_: string,
  id?: string,
  name?: string,
) => ({
  index,
  id,
  function: { name, arguments: arguments_ },
});

test("raw collector assembles interleaved calls, exact arguments, fragmented names and IDs", () => {
  const calls = new RawToolCallCollector("diagnostic");
  calls.observe(
    chunk([
      part(0, '{"executable":', undefined, "team_"),
      part(1, "{}", "two", "team_read"),
    ]),
  );
  calls.observe(
    chunk([
      part(
        0,
        '"php","args":["artisan","test"],"purpose":"run test"}',
        "one",
        "command",
      ),
    ]),
  );
  const events = calls.events("tool_calls");
  assert.equal(events.length, 2);
  assert.deepEqual(
    events.map((event) => [event.toolCallIndex, event.toolCallId, event.tool]),
    [
      [0, "one", "team_command"],
      [1, "two", "team_read"],
    ],
  );
  assert.equal(
    events[0].rawArguments,
    '{"executable":"php","args":["artisan","test"],"purpose":"run test"}',
  );
  assert.deepEqual(events[0].parsedArguments, {
    executable: "php",
    args: ["artisan", "test"],
    purpose: "run test",
  });
  assert.equal(events[0].fragmentCount, 2);
  assert.equal(events[1].rawArguments, "{}");
  assert.equal(events[1].parseStatus, "ok");
  assert.doesNotMatch(
    JSON.stringify(events),
    /private thoughts|reasoning_content/,
  );
});

test("malformed arguments keep raw syntax and expose parser failure without fake parsed object", () => {
  const calls = new RawToolCallCollector("diagnostic");
  calls.observe(
    chunk([part(0, '{"executable":"php","args":[', "bad", "team_command")]),
  );
  const [event] = calls.events();
  assert.equal(event.parseStatus, "error");
  assert.equal(event.rawArguments, '{"executable":"php","args":[');
  assert.equal(event.parsedArguments, undefined);
  assert.match(event.parseError!, /JSON|end/i);
});

test("raw argument redaction preserves JSON structure and hides malformed tails", () => {
  const calls = new RawToolCallCollector("summary");
  calls.observe(
    chunk([
      part(
        0,
        '{"token":"super-secret","password":"another-secret","APP_KEY":"fifth-secret","args":["--token","third-secret"],"header":"Authorization: Bearer fourth-secret","path":"tests/Foo.php"}',
        "one",
        "team_command",
      ),
    ]),
  );
  const [event] = calls.events();
  assert.doesNotMatch(
    JSON.stringify(event),
    /super-secret|another-secret|third-secret|fourth-secret|fifth-secret/,
  );
  assert.deepEqual(JSON.parse(event.rawArguments), {
    token: "[REDACTED]",
    password: "[REDACTED]",
    APP_KEY: "[REDACTED]",
    args: ["--token", "[REDACTED]"],
    header: "Authorization: Bearer [REDACTED]",
    path: "tests/Foo.php",
  });
  const diagnostic = new RawToolCallCollector("diagnostic");
  diagnostic.observe(
    chunk([
      part(
        0,
        '{"args":["--token","third-secret"],"path":"tests/Foo.php"}',
        "one",
        "team_command",
      ),
    ]),
  );
  assert.deepEqual(diagnostic.events()[0].parsedArguments, {
    args: ["--token", "[REDACTED]"],
    path: "tests/Foo.php",
  });
  const malformed = new RawToolCallCollector("summary");
  malformed.observe(
    chunk([part(0, '{"token":"super-secret', "bad", "team_command")]),
  );
  assert.equal(malformed.events()[0].rawArguments, '{"token":"[REDACTED]');
  const newline = new RawToolCallCollector("summary");
  newline.observe(
    chunk([part(0, '{"token":"super-secret\n', "bad", "team_read")]),
  );
  assert.doesNotMatch(newline.events()[0].rawArguments, /super-secret/);
  const bare = new RawToolCallCollector("summary");
  bare.observe(chunk([part(0, '{"token":super-secret', "bad", "team_read")]));
  assert.equal(bare.events()[0].rawArguments, '{"token":[REDACTED]');
  const escapedKey = new RawToolCallCollector("summary");
  escapedKey.observe(
    chunk([part(0, '{"to\\u006ben":"hidden-value"}', "escaped", "team_read")]),
  );
  assert.equal(
    escapedKey.events()[0].rawArguments,
    '{"to\\u006ben":"[REDACTED]"}',
  );
});

test("summary bounds raw arguments, trace bounds fragments, and incomplete calls are diagnostic only", () => {
  const raw = new RawToolCallCollector("summary");
  raw.observe(
    chunk([
      part(0, '{"path":"' + "a".repeat(70000) + '"}', "large", "team_read"),
    ]),
  );
  const [event] = raw.events();
  assert.equal(event.parseStatus, "truncated");
  assert.equal(event.rawArgumentsTruncated, true);
  assert.ok(event.rawArguments.length <= 4096);
  assert.deepEqual(raw.events(undefined, true), []);
  const trace = new RawToolCallCollector("trace");
  for (let i = 0; i < 30; i++)
    trace.observe(
      chunk([part(0, "x".repeat(500), i === 0 ? "one" : undefined)]),
    );
  const [partial] = trace.events(undefined, true);
  assert.equal(partial.incomplete, true);
  assert.equal(partial.fragmentLengths?.length, 16);
  assert.ok(partial.fragmentLengths!.every((length) => length === 500));
});

test("nonstreaming message.tool_calls is observed when supplied by callback", () => {
  const calls = new RawToolCallCollector("summary");
  calls.observe({
    choices: [
      { message: { tool_calls: [part(0, "{}", "one", "team_command")] } },
    ],
  });
  assert.equal(calls.events()[0].rawArguments, "{}");
});

test("provider callback logs raw calls before request end and isolates network retries", async () => {
  const model = {
    api: "openai-completions",
    provider: "local",
    id: "fixture",
  } as Model<Api>;
  const response = (
    stopReason: "stop" | "error",
    content: AssistantMessage["content"] = [],
  ): AssistantMessage => ({
    role: "assistant",
    content,
    api: model.api,
    provider: model.provider,
    model: model.id,
    stopReason,
    timestamp: 0,
    errorMessage: stopReason === "error" ? "Connection error" : undefined,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  });
  let request = 0;
  const runtime = {
    streamSimple: (_model: unknown, _context: unknown, options: any) => {
      const source = createAssistantMessageEventStream();
      void (async () => {
        request++;
        await options.onProviderStreamEvent(
          chunk([
            part(
              0,
              request === 1 ? '{"token":"partial' : "{}",
              "one",
              "team_command",
            ),
          ]),
          model,
        );
        if (request === 1)
          source.push({
            type: "error",
            reason: "error",
            error: response("error"),
          });
        else
          source.push({
            type: "done",
            reason: "toolUse",
            message: response("stop", [
              {
                type: "toolCall",
                id: "one",
                name: "team_command",
                arguments: {},
              },
            ]),
          });
        source.end();
      })();
      return source;
    },
  } as unknown as ModelRuntime;
  const events: ProviderRequestEvent[] = [];
  const order: string[] = [];
  configureNetworkRetry(
    runtime,
    { maxRetries: 1, delayMs: 1 },
    () => undefined,
    undefined,
    (event) => {
      events.push(event);
      order.push(event.type);
    },
    Date.now,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    () => order.push("assistant_response"),
    "summary",
  );
  await runtime.streamSimple(model, { messages: [] }).result();
  assert.equal(request, 2);
  const raw = events.filter((event) => event.type === "provider_tool_call_raw");
  assert.equal(raw.length, 1);
  assert.equal(raw[0].providerRequest, 2);
  assert.equal(raw[0].networkRetry, 1);
  assert.equal(raw[0].rawArguments, "{}");
  assert.ok(
    order.indexOf("provider_tool_call_raw") <
      order.lastIndexOf("provider_request_end"),
  );
  assert.ok(
    order.lastIndexOf("provider_request_end") <
      order.indexOf("assistant_response"),
  );
});

test("summary JSONL persists structurally redacted raw arguments", async () => {
  const cwd = await repository();
  const store = new AgentLogStore(cwd);
  const cfg = config();
  const id = randomUUID();
  const { logger, attempt } = await store.create(id, "tester");
  const path = store.path(id, "tester", attempt);
  logger.append({
    type: "provider_tool_call_raw",
    providerRequest: 1,
    toolCallId: "one",
    toolCallIndex: 0,
    tool: "team_command",
    rawArguments: '{"token":"super-secret","path":"tests/Foo.php"}',
    parseStatus: "ok",
  });
  await logger.flush();
  const disk = await readFile(path, "utf8");
  assert.doesNotMatch(disk, /super-secret/);
  const [event] = await store.read(id, "tester", attempt);
  assert.deepEqual(JSON.parse(event.rawArguments as string), {
    token: "[REDACTED]",
    path: "tests/Foo.php",
  });
  assert.equal(cfg.logging.agentLogs.level, "summary");
});
