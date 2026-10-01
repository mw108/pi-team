import test from "node:test";
import assert from "node:assert/strict";
import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type Model,
} from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  configureNetworkRetry,
  type ProviderProgressUpdate,
  type ProviderRequestEvent,
} from "../src/agents/network-retry.ts";
import { ProgressRuntime } from "../src/ui/runtime.ts";
import { renderProgress } from "../src/ui/progress.ts";
import { newState } from "../src/workflow/state.ts";
import { config, repository, research } from "./helpers.ts";
import { WorkflowEngine } from "../src/workflow/engine.ts";
import { AgentLogStore } from "../src/workflow/agent-logs.ts";
import type { AgentRunner } from "../src/agents/runner.ts";

const model = {
  api: "openai-completions",
  provider: "local",
  id: "fixture",
} as Model<Api>;
function message(): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    stopReason: "stop",
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
async function eventually(predicate: () => boolean) {
  for (let index = 0; index < 100; index++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.fail("Provider event was not observed");
}

test("live stream activity updates state, reasoning, timestamps and bounded progress logs", async () => {
  let clock = 1000;
  let tick = () => {};
  const source = createAssistantMessageEventStream();
  const runtime = { streamSimple: () => source } as unknown as ModelRuntime;
  const events: ProviderRequestEvent[] = [];
  const updates: ProviderProgressUpdate[] = [];
  configureNetworkRetry(
    runtime,
    { maxRetries: 0, delayMs: 1 },
    () => undefined,
    undefined,
    (event) => events.push(event),
    () => clock,
    (update) => updates.push(update),
    (callback) => {
      tick = callback;
      return () => {
        tick = () => {};
      };
    },
  );
  const result = runtime.streamSimple(model, { messages: [] }).result();
  assert.equal(events[0]?.type, "provider_request_start");
  assert.deepEqual(updates[0], {
    providerRequest: 1,
    startedAt: 1000,
    state: "waiting",
    streamEventCount: 0,
  });
  source.push({ type: "start", partial: message() });
  clock = 2000;
  source.push({
    type: "thinking_delta",
    contentIndex: 0,
    delta: "secret",
    partial: message(),
  });
  await eventually(() =>
    updates.some((update) => "state" in update && update.state === "reasoning"),
  );
  clock = 3000;
  source.push({
    type: "text_delta",
    contentIndex: 1,
    delta: "answer",
    partial: message(),
  });
  await eventually(() =>
    updates.some(
      (update) => "state" in update && update.state === "generating",
    ),
  );
  const live = updates.findLast((update) => "state" in update);
  assert.equal("state" in live!, true);
  if ("state" in live!) {
    assert.equal(live!.lastActivityAt, 3000);
    assert.equal(live!.firstActivityAt, 2000);
    assert.equal(live!.streamEventCount, 2);
  }
  clock = 6000;
  tick();
  clock = 11000;
  tick();
  assert.deepEqual(
    events
      .filter((event) => event.type === "provider_progress")
      .map((event) => ({
        elapsedMs: event.elapsedMs,
        lastActivityMs: event.lastActivityMs,
        state: event.state,
      })),
    [
      { elapsedMs: 5000, lastActivityMs: 3000, state: "generating" },
      { elapsedMs: 10000, lastActivityMs: 8000, state: "generating" },
    ],
  );
  assert.equal(JSON.stringify(events).includes("secret"), false);
  assert.equal(JSON.stringify(events).includes("answer"), false);
  source.push({ type: "done", reason: "stop", message: message() });
  source.end();
  await result;
  assert.equal(updates.at(-1)?.providerRequest, 1);
  assert.equal("ended" in updates.at(-1)!, true);
  tick();
  assert.equal(
    events.filter((event) => event.type === "provider_progress").length,
    2,
  );
  assert.equal(
    events.find((event) => event.type === "provider_request_end")
      ?.timeToFirstEventMs,
    1000,
  );
});

test("short requests emit no progress log and telemetry observer errors fail open", async () => {
  const source = createAssistantMessageEventStream();
  const runtime = { streamSimple: () => source } as unknown as ModelRuntime;
  const events: ProviderRequestEvent[] = [];
  configureNetworkRetry(
    runtime,
    { maxRetries: 0, delayMs: 1 },
    () => undefined,
    undefined,
    (event) => events.push(event),
    Date.now,
    () => {
      throw new Error("UI unavailable");
    },
  );
  const result = runtime.streamSimple(model, { messages: [] }).result();
  source.push({ type: "start", partial: message() });
  source.push({
    type: "text_delta",
    contentIndex: 0,
    delta: "x",
    partial: message(),
  });
  source.push({ type: "done", reason: "stop", message: message() });
  source.end();
  await result;
  assert.equal(
    events.filter((event) => event.type === "provider_progress").length,
    0,
  );
  assert.equal(events.at(-1)?.type, "provider_request_end");
});

test("raw usage-only provider chunks refresh liveness without inventing token metrics", async () => {
  let clock = 1000;
  let rawEvent:
    ((data: unknown, model: Model<Api>) => Promise<void>) | undefined;
  let tick = () => {};
  const source = createAssistantMessageEventStream();
  const runtime = {
    streamSimple: (_model: Model<Api>, _context: unknown, options: any) => {
      rawEvent = options.onProviderStreamEvent;
      return source;
    },
  } as unknown as ModelRuntime;
  const events: ProviderRequestEvent[] = [];
  const updates: ProviderProgressUpdate[] = [];
  configureNetworkRetry(
    runtime,
    { maxRetries: 0, delayMs: 1 },
    () => undefined,
    undefined,
    (event) => events.push(event),
    () => clock,
    (update) => updates.push(update),
    (callback) => {
      tick = callback;
      return () => {
        tick = () => {};
      };
    },
  );
  const result = runtime.streamSimple(model, { messages: [] }).result();
  source.push({ type: "start", partial: message() });
  assert.ok(rawEvent);
  clock = 7000;
  await rawEvent({ usage: { completion_tokens: 24 } }, model);
  tick();
  const progress = events.find((event) => event.type === "provider_progress");
  assert.ok(progress);
  assert.equal(progress?.lastActivityMs, 0);
  assert.equal(progress?.state, "waiting");
  assert.equal(Object.hasOwn(progress, "outputTokens"), false);
  assert.equal(progress?.timeToFirstEventMs, undefined);
  assert.equal("lastActivityAt" in updates.at(-1)!, true);
  source.push({ type: "done", reason: "stop", message: message() });
  source.end();
  await result;
  const end = events.find((event) => event.type === "provider_request_end");
  assert.equal(end?.timeToFirstEventMs, undefined);
  assert.equal(end?.timeSinceLastActivityMs, 0);
});

test("TUI distinguishes waiting, generating, reasoning and idle while tools take priority", () => {
  let clock = 1000;
  const state = newState("/tmp/fixture", "task", config(), {
    head: null,
    dirtyPaths: [],
    status: "",
    diff: "",
    cachedDiff: "",
  });
  const runtime = new ProgressRuntime(
    () => {},
    2000,
    () => clock,
    false,
  );
  runtime.bind(state);
  runtime.event({ type: "start", role: "solver1", attempt: 1 });
  const update = (
    role: "solver1" | "solver2",
    providerRequest: number,
    stateName: "waiting" | "generating" | "reasoning",
    lastActivityAt?: number,
  ) =>
    runtime.event({
      type: "providerProgress",
      workflowId: state.id,
      role,
      attempt: 1,
      update: {
        providerRequest,
        startedAt: 1000,
        state: stateName,
        streamEventCount: lastActivityAt ? 1 : 0,
        ...(lastActivityAt === undefined
          ? {}
          : { firstActivityAt: lastActivityAt, lastActivityAt }),
      },
    });
  update("solver1", 1, "waiting");
  assert.match(
    renderProgress(state, runtime).join("\n"),
    /↳ waiting for model response/,
  );
  clock = 2000;
  update("solver1", 1, "reasoning", 2000);
  assert.match(
    renderProgress(state, runtime).join("\n"),
    /↳ reasoning · active 0\.0s ago/,
  );
  update("solver1", 1, "generating", 2000);
  assert.match(
    renderProgress(state, runtime).join("\n"),
    /↳ generating · active 0\.0s ago/,
  );
  runtime.event({
    type: "activity",
    role: "solver1",
    toolName: "bash",
    toolCallId: "tool-1",
  });
  assert.doesNotMatch(
    renderProgress(state, runtime).join("\n"),
    /↳ generating/,
  );
  runtime.event({ type: "activityEnd", role: "solver1", toolCallId: "tool-1" });
  clock = 92000;
  assert.match(
    renderProgress(state, runtime).join("\n"),
    /↳ provider idle · 1m 30s since last event/,
  );
  runtime.event({ type: "start", role: "solver2", attempt: 1 });
  update("solver2", 1, "generating", 92000);
  const lines = renderProgress(state, runtime).join("\n");
  assert.match(lines, /Solver Architecture[\s\S]*provider idle/);
  assert.match(lines, /Solver Pragmatic[\s\S]*generating/);
  runtime.dispose();
});

test("provider replacement and agent retry discard prior live progress", () => {
  const state = newState("/tmp/fixture", "task", config(), {
    head: null,
    dirtyPaths: [],
    status: "",
    diff: "",
    cachedDiff: "",
  });
  const runtime = new ProgressRuntime(() => {}, 2000, Date.now, false);
  runtime.bind(state);
  runtime.event({ type: "start", role: "solver1", attempt: 1 });
  runtime.event({
    type: "providerProgress",
    workflowId: state.id,
    role: "solver1",
    attempt: 1,
    update: {
      providerRequest: 1,
      startedAt: 1,
      lastActivityAt: 2,
      state: "generating",
      streamEventCount: 1,
    },
  });
  runtime.event({
    type: "providerProgress",
    workflowId: state.id,
    role: "solver1",
    attempt: 1,
    update: {
      providerRequest: 2,
      startedAt: 3,
      state: "waiting",
      streamEventCount: 0,
    },
  });
  assert.equal(
    runtime.agents.solver1?.providerProgress?.lastActivityAt,
    undefined,
  );
  runtime.event({
    type: "providerProgress",
    workflowId: state.id,
    role: "solver1",
    attempt: 1,
    update: { providerRequest: 1, ended: true },
  });
  assert.equal(runtime.agents.solver1?.providerProgress?.providerRequest, 2);
  runtime.event({ type: "start", role: "solver1", attempt: 2 });
  assert.equal(runtime.agents.solver1?.providerProgress, undefined);
  runtime.event({
    type: "providerProgress",
    workflowId: "different-workflow",
    role: "solver1",
    attempt: 2,
    update: {
      providerRequest: 1,
      startedAt: 4,
      state: "generating",
      streamEventCount: 1,
    },
  });
  assert.equal(runtime.agents.solver1?.providerProgress, undefined);
  runtime.event({
    type: "providerProgress",
    workflowId: state.id,
    role: "solver1",
    attempt: 1,
    update: {
      providerRequest: 3,
      startedAt: 4,
      state: "generating",
      streamEventCount: 1,
    },
  });
  assert.equal(runtime.agents.solver1?.providerProgress, undefined);
  runtime.dispose();
});

test("network retry starts a fresh provider progress snapshot", async () => {
  let calls = 0;
  const runtime = {
    streamSimple: () => {
      const source = createAssistantMessageEventStream();
      calls++;
      if (calls === 1) {
        const failed = {
          ...message(),
          stopReason: "error" as const,
          errorMessage: "Connection error.",
        };
        source.push({ type: "error", reason: "error", error: failed });
      } else {
        source.push({ type: "start", partial: message() });
        source.push({
          type: "text_delta",
          contentIndex: 0,
          delta: "ok",
          partial: message(),
        });
        source.push({ type: "done", reason: "stop", message: message() });
      }
      source.end();
      return source;
    },
  } as unknown as ModelRuntime;
  const updates: ProviderProgressUpdate[] = [];
  configureNetworkRetry(
    runtime,
    { maxRetries: 1, delayMs: 1 },
    () => undefined,
    undefined,
    undefined,
    Date.now,
    (update) => updates.push(update),
  );
  await runtime.streamSimple(model, { messages: [] }).result();
  assert.equal(calls, 2);
  const starts = updates.filter(
    (update) => "state" in update && update.state === "waiting",
  );
  assert.deepEqual(
    starts.map((update) => update.providerRequest),
    [1, 2],
  );
  assert.equal("lastActivityAt" in starts[1], false);
  assert.deepEqual(
    updates
      .filter((update) => "ended" in update)
      .map((update) => update.providerRequest),
    [1, 2],
  );
});

test("workflow JSONL records compact provider_progress without streamed content", async () => {
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
      _guardEvent,
      providerEvent,
    ) {
      const identity = {
        providerRequest: 1,
        provider: "local",
        model: "fixture",
        api: "openai-completions",
        networkRetry: 0,
        requestStartedAt: new Date().toISOString(),
      };
      providerEvent?.({ type: "provider_request_start", ...identity });
      providerEvent?.({
        type: "provider_progress",
        ...identity,
        elapsedMs: 5000,
        lastActivityMs: 100,
        state: "generating",
        streamEventCount: 20,
      });
      providerEvent?.({
        type: "provider_request_end",
        ...identity,
        requestDurationMs: 6000,
        success: true,
      });
      return research;
    },
  };
  const engine = new WorkflowEngine(cwd, runner, {
    progress: () => {},
    ask: async () => undefined,
  });
  const state = await engine.start("progress fixture", config());
  await engine.invoke("researcher", state);
  const events = await new AgentLogStore(cwd).read(state.id, "researcher", 1);
  const progress = events.find((event) => event.type === "provider_progress");
  assert.equal(progress?.state, "generating");
  assert.equal(progress?.elapsedMs, 5000);
  assert.equal(progress?.lastActivityMs, 100);
  assert.equal(progress?.attempt, 1);
  assert.equal(progress?.outputTokens, undefined);
  assert.equal(progress?.tokensPerSecond, undefined);
  assert.equal(progress?.abortReason, undefined);
});
