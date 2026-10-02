import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type Model,
} from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  ensureRouterModelReady,
  routerBaseUrl,
  type ModelPreflightEvent,
  type ModelPreflightUpdate,
} from "../src/agents/model-preflight.ts";
import {
  configureNetworkRetry,
  type ProviderRequestEvent,
} from "../src/agents/network-retry.ts";
import { ProgressRuntime } from "../src/ui/runtime.ts";
import { renderProgress } from "../src/ui/progress.ts";
import { newState } from "../src/workflow/state.ts";
import { AttemptLogger } from "../src/workflow/agent-logs.ts";
import { config } from "./helpers.ts";

let port = 19000;
const base = () => `http://127.0.0.1:${++port}`;
const model = (id: string, baseUrl: string) =>
  ({
    id,
    name: id,
    provider: "local",
    api: "openai-completions",
    baseUrl,
  }) as Model<Api>;
type Status = {
  value: string;
  failed?: boolean;
  exit_code?: number;
  progress?: unknown;
};
type Router = {
  fetch: typeof fetch;
  calls: string[];
  loadCount: () => number;
};
function router(
  sequences: Record<string, Status[]>,
  unsupported = false,
): Router {
  const calls: string[] = [];
  let loads = 0;
  const indices = new Map<string, number>();
  const fetchMock = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    calls.push(`${method} ${url.pathname}`);
    if (url.pathname === "/models/load") {
      loads++;
      const body = JSON.parse(String(init?.body));
      assert.ok(Object.hasOwn(sequences, body.model));
      return Response.json({ success: true });
    }
    assert.equal(url.pathname, "/models");
    if (unsupported)
      return Response.json({
        data: Object.keys(sequences).map((id) => ({ id })),
      });
    return Response.json({
      data: Object.entries(sequences).map(([id, statuses]) => {
        const index = indices.get(id) ?? 0;
        indices.set(id, index + 1);
        return { id, status: statuses[Math.min(index, statuses.length - 1)] };
      }),
    });
  };
  return { fetch: fetchMock as typeof fetch, calls, loadCount: () => loads };
}
function runtime(
  baseUrl: string,
  onInference?: (id: string) => void,
): ModelRuntime {
  return {
    getAuth: async () => ({ auth: { baseUrl, apiKey: "test-key" } }),
    streamSimple: (requestModel: Model<Api>) => {
      onInference?.(requestModel.id);
      const stream = createAssistantMessageEventStream();
      const message: AssistantMessage = {
        role: "assistant",
        content: [],
        api: requestModel.api,
        provider: requestModel.provider,
        model: requestModel.id,
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
      stream.push({ type: "done", reason: "stop", message });
      stream.end();
      return stream;
    },
  } as unknown as ModelRuntime;
}
async function ready(
  id: string,
  server: Router,
  options: {
    baseUrl?: string;
    signal?: AbortSignal;
    events?: ModelPreflightEvent[];
    updates?: ModelPreflightUpdate[];
  } = {},
) {
  const baseUrl = options.baseUrl ?? base();
  await ensureRouterModelReady(
    runtime(baseUrl),
    model(id, baseUrl),
    { fetch: server.fetch },
    {
      signal: options.signal,
      pollIntervalMs: 1,
      onEvent: (event) => options.events?.push(event),
      onUpdate: (update) => options.updates?.push(update),
    },
  );
}

test("Router base URL removes only a final /v1", () => {
  assert.equal(routerBaseUrl("http://mini:8080/v1")?.href, "http://mini:8080/");
  assert.equal(routerBaseUrl("http://mini:8080/")?.href, "http://mini:8080/");
  assert.equal(routerBaseUrl("http://mini:8080/proxy/v1"), undefined);
});

test("already loaded model starts inference without load or wait", async () => {
  const server = router({ a: [{ value: "loaded" }] });
  const events: ModelPreflightEvent[] = [];
  await ready("a", server, { events });
  assert.equal(server.loadCount(), 0);
  assert.deepEqual(server.calls, ["GET /models"]);
  assert.deepEqual(
    events.map((event) => event.type),
    ["model_preflight_start", "model_status", "model_preflight_ready"],
  );
});

test("unloaded model is loaded once and awaited", async () => {
  const server = router({
    a: [{ value: "unloaded" }, { value: "loading" }, { value: "loaded" }],
  });
  const events: ModelPreflightEvent[] = [];
  await ready("a", server, { events });
  assert.equal(server.loadCount(), 1);
  assert.deepEqual(
    events.map((event) => event.type),
    [
      "model_preflight_start",
      "model_status",
      "model_load_requested",
      "model_status",
      "model_status",
      "model_preflight_ready",
    ],
  );
});

test("already loading model waits without duplicate load or status logs", async () => {
  const server = router({
    a: [{ value: "loading" }, { value: "loading" }, { value: "loaded" }],
  });
  const events: ModelPreflightEvent[] = [];
  await ready("a", server, { events });
  assert.equal(server.loadCount(), 0);
  assert.deepEqual(
    events
      .filter((event) => event.type === "model_status")
      .map((event) => event.status),
    ["loading", "loaded"],
  );
});

test("loading progress updates TUI only when Router supplies valid values", async () => {
  const server = router({
    a: [
      { value: "loading", progress: { value: 0.21 } },
      { value: "loading", progress: { value: 0.44 } },
      { value: "loading", progress: { value: 0.83 } },
      { value: "loaded" },
    ],
  });
  const updates: ModelPreflightUpdate[] = [];
  await ready("a", server, { updates });
  assert.deepEqual(
    updates
      .filter(
        (update) =>
          update.kind === "model_preflight" && update.progress !== undefined,
      )
      .map((update) =>
        Math.round((update as { progress: number }).progress * 100),
      ),
    [21, 44, 83],
  );
});

test("sleeping model is routable without a redundant load request", async () => {
  const server = router({
    a: [{ value: "sleeping" }, { value: "loading" }, { value: "loaded" }],
  });
  await ready("a", server);
  assert.equal(server.loadCount(), 0);
  assert.deepEqual(server.calls, ["GET /models"]);
});

test("downloading model waits without another download", async () => {
  const server = router({
    a: [{ value: "downloading" }, { value: "loading" }, { value: "loaded" }],
  });
  await ready("a", server);
  assert.equal(server.loadCount(), 0);
});

test("Router downloaded transition is awaited before inference", async () => {
  const server = router({
    a: [
      { value: "downloading" },
      { value: "downloaded" },
      { value: "loading" },
      { value: "loaded" },
    ],
  });
  await ready("a", server);
  assert.equal(server.loadCount(), 0);
});

test("failed load prevents inference and exposes exit code", async () => {
  const server = router({
    a: [
      { value: "unloaded" },
      { value: "unloaded", failed: true, exit_code: 1 },
    ],
  });
  const events: ModelPreflightEvent[] = [];
  await assert.rejects(
    ready("a", server, { events }),
    /Model failed to load: a.*exit code: 1/,
  );
  assert.equal(events.at(-1)?.type, "model_preflight_failed");
  assert.equal(events.at(-1)?.exitCode, 1);
});

test("unknown model fails without load or substitution", async () => {
  const server = router({ a: [{ value: "loaded" }] });
  await assert.rejects(
    ready("b", server),
    /Configured model is not available.*b/,
  );
  assert.equal(server.loadCount(), 0);
});

test("ordinary OpenAI-compatible model list falls back", async () => {
  const server = router({ a: [{ value: "loaded" }] }, true);
  await ready("a", server);
  assert.equal(server.loadCount(), 0);
});

test("built-in OpenAI provider is not probed", async () => {
  const url = base();
  const server = router({ a: [{ value: "loaded" }] });
  await ensureRouterModelReady(
    runtime(url),
    { ...model("a", url), provider: "openai" },
    { fetch: server.fetch },
    { pollIntervalMs: 1 },
  );
  assert.deepEqual(server.calls, []);
});

test("unsupported provider still starts its first inference request", async () => {
  const url = base();
  const server = router({ a: [{ value: "loaded" }] }, true);
  let inference = 0;
  const pi = runtime(url, () => inference++);
  const provider: ProviderRequestEvent[] = [];
  configureNetworkRetry(
    pi,
    { maxRetries: 0, delayMs: 1 },
    () => undefined,
    undefined,
    (event) => provider.push(event),
    Date.now,
    undefined,
    () => () => {},
    (selected, options, signal, onEvent, onUpdate) =>
      ensureRouterModelReady(
        pi,
        selected,
        { ...options, fetch: server.fetch },
        { signal, pollIntervalMs: 1, onEvent, onUpdate },
      ),
  );
  await pi.streamSimple(model("a", url), { messages: [] }).result();
  assert.equal(inference, 1);
  assert.deepEqual(
    provider
      .filter((event) => event.type === "provider_request_start")
      .map((event) => event.providerRequest),
    [1],
  );
});

test("failed Router preflight never increments provider request or runs inference", async () => {
  const url = base();
  const server = router({
    a: [
      { value: "unloaded" },
      { value: "unloaded", failed: true, exit_code: 1 },
    ],
  });
  let inference = 0;
  const pi = runtime(url, () => inference++);
  const provider: ProviderRequestEvent[] = [];
  configureNetworkRetry(
    pi,
    { maxRetries: 0, delayMs: 1 },
    () => undefined,
    undefined,
    (event) => provider.push(event),
    Date.now,
    undefined,
    () => () => {},
    (selected, options, signal, onEvent, onUpdate) =>
      ensureRouterModelReady(
        pi,
        selected,
        { ...options, fetch: server.fetch },
        { signal, pollIntervalMs: 1, onEvent, onUpdate },
      ),
  );
  const result = await pi
    .streamSimple(model("a", url), { messages: [] })
    .result();
  assert.equal(result.stopReason, "error");
  assert.match(result.errorMessage ?? "", /Model failed to load.*exit code: 1/);
  assert.equal(inference, 0);
  assert.equal(provider.length, 0);
});

test("JSONL records status transitions without a line per identical poll", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-team-preflight-"));
  try {
    await writeFile(join(dir, "attempt.jsonl"), "");
    const logger = new AttemptLogger(join(dir, "attempt.jsonl"));
    const server = router({
      a: [{ value: "loading" }, { value: "loading" }, { value: "loaded" }],
    });
    const events: ModelPreflightEvent[] = [];
    await ready("a", server, { events });
    for (const event of events) logger.append(event);
    await logger.flush();
    const lines = (await readFile(join(dir, "attempt.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.deepEqual(
      lines.map((line) => line.type),
      [
        "model_preflight_start",
        "model_status",
        "model_status",
        "model_preflight_ready",
      ],
    );
    assert.deepEqual(
      lines
        .filter((line) => line.type === "model_status")
        .map((line) => line.status),
      ["loading", "loaded"],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("abort while loading stops polling promptly and does not load", async () => {
  const controller = new AbortController();
  const server = router({ a: [{ value: "loading" }] });
  const events: ModelPreflightEvent[] = [];
  const task = ready("a", server, { signal: controller.signal, events });
  await new Promise((resolve) => setTimeout(resolve, 5));
  controller.abort();
  await assert.rejects(task);
  const count = server.calls.length;
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(server.calls.length, count);
  assert.equal(server.loadCount(), 0);
});

test("stream wrapper aborts preflight without starting inference or a provider request", async () => {
  const url = base();
  const server = router({ a: [{ value: "loading" }] });
  const controller = new AbortController();
  let inference = 0;
  const provider: ProviderRequestEvent[] = [];
  const pi = runtime(url, () => inference++);
  configureNetworkRetry(
    pi,
    { maxRetries: 0, delayMs: 1 },
    () => controller.signal,
    undefined,
    (event) => provider.push(event),
    Date.now,
    undefined,
    () => () => {},
    (selected, options, signal, onEvent, onUpdate) =>
      ensureRouterModelReady(
        pi,
        selected,
        { ...options, fetch: server.fetch },
        { signal, pollIntervalMs: 1, onEvent, onUpdate },
      ),
    (event) => {
      if (event.type === "model_status" && event.status === "loading")
        controller.abort();
    },
  );
  const result = await pi
    .streamSimple(model("a", url), { messages: [] })
    .result();
  assert.equal(result.stopReason, "aborted");
  assert.equal(inference, 0);
  assert.equal(provider.length, 0);
});

test("concurrent same-model callers share one load and either may abort independently", async () => {
  const url = base();
  const server = router({
    a: [
      { value: "unloaded" },
      { value: "loading" },
      { value: "loading" },
      { value: "loaded" },
    ],
  });
  const controller = new AbortController();
  const first = ready("a", server, { baseUrl: url, signal: controller.signal });
  const second = ready("a", server, { baseUrl: url });
  controller.abort();
  await assert.rejects(first);
  await second;
  assert.equal(server.loadCount(), 1);
});

test("concurrent different models keep readiness state separate", async () => {
  const url = base();
  const server = router({
    a: [{ value: "unloaded" }, { value: "loading" }, { value: "loaded" }],
    b: [{ value: "loading" }, { value: "loading" }, { value: "loaded" }],
  });
  await Promise.all([
    ready("a", server, { baseUrl: url }),
    ready("b", server, { baseUrl: url }),
  ]);
  assert.equal(server.loadCount(), 1);
});

test("model switch completes preflight before provider request numbering and timer", async () => {
  const url = base();
  const server = router({
    a: [{ value: "loaded" }],
    b: [
      { value: "unloaded" },
      { value: "unloaded" },
      { value: "loading" },
      { value: "loaded" },
    ],
  });
  const order: string[] = [];
  const provider: ProviderRequestEvent[] = [];
  const preflight: ModelPreflightEvent[] = [];
  const pi = runtime(url, (id) => order.push(`inference:${id}`));
  configureNetworkRetry(
    pi,
    { maxRetries: 0, delayMs: 1 },
    () => undefined,
    undefined,
    (event) => {
      provider.push(event);
      order.push(event.type);
    },
    Date.now,
    undefined,
    () => () => {},
    (selected, options, signal, onEvent, onUpdate) =>
      ensureRouterModelReady(
        pi,
        selected,
        { ...options, fetch: server.fetch },
        { signal, pollIntervalMs: 1, onEvent, onUpdate },
      ),
    (event) => {
      preflight.push(event);
      order.push(`${event.type}:${event.model}`);
    },
  );
  await pi
    .streamSimple(model("a", url), { messages: [] }, { timeoutMs: 300000 })
    .result();
  await pi
    .streamSimple(model("b", url), { messages: [] }, { timeoutMs: 300000 })
    .result();
  assert.equal(server.loadCount(), 1);
  assert.deepEqual(
    provider
      .filter((event) => event.type === "provider_request_start")
      .map((event) => event.providerRequest),
    [1, 2],
  );
  assert.ok(
    order.indexOf("model_preflight_ready:b") <
      order.lastIndexOf("provider_request_start"),
  );
  assert.ok(
    order.lastIndexOf("provider_request_start") < order.indexOf("inference:b"),
  );
  assert.equal(
    provider.findLast((event) => event.type === "provider_request_start")
      ?.providerTimeouts?.requestTimeoutMs,
    300000,
  );
  assert.deepEqual(
    preflight
      .filter((event) => event.type === "model_status" && event.model === "b")
      .map((event) => event.status),
    ["unloaded", "loading", "loaded"],
  );
});

test("TUI changes from model loading progress to provider and tool activity", () => {
  const state = newState("/tmp/fixture", "task", config(), {
    head: null,
    dirtyPaths: [],
    status: "",
    diff: "",
    cachedDiff: "",
  });
  const ui = new ProgressRuntime(
    () => {},
    2000,
    () => 1000,
    false,
  );
  ui.bind(state);
  ui.event({ type: "start", role: "solver1", attempt: 1 });
  const send = (update: ModelPreflightUpdate) =>
    ui.event({
      type: "modelPreflight",
      role: "solver1",
      workflowId: state.id,
      attempt: 1,
      update,
    });
  send({
    kind: "model_preflight",
    model: "a",
    state: "checking",
    startedAt: 1000,
  });
  assert.match(renderProgress(state, ui).join("\n"), /↳ checking model/);
  send({
    kind: "model_preflight",
    model: "a",
    state: "loading",
    startedAt: 1000,
  });
  assert.match(renderProgress(state, ui).join("\n"), /↳ loading model\n/);
  send({
    kind: "model_preflight",
    model: "a",
    state: "loading",
    startedAt: 1000,
    progress: 0.44,
  });
  assert.match(renderProgress(state, ui).join("\n"), /↳ loading model · 44%/);
  send({ kind: "model_preflight_end" });
  ui.event({
    type: "providerProgress",
    role: "solver1",
    workflowId: state.id,
    attempt: 1,
    update: {
      providerRequest: 1,
      startedAt: 1000,
      state: "waiting",
      streamEventCount: 0,
    },
  });
  assert.match(
    renderProgress(state, ui).join("\n"),
    /↳ waiting for model response/,
  );
  ui.event({
    type: "providerProgress",
    role: "solver1",
    workflowId: state.id,
    attempt: 1,
    update: {
      providerRequest: 1,
      startedAt: 1000,
      state: "reasoning",
      streamEventCount: 1,
      lastActivityAt: 1000,
    },
  });
  assert.match(renderProgress(state, ui).join("\n"), /↳ reasoning · active/);
  ui.event({ type: "activity", role: "solver1", toolName: "read" });
  assert.match(renderProgress(state, ui).join("\n"), /↳ Reading files/);
});
