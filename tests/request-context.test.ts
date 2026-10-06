import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type Context,
  type Model,
} from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { providerRequestContext } from "../src/agents/request-context.ts";
import {
  configureNetworkRetry,
  type ProviderRequestEvent,
} from "../src/agents/network-retry.ts";
import { AgentLogStore } from "../src/workflow/agent-logs.ts";
import { repository } from "./helpers.ts";

const model = {
  api: "openai-completions",
  provider: "local",
  id: "fixture",
} as Model<Api>;

function requestContext(): Context {
  return {
    systemPrompt:
      "Base role. Tester-specific instructions. APP_KEY=very-secret-value",
    messages: [
      {
        role: "user",
        content: JSON.stringify({
          task: "Test this",
          candidateValidationCommands: [
            { executable: "php", args: ["artisan", "test"] },
          ],
          reviewer: {
            suggestedCommand: { args: ["--token", "argv-secret-value"] },
          },
          verifiedCommandResults: [],
          approvedCommandIds: [],
          commandAuthorizationHints: [{ executable: "php" }],
          token: "another-secret-value",
        }),
        timestamp: 0,
      },
    ],
    tools: [
      {
        name: "team_command",
        description: "Run command. PASSWORD=secret-password-value",
        parameters: {
          anyOf: [
            { type: "object", properties: { id: { type: "string" } } },
            {
              type: "object",
              properties: {
                executable: { type: "string" },
                password: { default: "nested-secret-value" },
              },
            },
          ],
        } as any,
      },
    ],
  };
}

test("request projection preserves tool schema and Tester structure with redaction", () => {
  const projected = providerRequestContext(requestContext(), "summary");
  const tool = projected.tools[0];
  assert.equal(tool.name, "team_command");
  assert.equal((tool.parameters as any).anyOf.length, 2);
  assert.equal(
    (projected.contextSummary.candidateValidationCommands as any)[0].executable,
    "php",
  );
  assert.deepEqual(projected.contextSummary.verifiedCommandResults, []);
  assert.equal(
    (projected.contextSummary.commandAuthorizationHints as any)[0].executable,
    "php",
  );
  assert.equal(
    (tool.parameters as any).anyOf[1].properties.password.default,
    "[REDACTED]",
  );
  const serialized = JSON.stringify(projected);
  assert.match(serialized, /\[REDACTED\]/);
  assert.doesNotMatch(
    serialized,
    /very-secret-value|another-secret-value|secret-password-value|nested-secret-value|argv-secret-value/,
  );
});

test("request projection reflects system section and tool changes", () => {
  const context = requestContext();
  context.messages.unshift(
    {
      role: "system",
      content: "Base additions",
      sections: { workflow: "old workflow", temporary: "removed content" },
      toolsAdded: [
        {
          name: "obsolete_tool",
          description: "old",
          parameters: { type: "object" } as any,
        },
      ],
      timestamp: 0,
    },
    {
      role: "system",
      content: "Finalization instruction",
      sections: { workflow: "current workflow", temporary: null },
      toolsRemoved: [{ name: "obsolete_tool" }],
      timestamp: 1,
    },
  );
  const projected = providerRequestContext(context, "summary");
  assert.match(projected.systemPromptPreview, /Finalization instruction/);
  assert.match(projected.systemPromptPreview, /current workflow/);
  assert.doesNotMatch(
    projected.systemPromptPreview,
    /old workflow|removed content/,
  );
  assert.deepEqual(
    projected.tools.map((tool) => tool.name),
    ["team_command"],
  );
});

test("request projection bounds large prompt, context and schema as valid JSONL", async () => {
  const context = requestContext();
  context.systemPrompt = "long " + "x".repeat(100000);
  context.messages[0] = {
    role: "user",
    content: JSON.stringify({ task: "y".repeat(100000) }),
    timestamp: 0,
  };
  context.tools![0].parameters = {
    anyOf: [{ description: "z".repeat(100000) }],
  } as any;
  const cwd = await repository();
  const logs = new AgentLogStore(cwd);
  const id = randomUUID();
  const { attempt, logger } = await logs.create(id, "tester");
  logger.append({
    type: "provider_request_context",
    providerRequest: 1,
    agent: "tester",
    attempt,
    ...providerRequestContext(context, "summary"),
  });
  await logger.flush();
  const event = (await logs.read(id, "tester", attempt))[0];
  assert.match(JSON.stringify(event), /TRUNCATED/);
  assert.equal((event.tools as any)[0].name, "team_command");
});

test("provider request context precedes start and correlates with raw tool and response", async () => {
  const response: AssistantMessage = {
    role: "assistant",
    content: [
      { type: "toolCall", id: "one", name: "team_command", arguments: {} },
    ],
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
  const runtime = {
    streamSimple: (_model: unknown, _context: unknown, options: any) => {
      const stream = createAssistantMessageEventStream();
      void (async () => {
        await options.onProviderStreamEvent(
          {
            choices: [
              {
                delta: {
                  reasoning_content: "hidden chain of thought",
                  tool_calls: [
                    {
                      index: 0,
                      id: "one",
                      function: { name: "team_command", arguments: "{}" },
                    },
                  ],
                },
              },
            ],
          },
          model,
        );
        stream.push({ type: "done", reason: "toolUse", message: response });
        stream.end();
      })();
      return stream;
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
    (_response, providerRequest) =>
      order.push(`assistant_response:${providerRequest}`),
    "summary",
  );
  await runtime.streamSimple(model, requestContext()).result();
  assert.deepEqual(order.slice(0, 2), [
    "provider_request_context",
    "provider_request_start",
  ]);
  assert.ok(
    order.indexOf("provider_tool_call_raw") <
      order.indexOf("provider_request_end"),
  );
  assert.ok(
    order.indexOf("provider_request_end") <
      order.indexOf("assistant_response:1"),
  );
  assert.deepEqual(
    events
      .filter((event) =>
        ["provider_request_context", "provider_tool_call_raw"].includes(
          event.type,
        ),
      )
      .map((event) => event.providerRequest),
    [1, 1],
  );
  assert.doesNotMatch(JSON.stringify(events), /hidden chain of thought/);
});
