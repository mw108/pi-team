import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import YAML from "yaml";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Model,
  type Api,
} from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { config, repository, FixtureRunner, output } from "./helpers.ts";
import { configSchema } from "../src/config/schema.ts";
import { teamRoot } from "../src/config/project.ts";
import {
  classifyRequestFailure,
  configureNetworkRetry,
  explainRequestFailure,
  resolveNetworkRetry,
  type NetworkRetryEvent,
  type ProviderRequestEvent,
} from "../src/agents/network-retry.ts";
import { PiRunner } from "../src/agents/runner.ts";
import { WorkflowEngine } from "../src/workflow/engine.ts";
import { AgentLogStore } from "../src/workflow/agent-logs.ts";
import { ProgressRuntime } from "../src/ui/runtime.ts";
import { renderProgress } from "../src/ui/progress.ts";
import type { Role } from "../src/agents/schemas.ts";

const model = {
  api: "openai-completions",
  provider: "fixture",
  id: "fixture",
} as Model<Api>;
function message(
  stopReason: "stop" | "error",
  errorMessage?: string,
): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    stopReason,
    errorMessage,
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
function fixtureRuntime(failures: string[]) {
  let requests = 0;
  const contexts: unknown[] = [];
  const options: unknown[] = [];
  const runtime = {
    streamSimple: (
      _model: unknown,
      context: unknown,
      requestOptions: unknown,
    ) => {
      contexts.push(context);
      options.push(requestOptions);
      requests++;
      const stream = createAssistantMessageEventStream();
      const error = failures.shift();
      if (error)
        stream.push({
          type: "error",
          reason: "error",
          error: message("error", error),
        });
      else
        stream.push({ type: "done", reason: "stop", message: message("stop") });
      return stream;
    },
  } as unknown as ModelRuntime;
  return {
    runtime,
    contexts,
    options,
    get requests() {
      return requests;
    },
  };
}

function transportError(code: string): TypeError {
  const cause = Object.assign(new Error(`read ${code}`), {
    code,
    syscall: "read",
  });
  return new TypeError("terminated", { cause });
}

function rawCauseRuntime(failures: unknown[]) {
  let requests = 0;
  const contexts: unknown[] = [];
  const runtime = {
    streamSimple: (_model: unknown, context: unknown, options: any) => {
      requests++;
      contexts.push(context);
      const stream = createAssistantMessageEventStream();
      void (async () => {
        try {
          await options.fetch("http://localhost/fixture");
          stream.push({
            type: "done",
            reason: "stop",
            message: message("stop"),
          });
        } catch {
          stream.push({
            type: "error",
            reason: "error",
            error: message("error", "terminated"),
          });
        }
        stream.end();
      })();
      return stream;
    },
  } as unknown as ModelRuntime;
  const fetch = async () => {
    const error = failures.shift();
    if (error) throw error;
    return new Response("ok");
  };
  return {
    runtime,
    contexts,
    fetch,
    get requests() {
      return requests;
    },
  };
}

test("network configuration defaults, per-field inheritance and validation", () => {
  const cfg = config();
  assert.deepEqual(resolveNetworkRetry(cfg, "researcher"), {
    maxRetries: 10,
    delayMs: 3000,
  });
  cfg.agents.researcher.networkRetry = { maxRetries: 0 };
  assert.deepEqual(resolveNetworkRetry(cfg, "researcher"), {
    maxRetries: 0,
    delayMs: 3000,
  });
  cfg.agents.solver1.networkRetry = { delayMs: 2000 };
  assert.deepEqual(resolveNetworkRetry(cfg, "solver1"), {
    maxRetries: 10,
    delayMs: 2000,
  });
  for (const invalid of [0, -1, 1.5, NaN, Infinity, "100"]) {
    assert.equal(
      configSchema.safeParse({
        ...cfg,
        workflow: {
          ...cfg.workflow,
          networkRetry: { maxRetries: 10, delayMs: invalid },
        },
      }).success,
      false,
    );
    assert.equal(
      configSchema.safeParse({
        ...cfg,
        agents: {
          ...cfg.agents,
          researcher: {
            ...cfg.agents.researcher,
            networkRetry: { delayMs: invalid },
          },
        },
      }).success,
      false,
    );
  }
  for (const invalid of [-1, 1.5, NaN, Infinity, "0"])
    assert.equal(
      configSchema.safeParse({
        ...cfg,
        agents: {
          ...cfg.agents,
          researcher: {
            ...cfg.agents.researcher,
            networkRetry: { maxRetries: invalid },
          },
        },
      }).success,
      false,
    );
});

test("network retry edits are accepted as runtime drift", async () => {
  const cwd = await repository();
  const path = join(teamRoot(cwd), "team.yaml");
  const cfg = config();
  await writeFile(path, YAML.stringify(cfg));
  const runner = new FixtureRunner();
  const engine = new WorkflowEngine(cwd, runner, {
    progress: () => {},
    ask: async () => undefined,
  });
  const state = await engine.start("task", cfg);
  state.phase = "RESEARCH";
  state.inFlight = { phase: "RESEARCH", roles: ["researcher"] };
  await engine.store.save(state);
  const changed = YAML.parse(await readFile(path, "utf8"));
  changed.agents.researcher.networkRetry = { maxRetries: 0, delayMs: 2000 };
  await writeFile(path, YAML.stringify(changed));
  await engine.run(state);
  assert.equal(state.phase, "DONE", state.blocker);
  assert.equal(state.config.agents.researcher.networkRetry?.maxRetries, 0);
  assert.ok(
    state.history.some((event) => event.event === "config_drift_accepted"),
  );
});

test("request classifier limits retries to transport, 502-504, and 429", () => {
  for (const code of [
    "ECONNRESET",
    "ECONNREFUSED",
    "EPIPE",
    "ENETUNREACH",
    "EHOSTUNREACH",
    "ECONNABORTED",
    "ETIMEDOUT",
    "EAI_AGAIN",
    "UND_ERR_SOCKET",
  ])
    assert.equal(
      classifyRequestFailure(Object.assign(new Error("failed"), { code })),
      "transport",
    );
  assert.equal(classifyRequestFailure(new Error("fetch failed")), "transport");
  for (const message of [
    "Connection error.",
    "Network error",
    "Request timed out.",
    "Provider finish_reason: network_error",
    "Stream ended without finish_reason",
  ])
    assert.equal(classifyRequestFailure(new Error(message)), "transport");
  for (const status of [502, 503, 504])
    assert.equal(classifyRequestFailure({ status }), "provider");
  assert.equal(classifyRequestFailure({ status: 429 }), "rate_limit");
  for (const status of [400, 401, 403, 404, 500])
    assert.equal(
      classifyRequestFailure({ status, message: "network error" }),
      undefined,
    );
  assert.equal(
    classifyRequestFailure(new Error("400: fetch failed")),
    undefined,
  );
  for (const value of [
    "invalid API key",
    "schema validation failure",
    "tool failure",
    "context overflow",
    "Tool request timed out",
  ])
    assert.equal(classifyRequestFailure(new Error(value)), undefined);
});

test("bounded classifier reports top-level and nested structured transport codes", () => {
  for (const code of [
    "ETIMEDOUT",
    "ECONNRESET",
    "ECONNREFUSED",
    "ECONNABORTED",
    "EPIPE",
    "ENETUNREACH",
    "EHOSTUNREACH",
    "EAI_AGAIN",
    "UND_ERR_SOCKET",
    "UND_ERR_CONNECT_TIMEOUT",
    "UND_ERR_HEADERS_TIMEOUT",
    "UND_ERR_BODY_TIMEOUT",
  ]) {
    assert.deepEqual(explainRequestFailure({ code }), {
      classification: "transport",
      matchedRule: `error.code=${code}`,
    });
    assert.deepEqual(explainRequestFailure(transportError(code)), {
      classification: "transport",
      matchedRule: `cause.code=${code}`,
    });
  }
  assert.deepEqual(explainRequestFailure(new TypeError("terminated")), {
    classification: "other",
    matchedRule: null,
  });
  const deep = { cause: { cause: { code: "UND_ERR_SOCKET" } } };
  assert.equal(
    explainRequestFailure(deep).matchedRule,
    "cause.cause.code=UND_ERR_SOCKET",
  );
  const tooDeep = {
    cause: { cause: { cause: { cause: { cause: { code: "ETIMEDOUT" } } } } },
  };
  assert.equal(classifyRequestFailure(tooDeep), undefined);
  const circular: { cause?: unknown } = {};
  circular.cause = circular;
  assert.equal(classifyRequestFailure(circular), undefined);
});

test("nested ETIMEDOUT retries the same provider context and keeps diagnostic cause", async () => {
  const fixture = rawCauseRuntime([transportError("ETIMEDOUT")]);
  const network: NetworkRetryEvent[] = [];
  const requests: ProviderRequestEvent[] = [];
  configureNetworkRetry(
    fixture.runtime,
    { maxRetries: 10, delayMs: 1 },
    () => undefined,
    (event) => network.push(event),
    (event) => requests.push(event),
  );
  const context = {
    messages: [{ role: "user", content: "prior work" }],
  } as any;
  assert.equal(
    (
      await fixture.runtime
        .streamSimple(model, context, { fetch: fixture.fetch })
        .result()
    ).stopReason,
    "stop",
  );
  assert.equal(fixture.requests, 2);
  assert.ok(fixture.contexts.every((value) => value === context));
  assert.equal(
    network.find((event) => event.type === "network_retry_scheduled")?.retry,
    1,
  );
  assert.equal(network.at(-1)?.type, "network_recovered");
  const failure = requests.find(
    (event) => event.type === "provider_request_failure",
  );
  assert.equal(failure?.classification, "network");
  assert.equal(failure?.matchedRule, "cause.code=ETIMEDOUT");
  assert.equal(failure?.error?.message, "terminated");
  assert.equal(failure?.error?.cause?.code, "ETIMEDOUT");
  assert.equal(failure?.error?.cause?.syscall, "read");
});

test("abort takes precedence over a nested transport cause", async () => {
  const controller = new AbortController();
  const fixture = rawCauseRuntime([transportError("ETIMEDOUT")]);
  const requests: ProviderRequestEvent[] = [];
  const runtime = fixture.runtime;
  configureNetworkRetry(
    runtime,
    { maxRetries: 10, delayMs: 1 },
    () => controller.signal,
    undefined,
    (event) => requests.push(event),
  );
  const result = await runtime
    .streamSimple(
      model,
      { messages: [] },
      {
        fetch: async () => {
          controller.abort();
          throw transportError("ETIMEDOUT");
        },
      },
    )
    .result();
  assert.equal(result.stopReason, "error");
  assert.equal(fixture.requests, 1);
  const failure = requests.find(
    (event) => event.type === "provider_request_failure",
  );
  assert.equal(failure?.classification, "other");
  assert.equal(failure?.matchedRule, "signal=aborted");
});

test("recovery reissues one model request in the same session and disables provider retries", async () => {
  const fixture = fixtureRuntime(["ECONNRESET", "fetch failed"]);
  const events: NetworkRetryEvent[] = [];
  configureNetworkRetry(
    fixture.runtime,
    { maxRetries: 3, delayMs: 1 },
    () => undefined,
    (e) => events.push(e),
  );
  const context = {
    messages: [{ role: "user", content: "prior work" }],
  } as any;
  assert.equal(
    (await fixture.runtime.streamSimple(model, context).result()).stopReason,
    "stop",
  );
  assert.equal(fixture.requests, 3);
  assert.ok(fixture.contexts.every((c) => c === context));
  assert.ok(fixture.options.every((o) => (o as any).maxRetries === 0));
  assert.deepEqual(
    events.map((e) => e.type),
    [
      "network_error",
      "network_retry_scheduled",
      "network_retry_started",
      "network_error",
      "network_retry_scheduled",
      "network_retry_started",
      "network_recovered",
    ],
  );
});

test("Pi 0.87.1 OpenAI-compatible stream reconnects after an SDK transport failure", async () => {
  const localModel = {
    ...model,
    name: "Fixture",
    baseUrl: "http://127.0.0.1:9/v1",
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 32768,
    maxTokens: 100,
  } as Model<Api>;
  const runtime = {
    streamSimple: (requestModel: Model<Api>, context: any, options: any) =>
      streamSimple(requestModel, context, options),
  } as unknown as ModelRuntime;
  const observed: NetworkRetryEvent[] = [];
  configureNetworkRetry(
    runtime,
    { maxRetries: 2, delayMs: 1 },
    () => undefined,
    (e) => observed.push(e),
  );
  let requests = 0;
  const fetchMock = async () => {
    requests++;
    if (requests === 1)
      throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
    const chunk = `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 0, model: "fixture", choices: [{ index: 0, delta: { content: "ok" }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 0, model: "fixture", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`;
    return new Response(chunk, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  };
  const context = {
    messages: [
      {
        role: "user" as const,
        content: [{ type: "text" as const, text: "hi" }],
        timestamp: Date.now(),
      },
    ],
  };
  const result = await runtime
    .streamSimple(localModel, context, { apiKey: "local", fetch: fetchMock })
    .result();
  assert.equal(result.stopReason, "stop");
  assert.equal(requests, 2);
  assert.equal(
    observed.filter((e) => e.type === "network_retry_started").length,
    1,
  );
  assert.equal(observed.at(-1)?.type, "network_recovered");
});

test("retry exhaustion stays in one attempt log and never consumes hard retries", async () => {
  const cwd = await repository();
  const cfg = config();
  cfg.workflow.networkRetry = { maxRetries: 3, delayMs: 100 };
  const fixture = fixtureRuntime(Array(4).fill("ECONNRESET"));
  const runner = new PiRunner();
  let sessions = 0;
  runner.createSession = async (
    _role,
    _state,
    _evidence,
    _activity,
    network,
    getSignal,
  ) => {
    sessions++;
    configureNetworkRetry(
      fixture.runtime,
      resolveNetworkRetry(cfg, "researcher"),
      getSignal ?? (() => undefined),
      network,
    );
    const session: any = {
      messages: [],
      prompt: async () => {
        session.messages.push(
          await fixture.runtime
            .streamSimple(model, { messages: session.messages })
            .result(),
        );
      },
      abort: async () => {},
      getLastAssistantText: () => JSON.stringify(output("researcher")),
      extensionRunner: { emit: async () => {} },
      dispose: () => {},
    };
    return session;
  };
  const engine = new WorkflowEngine(cwd, runner, {
    progress: () => {},
    ask: async () => undefined,
  });
  const state = await engine.start("Reconnect exhaustion", cfg);
  await assert.rejects(() => engine.invoke("researcher", state), /ECONNRESET/);
  assert.equal(sessions, 1);
  assert.equal(fixture.requests, 4);
  assert.equal(
    state.history.filter((e) => e.event === "agent_retry").length,
    0,
  );
  const logs = new AgentLogStore(cwd);
  assert.deepEqual(await logs.attempts(state.id, "researcher"), [1]);
  const events = await logs.read(state.id, "researcher", 1);
  assert.equal(
    events.filter((e) => e.type === "network_retry_started").length,
    3,
  );
  assert.ok(events.some((e) => e.type === "network_retries_exhausted"));
  assert.match(await logs.timeline(state.id, "researcher"), /reconnect 3\/3/);
});

test("temporary failure recovers within one engine attempt without agent failures", async () => {
  const cwd = await repository();
  const cfg = config();
  cfg.workflow.networkRetry = { maxRetries: 3, delayMs: 100 };
  const fixture = fixtureRuntime(["ECONNRESET", "ECONNRESET"]);
  const runner = new PiRunner();
  let sessions = 0;
  runner.createSession = async (
    _role,
    _state,
    _evidence,
    _activity,
    network,
    getSignal,
  ) => {
    sessions++;
    configureNetworkRetry(
      fixture.runtime,
      resolveNetworkRetry(cfg, "researcher"),
      getSignal ?? (() => undefined),
      network,
    );
    const session: any = {
      messages: [],
      prompt: async () => {
        session.messages.push(
          await fixture.runtime
            .streamSimple(model, { messages: session.messages })
            .result(),
        );
      },
      abort: async () => {},
      getLastAssistantText: () => JSON.stringify(output("researcher")),
      extensionRunner: { emit: async () => {} },
      dispose: () => {},
    };
    return session;
  };
  const engine = new WorkflowEngine(cwd, runner, {
    progress: () => {},
    ask: async () => undefined,
  });
  const state = await engine.start("Reconnect recovery", cfg);
  const result = await engine.invoke("researcher", state);
  assert.equal(result.failures, 0);
  assert.equal(sessions, 1);
  assert.equal(fixture.requests, 3);
  assert.equal(state.agentFailures, 0);
  assert.equal(
    state.history.filter((e) => e.event === "agent_retry").length,
    0,
  );
  const logs = new AgentLogStore(cwd);
  assert.deepEqual(await logs.attempts(state.id, "researcher"), [1]);
  const events = await logs.read(state.id, "researcher", 1);
  assert.equal(
    events.filter((e) => e.type === "network_retry_started").length,
    2,
  );
  assert.equal(events.filter((e) => e.type === "network_recovered").length, 1);
  assert.ok(
    events.every((e) => e.agentAttempt === undefined || e.agentAttempt === 1),
  );
  assert.match(
    await logs.timeline(state.id, "researcher"),
    /connection recovered/,
  );
});

function rawCauseRunner(
  cfg: ReturnType<typeof config>,
  fixture: ReturnType<typeof rawCauseRuntime>,
) {
  const runner = new PiRunner();
  let sessions = 0;
  runner.createSession = async (
    _role,
    _state,
    _evidence,
    _activity,
    network,
    getSignal,
    _guard,
    providerEvent,
  ) => {
    sessions++;
    configureNetworkRetry(
      fixture.runtime,
      resolveNetworkRetry(cfg, "researcher"),
      getSignal ?? (() => undefined),
      network,
      providerEvent,
    );
    const session: any = {
      messages: [],
      prompt: async () => {
        session.messages.push(
          await fixture.runtime
            .streamSimple(
              model,
              { messages: session.messages },
              { fetch: fixture.fetch },
            )
            .result(),
        );
      },
      abort: async () => {},
      getLastAssistantText: () => JSON.stringify(output("researcher")),
      extensionRunner: { emit: async () => {} },
      dispose: () => {},
    };
    return session;
  };
  return {
    runner,
    get sessions() {
      return sessions;
    },
  };
}

test("nested ETIMEDOUT recovers in one engine attempt and logs the matched cause", async () => {
  const cwd = await repository();
  const cfg = config();
  cfg.workflow.networkRetry = { maxRetries: 10, delayMs: 100 };
  const fixture = rawCauseRuntime([transportError("ETIMEDOUT")]);
  const setup = rawCauseRunner(cfg, fixture);
  const engine = new WorkflowEngine(cwd, setup.runner, {
    progress: () => {},
    ask: async () => undefined,
  });
  const state = await engine.start("Nested timeout recovery", cfg);
  const result = await engine.invoke("researcher", state);
  assert.equal(result.failures, 0);
  assert.equal(state.agentFailures, 0);
  assert.equal(setup.sessions, 1);
  assert.equal(fixture.requests, 2);
  const logs = new AgentLogStore(cwd);
  assert.deepEqual(await logs.attempts(state.id, "researcher"), [1]);
  const events = await logs.read(state.id, "researcher", 1);
  const failure = events.find(
    (event) => event.type === "provider_request_failure",
  );
  assert.equal(failure?.classification, "network");
  assert.equal(failure?.matchedRule, "cause.code=ETIMEDOUT");
  assert.equal((failure?.error as any)?.cause?.code, "ETIMEDOUT");
  assert.equal(
    events.filter((event) => event.type === "network_retry_started").length,
    1,
  );
  assert.equal(
    events.filter((event) => event.type === "network_recovered").length,
    1,
  );
  assert.equal(
    events.some((event) => event.type === "provider_error"),
    false,
  );
  assert.match(
    await logs.timeline(state.id, "researcher"),
    /classification: network \(cause.code=ETIMEDOUT\)/,
  );
});

test("nested ETIMEDOUT exhausts two retries in one engine attempt", async () => {
  const cwd = await repository();
  const cfg = config();
  cfg.workflow.networkRetry = { maxRetries: 2, delayMs: 100 };
  const fixture = rawCauseRuntime(
    Array.from({ length: 3 }, () => transportError("ETIMEDOUT")),
  );
  const setup = rawCauseRunner(cfg, fixture);
  const engine = new WorkflowEngine(cwd, setup.runner, {
    progress: () => {},
    ask: async () => undefined,
  });
  const state = await engine.start("Nested timeout exhaustion", cfg);
  await assert.rejects(
    () => engine.invoke("researcher", state),
    /network retries exhausted; last provider code: ETIMEDOUT; Error: terminated/,
  );
  assert.equal(setup.sessions, 1);
  assert.equal(fixture.requests, 3);
  const logs = new AgentLogStore(cwd);
  assert.deepEqual(await logs.attempts(state.id, "researcher"), [1]);
  const events = await logs.read(state.id, "researcher", 1);
  assert.equal(
    events.filter((event) => event.type === "network_retry_started").length,
    2,
  );
  assert.ok(events.some((event) => event.type === "network_retries_exhausted"));
  const failure = events.find((event) => event.type === "provider_error");
  assert.equal(failure?.classification, "network");
  assert.equal(failure?.matchedRule, "cause.code=ETIMEDOUT");
  assert.equal((failure?.networkRetry as any)?.currentRetry, 2);
  assert.equal((failure?.error as any)?.cause?.code, "ETIMEDOUT");
  assert.equal(
    state.history.filter((event) => event.event === "agent_retry").length,
    0,
  );
});

test("abort cancels a nested ETIMEDOUT retry delay before another request", async () => {
  const fixture = rawCauseRuntime([transportError("ETIMEDOUT")]);
  const controller = new AbortController();
  let scheduled!: () => void;
  const waiting = new Promise<void>((resolve) => {
    scheduled = resolve;
  });
  configureNetworkRetry(
    fixture.runtime,
    { maxRetries: 10, delayMs: 10000 },
    () => controller.signal,
    (event) => {
      if (event.type === "network_retry_scheduled") scheduled();
    },
  );
  const pending = fixture.runtime
    .streamSimple(model, { messages: [] }, { fetch: fixture.fetch })
    .result();
  await waiting;
  controller.abort();
  assert.equal((await pending).stopReason, "aborted");
  assert.equal(fixture.requests, 1);
});

test("agent wall-clock timeout wins over a later nested socket failure", async () => {
  const cwd = await repository();
  const cfg = config();
  cfg.agents.researcher.timeoutMs = 1000;
  cfg.workflow.maxAgentFailures = 1;
  const fixture = rawCauseRuntime([]);
  fixture.fetch = async () => {
    await new Promise((resolve) => setTimeout(resolve, 1100));
    throw transportError("UND_ERR_SOCKET");
  };
  const setup = rawCauseRunner(cfg, fixture);
  const engine = new WorkflowEngine(cwd, setup.runner, {
    progress: () => {},
    ask: async () => undefined,
  });
  const state = await engine.start("Agent timeout precedence", cfg);
  await assert.rejects(() => engine.invoke("researcher", state), /timed out/);
  assert.equal(fixture.requests, 1);
  const events = await new AgentLogStore(cwd).read(state.id, "researcher", 1);
  assert.equal(
    events.some((event) => event.type === "network_retry_scheduled"),
    false,
  );
  const request = events.find(
    (event) => event.type === "provider_request_failure",
  );
  assert.equal(request?.classification, "other");
  assert.equal(request?.matchedRule, "signal=aborted");
  const failure = events.find((event) => event.type === "provider_error");
  assert.equal(failure?.classification, "timeout");
  assert.equal(failure?.matchedRule, "AgentTimeoutError");
});

test("unlimited retry recovers; abort interrupts delay promptly", async () => {
  const fixture = fixtureRuntime(Array(5).fill("ECONNRESET"));
  configureNetworkRetry(
    fixture.runtime,
    { maxRetries: 0, delayMs: 1 },
    () => undefined,
  );
  assert.equal(
    (await fixture.runtime.streamSimple(model, { messages: [] }).result())
      .stopReason,
    "stop",
  );
  assert.equal(fixture.requests, 6);
  const abort = new AbortController();
  const waiting = fixtureRuntime(["ECONNRESET"]);
  configureNetworkRetry(
    waiting.runtime,
    { maxRetries: 0, delayMs: 10000 },
    () => abort.signal,
  );
  const pending = waiting.runtime
    .streamSimple(model, { messages: [] })
    .result();
  setTimeout(() => abort.abort(), 20);
  const start = Date.now();
  assert.equal((await pending).stopReason, "aborted");
  assert.ok(Date.now() - start < 500);
  assert.equal(waiting.requests, 1);
});

test("workflow cancellation interrupts an active reconnect delay", async () => {
  const cwd = await repository();
  const cfg = config();
  cfg.agents.researcher.timeoutMs = 0;
  cfg.agents.researcher.networkRetry = { maxRetries: 0, delayMs: 10000 };
  const fixture = fixtureRuntime(["ECONNRESET"]);
  const runner = new PiRunner();
  runner.createSession = async (
    _role,
    _state,
    _evidence,
    _activity,
    network,
    getSignal,
  ) => {
    configureNetworkRetry(
      fixture.runtime,
      resolveNetworkRetry(cfg, "researcher"),
      getSignal ?? (() => undefined),
      network,
    );
    const session: any = {
      messages: [],
      prompt: async () => {
        session.messages.push(
          await fixture.runtime.streamSimple(model, { messages: [] }).result(),
        );
      },
      abort: async () => {},
      getLastAssistantText: () => "",
      extensionRunner: { emit: async () => {} },
      dispose: () => {},
    };
    return session;
  };
  let reconnect!: () => void;
  const scheduled = new Promise<void>((resolve) => {
    reconnect = resolve;
  });
  const engine = new WorkflowEngine(cwd, runner, {
    progress: () => {},
    ask: async () => undefined,
    agentEvent: (event) => {
      if (event.type === "networkRetry") reconnect();
    },
  });
  const state = await engine.start("Stop reconnect", cfg);
  const controller = new AbortController();
  const pending = engine.invoke("researcher", state, controller.signal);
  await scheduled;
  const started = Date.now();
  controller.abort();
  await assert.rejects(pending, /Workflow interrupted|Request aborted/);
  assert.ok(Date.now() - started < 500);
  assert.equal(fixture.requests, 1);
  assert.equal(
    state.history.filter((e) => e.event === "agent_retry").length,
    0,
  );
});

test("manual retry cancels reconnect delay and starts a fresh Pi session", async () => {
  const cwd = await repository();
  const cfg = config();
  cfg.agents.researcher.timeoutMs = 0;
  cfg.agents.researcher.networkRetry = { maxRetries: 0, delayMs: 10000 };
  const fixture = fixtureRuntime(["ECONNRESET"]);
  const runner = new PiRunner();
  let created = 0;
  let disposed = 0;
  runner.createSession = async (
    _role,
    _state,
    _evidence,
    _activity,
    network,
    getSignal,
  ) => {
    created++;
    const current = created;
    if (current === 1)
      configureNetworkRetry(
        fixture.runtime,
        resolveNetworkRetry(cfg, "researcher"),
        getSignal ?? (() => undefined),
        network,
      );
    const session: any = {
      messages: [],
      prompt: async () => {
        session.messages.push(
          current === 1
            ? await fixture.runtime
                .streamSimple(model, { messages: [] })
                .result()
            : message("stop"),
        );
      },
      abort: async () => {},
      getLastAssistantText: () => JSON.stringify(output("researcher")),
      extensionRunner: { emit: async () => {} },
      dispose: () => {
        disposed++;
      },
    };
    return session;
  };
  let reconnect!: () => void;
  const scheduled = new Promise<void>((resolve) => {
    reconnect = resolve;
  });
  const engine = new WorkflowEngine(cwd, runner, {
    progress: () => {},
    ask: async () => undefined,
    agentEvent: (event) => {
      if (event.type === "networkRetry") reconnect();
    },
  });
  const state = await engine.start("Retry reconnect", cfg);
  const pending = engine.invoke("researcher", state);
  await scheduled;
  const started = Date.now();
  await engine.retryAgent(state, "researcher");
  const result = await pending;
  assert.equal(
    result.result.architectureSummary,
    output("researcher").architectureSummary,
  );
  assert.ok(Date.now() - started < 500);
  assert.equal(fixture.requests, 1);
  assert.equal(created, 2);
  assert.equal(disposed, 2);
  assert.equal(engine.sessions.list(state.id).length, 0);
  assert.equal(
    state.history.filter((event) => event.event === "agent_retry").length,
    0,
  );
});

test("HTTP 503 and 429 retry within the request layer; 429 honors Retry-After", async () => {
  let requests = 0;
  const delays: number[] = [];
  const events: NetworkRetryEvent[] = [];
  const runtime = {
    streamSimple: (_model: unknown, _context: unknown, options: any) => {
      const request = ++requests;
      const stream = createAssistantMessageEventStream();
      void (async () => {
        if (request === 2) await options.fetch("http://localhost/fixture");
        if (request < 3)
          stream.push({
            type: "error",
            reason: "error",
            error: message(
              "error",
              request === 1
                ? "503: temporarily unavailable"
                : "429: rate limited",
            ),
          });
        else
          stream.push({
            type: "done",
            reason: "stop",
            message: message("stop"),
          });
      })();
      return stream;
    },
  } as unknown as ModelRuntime;
  configureNetworkRetry(
    runtime,
    { maxRetries: 3, delayMs: 100 },
    () => undefined,
    (event) => {
      events.push(event);
      if (event.type === "network_retry_scheduled") delays.push(event.delayMs!);
    },
  );
  assert.equal(
    (
      await runtime
        .streamSimple(
          model,
          { messages: [] },
          {
            fetch: async () =>
              new Response("", {
                status: 429,
                headers: { "Retry-After": "0.001" },
              }),
          },
        )
        .result()
    ).stopReason,
    "stop",
  );
  assert.equal(requests, 3);
  assert.equal(delays[0], 100);
  assert.equal(
    events.filter((e) => e.type === "network_retry_started").length,
    2,
  );
  assert.equal(delays[1], 1);
});

test("agent wall-clock timeout still terminates unlimited reconnects", async () => {
  const cwd = await repository();
  const cfg = config();
  cfg.agents.researcher.timeoutMs = 1000;
  cfg.agents.researcher.networkRetry = { maxRetries: 0, delayMs: 100 };
  const runner = new PiRunner();
  let requests = 0;
  runner.createSession = async (
    _role,
    _state,
    _evidence,
    _activity,
    network,
    getSignal,
  ) => {
    const runtime = {
      streamSimple: () => {
        requests++;
        const stream = createAssistantMessageEventStream();
        stream.push({
          type: "error",
          reason: "error",
          error: message("error", "ECONNRESET"),
        });
        return stream;
      },
    } as unknown as ModelRuntime;
    configureNetworkRetry(
      runtime,
      resolveNetworkRetry(cfg, "researcher"),
      getSignal ?? (() => undefined),
      network,
    );
    const session: any = {
      messages: [],
      prompt: async () => {
        session.messages.push(
          await runtime.streamSimple(model, { messages: [] }).result(),
        );
      },
      abort: async () => {},
      getLastAssistantText: () => "",
      extensionRunner: { emit: async () => {} },
      dispose: () => {},
    };
    return session;
  };
  const engine = new WorkflowEngine(cwd, runner, {
    progress: () => {},
    ask: async () => undefined,
  });
  const state = await engine.start("Timeout during reconnect", cfg);
  await assert.rejects(() => engine.invoke("researcher", state), /timed out/);
  assert.ok(requests > 1);
});

test("parallel progress tracks each solver reconnect independently", () => {
  const cfg = config();
  const state = {
    id: "12345678",
    phase: "SOLVE",
    fullCycle: 1,
    localFixCycle: 0,
    pentestCycle: 0,
    config: cfg,
    history: [],
    results: {},
  } as any;
  const runtime = new ProgressRuntime(() => {}, 2000, Date.now, false);
  runtime.bind(state);
  for (const role of ["solver1", "solver2", "solver3"] as Role[])
    runtime.event({ type: "start", role });
  runtime.event({ type: "complete", role: "solver1" });
  runtime.event({
    type: "networkRetry",
    role: "solver2",
    retry: 3,
    maxRetries: 10,
    delayMs: 3000,
    retryAt: Date.now() + 3000,
    category: "transport",
  });
  runtime.event({
    type: "activity",
    role: "solver3",
    toolName: "context7_query-docs",
  });
  const text = renderProgress(state, runtime).join("\n");
  assert.match(
    text,
    /Solver Pragmatic.*\n.*Reconnecting · network error · 3\/10/,
  );
  assert.match(text, /Solver Alternative.*\n.*Context7/);
  assert.doesNotMatch(text, /retry 1\/1/);
  runtime.event({ type: "networkClear", role: "solver2" });
  assert.doesNotMatch(
    renderProgress(state, runtime).join("\n"),
    /Reconnecting/,
  );
});

test("parallel model requests isolate one solver's reconnect from its siblings", async () => {
  const first = fixtureRuntime([]);
  const second = fixtureRuntime(["ECONNRESET"]);
  const third = fixtureRuntime([]);
  const progress = new ProgressRuntime(() => {}, 2000, Date.now, false);
  const state = {
    id: "12345678",
    phase: "SOLVE",
    fullCycle: 1,
    localFixCycle: 0,
    pentestCycle: 0,
    config: config(),
    history: [],
    results: {},
  } as any;
  progress.bind(state);
  for (const role of ["solver1", "solver2", "solver3"] as Role[])
    progress.event({ type: "start", role });
  let scheduled!: () => void;
  const reconnectScheduled = new Promise<void>((resolve) => {
    scheduled = resolve;
  });
  for (const [role, fixture] of [
    ["solver1", first],
    ["solver2", second],
    ["solver3", third],
  ] as const)
    configureNetworkRetry(
      fixture.runtime,
      { maxRetries: 2, delayMs: 100 },
      () => undefined,
      (event) => {
        if (event.type === "network_retry_scheduled") {
          progress.event({
            type: "networkRetry",
            role,
            retry: event.retry,
            maxRetries: event.maxRetries,
            delayMs: event.delayMs!,
            retryAt: Date.now() + event.delayMs!,
            category: event.category,
          });
          scheduled();
        }
        if (event.type === "network_recovered")
          progress.event({ type: "networkClear", role });
      },
    );
  const requests = [first, second, third].map((fixture, index) =>
    fixture.runtime
      .streamSimple(model, { messages: [index] } as any)
      .result()
      .then((result) => {
        progress.event({
          type: "complete",
          role: `solver${index + 1}` as Role,
        });
        return result;
      }),
  );
  await reconnectScheduled;
  assert.equal(progress.agents.solver2?.networkRetry?.retry, 1);
  assert.equal(progress.agents.solver1?.networkRetry, undefined);
  assert.equal(progress.agents.solver3?.networkRetry, undefined);
  assert.ok(
    (await Promise.all(requests)).every(
      (result) => result.stopReason === "stop",
    ),
  );
  assert.deepEqual(
    [first.requests, second.requests, third.requests],
    [1, 2, 1],
  );
});
