import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createAssistantMessageEventStream,
  type Api,
  type Model,
} from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { configSchema } from "../src/config/schema.ts";
import {
  piRequestTimeoutMs,
  resolveRequestTimeout,
} from "../src/agents/request-timeout.ts";
import { configureNetworkRetry } from "../src/agents/network-retry.ts";
import { config } from "./helpers.ts";

const model = {
  api: "openai-completions",
  provider: "fixture",
  id: "fixture",
} as Model<Api>;

test("provider timeout resolves agent, workflow, and default sources", () => {
  const cfg = config();
  assert.equal(cfg.workflow.requestTimeoutMs, undefined);
  assert.deepEqual(resolveRequestTimeout(cfg, "implementor"), {
    value: 300000,
    source: "default",
  });
  cfg.workflow.requestTimeoutMs = 600000;
  assert.deepEqual(resolveRequestTimeout(cfg, "implementor"), {
    value: 600000,
    source: "workflow",
  });
  cfg.agents.implementor.requestTimeoutMs = 900000;
  assert.deepEqual(resolveRequestTimeout(cfg, "implementor"), {
    value: 900000,
    source: "agent",
  });
  cfg.agents.implementor.requestTimeoutMs = 0;
  assert.deepEqual(resolveRequestTimeout(cfg, "implementor"), {
    value: 0,
    source: "agent",
    mode: "unlimited",
  });
  cfg.workflow.requestTimeoutMs = 0;
  assert.deepEqual(resolveRequestTimeout(cfg, "reviewer"), {
    value: 0,
    source: "workflow",
    mode: "unlimited",
  });
  cfg.agents.reviewer.requestTimeoutMs = 300000;
  assert.deepEqual(resolveRequestTimeout(cfg, "reviewer"), {
    value: 300000,
    source: "agent",
  });
});

test("request timeout schema rejects invalid milliseconds", () => {
  const cfg = config();
  for (const value of [-1, 1.5, "1000", Infinity]) {
    assert.equal(
      configSchema.safeParse({
        ...cfg,
        workflow: { ...cfg.workflow, requestTimeoutMs: value },
      }).success,
      false,
    );
    assert.equal(
      configSchema.safeParse({
        ...cfg,
        agents: {
          ...cfg.agents,
          reviewer: { ...cfg.agents.reviewer, requestTimeoutMs: value },
        },
      }).success,
      false,
    );
  }
  assert.equal(
    configSchema.safeParse({
      ...cfg,
      workflow: { ...cfg.workflow, requestTimeoutMs: 0 },
    }).success,
    true,
  );
});

test("each provider request receives its agent's resolved timeout", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const cfg = config();
  cfg.workflow.requestTimeoutMs = 0;
  cfg.agents.reviewer.requestTimeoutMs = 1000;
  const request = (role: "reviewer" | "implementor") => {
    let timeoutMs: number | undefined;
    let aborted = false;
    let pending!: ReturnType<typeof createAssistantMessageEventStream>;
    const events: Array<{ providerTimeouts?: { requestTimeoutMs?: unknown } }> =
      [];
    const runtime = {
      streamSimple: (
        _model: unknown,
        _context: unknown,
        options: { timeoutMs: number },
      ) => {
        timeoutMs = options.timeoutMs;
        pending = createAssistantMessageEventStream();
        setTimeout(() => {
          aborted = true;
          pending.push({
            type: "error",
            reason: "error",
            error: errorMessage("timeout"),
          });
          pending.end();
        }, options.timeoutMs);
        return pending;
      },
    } as unknown as ModelRuntime;
    configureNetworkRetry(
      runtime,
      { maxRetries: 0, delayMs: 100 },
      () => undefined,
      undefined,
      (event) => events.push(event),
      Date.now,
      undefined,
      () => () => {},
      undefined,
      undefined,
      undefined,
      resolveRequestTimeout(cfg, role),
    );
    return {
      run: () => runtime.streamSimple(model, { messages: [] }).result(),
      timeoutMs: () => timeoutMs,
      aborted: () => aborted,
      events,
      finish: () => {
        pending.push({ type: "done", reason: "stop", message: errorMessage() });
        pending.end();
      },
    };
  };
  const reviewer = request("reviewer");
  const finite = reviewer.run();
  await Promise.resolve();
  assert.equal(reviewer.timeoutMs(), 1000);
  assert.deepEqual(reviewer.events[0]?.providerTimeouts?.requestTimeoutMs, {
    value: 1000,
    source: "agent",
  });
  t.mock.timers.tick(999);
  assert.equal(reviewer.aborted(), false);
  t.mock.timers.tick(1);
  assert.equal(reviewer.aborted(), true);
  await finite;

  const implementor = request("implementor");
  const unlimited = implementor.run();
  await Promise.resolve();
  assert.equal(implementor.timeoutMs(), 2147483647);
  assert.deepEqual(implementor.events[0]?.providerTimeouts?.requestTimeoutMs, {
    value: 0,
    source: "workflow",
    mode: "unlimited",
  });
  assert.equal(
    piRequestTimeoutMs(resolveRequestTimeout(cfg, "implementor")),
    2147483647,
  );
  t.mock.timers.tick(300001);
  assert.equal(implementor.aborted(), false);
  implementor.finish();
  await unlimited;
});

function errorMessage(errorMessage?: string): any {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    stopReason: errorMessage ? "error" : "stop",
    errorMessage,
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
