import test from "node:test";
import assert from "node:assert/strict";
import {
  createAssistantMessageEventStream,
  type Api,
  type Model,
  type AssistantMessage,
} from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  serializeErrorDiagnostics,
  containsTerminated,
  firstErrorCode,
} from "../src/agents/error-diagnostics.ts";
import {
  classifyRequestFailure,
  configureNetworkRetry,
  explainRequestFailure,
  type ProviderRequestEvent,
} from "../src/agents/network-retry.ts";
import { config, repository } from "./helpers.ts";
import { WorkflowEngine } from "../src/workflow/engine.ts";
import { AgentLogStore } from "../src/workflow/agent-logs.ts";
import { renderProgress } from "../src/ui/progress.ts";
import type { AgentRunner } from "../src/agents/runner.ts";

const model = {
  api: "openai-completions",
  provider: "local",
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

test("bounded error diagnostics preserve nested transport causes and filter secrets", () => {
  const cause = Object.assign(new Error("other side closed"), {
    code: "UND_ERR_SOCKET",
  });
  const error = new TypeError("terminated", { cause });
  Object.assign(error, {
    authorization: "Bearer private",
    token: "private",
    password: "private",
    apiKey: "private",
    cookie: "private",
  });
  const diagnostic = serializeErrorDiagnostics(error);
  assert.equal(diagnostic.constructor, "TypeError");
  assert.equal(diagnostic.message, "terminated");
  assert.equal(diagnostic.cause?.code, "UND_ERR_SOCKET");
  assert.equal(diagnostic.cause?.message, "other side closed");
  assert.equal(firstErrorCode(diagnostic), "UND_ERR_SOCKET");
  assert.equal(containsTerminated(diagnostic), true);
  assert.equal(JSON.stringify(diagnostic).includes("private"), false);
  assert.equal(diagnostic.stack?.length! <= 15, true);
  const credentialError = new Error(
    "fetch https://user:pass@example.test/path?api_key=private failed; Authorization: Bearer private",
  );
  assert.equal(
    JSON.stringify(serializeErrorDiagnostics(credentialError)).includes(
      "private",
    ),
    false,
  );
  assert.equal(
    JSON.stringify(serializeErrorDiagnostics(credentialError)).includes(
      "example.test",
    ),
    false,
  );
  assert.equal(classifyRequestFailure(error), "transport");
  assert.equal(
    explainRequestFailure(error).matchedRule,
    "cause.code=UND_ERR_SOCKET",
  );
});

test("unknown terminated stays unclassified; circular and aggregate causes are bounded", () => {
  const plain = new Error("terminated");
  assert.equal(serializeErrorDiagnostics(plain).message, "terminated");
  assert.equal(classifyRequestFailure(plain), undefined);
  assert.deepEqual(explainRequestFailure(plain), {
    classification: "other",
    matchedRule: null,
  });
  const circular = new Error("circle") as Error & { cause?: unknown };
  circular.cause = circular;
  assert.equal(
    serializeErrorDiagnostics(circular).cause?.truncated,
    "circular",
  );
  const aggregate = new AggregateError(
    Array.from({ length: 12 }, (_, index) => new Error(`child ${index}`)),
    "many",
  );
  assert.equal(serializeErrorDiagnostics(aggregate).errors?.length, 10);
  const hostile = new Proxy(
    {},
    {
      get() {
        throw new Error("secret");
      },
    },
  );
  assert.doesNotThrow(() => serializeErrorDiagnostics(hostile));
});

test("provider request numbers and durations identify the third 300-second failure", async () => {
  let clock = 1000;
  let calls = 0;
  const durations = [40000, 20000, 300000];
  const runtime = {
    streamSimple: () => {
      const stream = createAssistantMessageEventStream();
      clock += durations[calls];
      calls++;
      const failed = calls === 3;
      const reply = message(
        failed ? "error" : "stop",
        failed ? "terminated" : undefined,
      );
      stream.push(
        failed
          ? { type: "error", reason: "error", error: reply }
          : { type: "done", reason: "stop", message: reply },
      );
      stream.end();
      return stream;
    },
  } as unknown as ModelRuntime;
  const events: ProviderRequestEvent[] = [];
  configureNetworkRetry(
    runtime,
    { maxRetries: 10, delayMs: 1 },
    () => undefined,
    undefined,
    (event) => events.push(event),
    () => clock,
  );
  for (let index = 0; index < 3; index++)
    await runtime.streamSimple(model, { messages: [] }).result();
  assert.deepEqual(
    events
      .filter((event) => event.type === "provider_request_start")
      .map((event) => event.providerRequest),
    [1, 2, 3],
  );
  assert.deepEqual(
    events
      .filter((event) => event.type === "provider_request_end")
      .map((event) => event.requestDurationMs),
    durations,
  );
  const failure = events.find(
    (event) => event.type === "provider_request_failure",
  );
  assert.equal(failure?.providerRequest, 3);
  assert.equal(failure?.requestDurationMs, 300000);
  assert.equal(failure?.classification, "other");
  assert.equal(failure?.matchedRule, null);
});

test("OpenAI-compatible stream keeps the raw body failure cause without adding a retry", async () => {
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
  const events: ProviderRequestEvent[] = [];
  configureNetworkRetry(
    runtime,
    { maxRetries: 1, delayMs: 1 },
    () => undefined,
    undefined,
    (event) => events.push(event),
  );
  let fetches = 0;
  const cause = Object.assign(new Error("other side closed"), {
    code: "UND_ERR_SOCKET",
  });
  const fetchMock = async () => {
    fetches++;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            'data: {"id":"fixture","object":"chat.completion.chunk","created":0,"model":"fixture","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":null}]}\n\n',
          ),
        );
        queueMicrotask(() =>
          controller.error(new TypeError("terminated", { cause })),
        );
      },
    });
    return new Response(body, {
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
  await runtime
    .streamSimple(localModel, context, { apiKey: "local", fetch: fetchMock })
    .result();
  assert.equal(fetches, 1);
  const failure = events.find(
    (event) => event.type === "provider_request_failure",
  );
  assert.equal(failure?.error?.message, "terminated");
  assert.equal(failure?.error?.cause?.code, "UND_ERR_SOCKET");
  assert.equal(failure?.classification, "other");
});

test("summary attempt log and status retain provider cause, timing and guard context", async () => {
  const cwd = await repository();
  const cfg = config();
  cfg.workflow.agentTimeoutMs = 3600000;
  cfg.agents.researcher.timeoutMs = 3600000;
  const cause = Object.assign(new Error("other side closed"), {
    code: "UND_ERR_SOCKET",
  });
  const diagnostic = serializeErrorDiagnostics(
    new TypeError("terminated", { cause }),
  );
  const runner: AgentRunner = {
    async run(
      _role,
      _state,
      _signal,
      _activity,
      _attempt,
      _output,
      _network,
      _registry,
      _guard,
      providerEvent,
    ) {
      const common = {
        providerRequest: 4,
        provider: "local",
        model: "fixture",
        api: "openai-completions",
        networkRetry: 0,
        requestStartedAt: new Date().toISOString(),
        agentTimeoutMs: 3600000,
        agentTimeoutMode: "limited",
        agentTimeoutRemainingMs: 3299890,
        abortSignalAborted: false,
        doomLoop: { interventions: 0, toolsDisabledForFinalization: false },
        toolCalls: 35,
        maxToolCalls: 80,
        toolBudgetExhausted: false,
        networkRetryState: { currentRetry: 0, maxRetries: 10, waiting: false },
        providerTimeouts: {
          requestTimeoutMs: 300000,
          maxRetries: 0,
          httpIdleTimeoutMs: { value: 300000, source: "pi-default" },
        },
      };
      providerEvent?.({ type: "provider_request_start", ...common });
      providerEvent?.({
        type: "provider_request_failure",
        ...common,
        requestDurationMs: 300000,
        error: diagnostic,
        classification: "other",
        matchedRule: null,
      });
      providerEvent?.({
        type: "provider_request_end",
        ...common,
        requestDurationMs: 300000,
        success: false,
      });
      throw new Error("terminated");
    },
  };
  const engine = new WorkflowEngine(cwd, runner, {
    progress: () => {},
    ask: async () => undefined,
  });
  const state = await engine.start("diagnostic fixture", cfg);
  await assert.rejects(() => engine.invoke("researcher", state), /terminated/);
  const logs = new AgentLogStore(cwd);
  const events = await logs.read(state.id, "researcher", 1);
  const failure = events.find((event) => event.type === "provider_error");
  assert.equal(failure?.category, "other");
  assert.equal(failure?.providerRequest, 4);
  assert.equal(failure?.requestDurationMs, 300000);
  assert.equal(typeof failure?.attemptElapsedMs, "number");
  assert.ok((failure?.attemptElapsedMs as number) < 10000);
  assert.equal(
    (failure?.error as { cause?: { code?: string } })?.cause?.code,
    "UND_ERR_SOCKET",
  );
  assert.equal(
    (failure?.doomLoop as { interventions?: number })?.interventions,
    0,
  );
  assert.equal(failure?.toolCalls, 35);
  assert.equal(failure?.abortSignalAborted, false);
  assert.equal(failure?.agentTimeoutMs, 3600000);
  assert.equal(
    events.find((event) => event.type === "terminated_diagnostic")?.causeCode,
    "UND_ERR_SOCKET",
  );
  const timeline = await logs.timeline(state.id, "researcher", 1);
  assert.match(timeline, /provider request 4 failed after 300.0s/);
  assert.match(timeline, /cause: Error: other side closed/);
  assert.match(timeline, /code: UND_ERR_SOCKET/);
  state.phase = "BLOCKED";
  assert.match(renderProgress(state).join("\n"), /Provider request: 300.0s/);
  assert.equal(
    state.history.findLast((event) => event.event === "agent_attempt_failed")
      ?.meta?.reason,
    "other",
  );
});

test("manual abort is recorded as an explicit abort beside a terminated provider request", async () => {
  const cwd = await repository();
  let started!: () => void;
  const startedPromise = new Promise<void>((resolve) => {
    started = resolve;
  });
  const runner: AgentRunner = {
    async run(
      _role,
      _state,
      signal,
      _activity,
      _attempt,
      _output,
      _network,
      _registry,
      _guard,
      providerEvent,
    ) {
      const common = {
        providerRequest: 1,
        provider: "local",
        model: "fixture",
        api: "openai-completions",
        networkRetry: 0,
        requestStartedAt: new Date().toISOString(),
      };
      providerEvent?.({ type: "provider_request_start", ...common });
      started();
      await new Promise<void>((resolve) => {
        if (signal?.aborted) resolve();
        else signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      providerEvent?.({
        type: "provider_request_failure",
        ...common,
        requestDurationMs: 100,
        abortSignalAborted: true,
        error: serializeErrorDiagnostics(new Error("terminated")),
        classification: "other",
        matchedRule: null,
      });
      providerEvent?.({
        type: "provider_request_end",
        ...common,
        requestDurationMs: 100,
        success: false,
      });
      throw new Error("terminated");
    },
  };
  const engine = new WorkflowEngine(cwd, runner, {
    progress: () => {},
    ask: async () => undefined,
  });
  const state = await engine.start("abort diagnostic fixture", config());
  const pending = engine.invoke("researcher", state);
  await startedPromise;
  await engine.abortAgent(state, "researcher");
  await assert.rejects(pending, /aborted by user/);
  const events = await new AgentLogStore(cwd).read(state.id, "researcher", 1);
  const failure = events.find(
    (event) => event.type === "provider_request_failure",
  );
  assert.equal(failure?.abortSignalAborted, true);
  assert.equal(failure?.abortReason, "team-abort");
  assert.equal(
    events.find((event) => event.type === "terminated_diagnostic")?.abortReason,
    "team-abort",
  );
});

test("provider failure retains Doom-Loop finalization and exhausted tool budget flags", async () => {
  const cwd = await repository();
  const runner: AgentRunner = {
    async run(
      _role,
      _state,
      _signal,
      _activity,
      _attempt,
      _output,
      _network,
      _registry,
      _guard,
      providerEvent,
    ) {
      const common = {
        providerRequest: 2,
        provider: "local",
        model: "fixture",
        api: "openai-completions",
        networkRetry: 0,
        requestStartedAt: new Date().toISOString(),
        doomLoop: { interventions: 2, toolsDisabledForFinalization: true },
        toolCalls: 80,
        maxToolCalls: 80,
        toolBudgetExhausted: true,
      };
      providerEvent?.({ type: "provider_request_start", ...common });
      providerEvent?.({
        type: "provider_request_failure",
        ...common,
        requestDurationMs: 100,
        error: serializeErrorDiagnostics(new Error("terminated")),
        classification: "other",
        matchedRule: null,
      });
      providerEvent?.({
        type: "provider_request_end",
        ...common,
        requestDurationMs: 100,
        success: false,
      });
      throw new Error("terminated");
    },
  };
  const engine = new WorkflowEngine(cwd, runner, {
    progress: () => {},
    ask: async () => undefined,
  });
  const state = await engine.start("doom diagnostic fixture", config());
  await assert.rejects(() => engine.invoke("researcher", state), /terminated/);
  const events = await new AgentLogStore(cwd).read(state.id, "researcher", 1);
  const failure = events.find((event) => event.type === "provider_error");
  assert.equal(
    (failure?.doomLoop as { toolsDisabledForFinalization?: boolean })
      ?.toolsDisabledForFinalization,
    true,
  );
  assert.equal(
    (failure?.doomLoop as { interventions?: number })?.interventions,
    2,
  );
  assert.equal(failure?.toolBudgetExhausted, true);
});
