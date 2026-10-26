import test from "node:test";
import assert from "node:assert/strict";
import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type Model,
} from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { configSchema } from "../src/config/schema.ts";
import {
  configureNetworkRetry,
  type ProviderRequestEvent,
  type ProviderWatchdogOptions,
} from "../src/agents/network-retry.ts";
import {
  resolveProviderRequestLimits,
  type ResolvedProviderRequestLimits,
} from "../src/agents/provider-request-limits.ts";
import { config } from "./helpers.ts";
import { output, repository } from "./helpers.ts";
import { baseline } from "../src/workflow/git.ts";
import { newState } from "../src/workflow/state.ts";
import { PiRunner } from "../src/agents/runner.ts";
import {
  ProviderRequestDeadlineError,
  ReasoningStallError,
} from "../src/agents/errors.ts";
import type { Role } from "../src/agents/schemas.ts";

const model = {
  api: "openai-completions",
  provider: "fixture",
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

function clock() {
  let now = 0;
  const timers: Array<{
    at: number;
    active: boolean;
    callback: () => void;
  }> = [];
  const watchdog: ProviderWatchdogOptions = {
    now: () => now,
    setTimer(callback, delayMs) {
      const timer = { at: now + delayMs, active: true, callback };
      timers.push(timer);
      return timer as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer(timer) {
      const found = timers.find((item) => item === (timer as unknown));
      if (found) found.active = false;
    },
  };
  return {
    watchdog,
    advance(ms: number) {
      now += ms;
      for (;;) {
        const due = timers
          .filter((timer) => timer.active && timer.at <= now)
          .sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        due.active = false;
        due.callback();
      }
    },
  };
}

async function eventually(predicate: () => boolean) {
  for (let index = 0; index < 100; index++) {
    if (predicate()) return;
    await Promise.resolve();
  }
  assert.fail("Expected provider state was not observed");
}

function wrapped(
  limits: ResolvedProviderRequestLimits,
  watchdog: ProviderWatchdogOptions,
) {
  const source = createAssistantMessageEventStream();
  const events: ProviderRequestEvent[] = [];
  const networkEvents: string[] = [];
  const states: string[] = [];
  let requests = 0;
  let signal: AbortSignal | undefined;
  let rawEvent:
    ((data: unknown, model: Model<Api>) => void | Promise<void>) | undefined;
  const runtime = {
    streamSimple(_model: unknown, _context: unknown, options: any) {
      requests++;
      signal = options.signal;
      rawEvent = options.onProviderStreamEvent;
      return source;
    },
  } as unknown as ModelRuntime;
  configureNetworkRetry(
    runtime,
    { maxRetries: 3, delayMs: 1 },
    () => undefined,
    (event) => networkEvents.push(event.type),
    (event) => events.push(event),
    () => 1_700_000_000_000,
    (update) => {
      if ("state" in update) states.push(update.state);
    },
    () => () => {},
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    limits,
    undefined,
    watchdog,
  );
  return {
    runtime,
    source,
    events,
    networkEvents,
    states,
    requests: () => requests,
    signal: () => signal,
    raw: () => rawEvent,
  };
}

const duration = (value: number) => ({
  value,
  source: "workflow" as const,
  ...(value === 0 ? { mode: "disabled" as const } : {}),
});

test("provider request limits resolve agent, workflow, defaults, and disabled zero", () => {
  const cfg = config();
  assert.deepEqual(resolveProviderRequestLimits(cfg, "reviewer"), {
    providerRequestDeadlineMs: { value: 1_200_000, source: "default" },
    reasoningStallTimeoutMs: { value: 600_000, source: "default" },
  });
  cfg.workflow.providerRequestDeadlineMs = 30_000;
  cfg.workflow.reasoningStallTimeoutMs = 20_000;
  cfg.agents.reviewer.providerRequestDeadlineMs = 0;
  cfg.agents.reviewer.reasoningStallTimeoutMs = 10_000;
  assert.deepEqual(resolveProviderRequestLimits(cfg, "reviewer"), {
    providerRequestDeadlineMs: {
      value: 0,
      source: "agent",
      mode: "disabled",
    },
    reasoningStallTimeoutMs: { value: 10_000, source: "agent" },
  });
});

test("provider request limit configuration rejects invalid durations", () => {
  const cfg = config();
  for (const value of [-1, 1.5, 86_400_001, "1000", Infinity]) {
    assert.equal(
      configSchema.safeParse({
        ...cfg,
        workflow: { ...cfg.workflow, providerRequestDeadlineMs: value },
      }).success,
      false,
    );
    assert.equal(
      configSchema.safeParse({
        ...cfg,
        agents: {
          ...cfg.agents,
          reviewer: { ...cfg.agents.reviewer, reasoningStallTimeoutMs: value },
        },
      }).success,
      false,
    );
  }
});

test("absolute deadline cancels a hung provider iterator without waiting for another event", async () => {
  const time = clock();
  const fixture = wrapped(
    {
      providerRequestDeadlineMs: duration(20),
      reasoningStallTimeoutMs: duration(0),
    },
    time.watchdog,
  );
  const result = fixture.runtime.streamSimple(model, { messages: [] }).result();
  await eventually(() => fixture.signal() !== undefined);
  time.advance(20);
  const response = await result;
  assert.equal(fixture.signal()?.aborted, true);
  assert.equal(response.stopReason, "aborted");
  assert.equal(
    fixture.events.filter(
      (event) => event.type === "provider_request_deadline_exceeded",
    ).length,
    1,
  );
  assert.equal(fixture.requests(), 1);
  assert.deepEqual(fixture.networkEvents, []);
  const terminalCount = fixture.events.filter(
    (event) => event.type === "provider_request_end",
  ).length;
  fixture.source.push({
    type: "thinking_delta",
    contentIndex: 0,
    delta: "late",
    partial: message(),
  });
  fixture.source.push({ type: "done", reason: "stop", message: message() });
  fixture.source.end();
  await Promise.resolve();
  assert.equal(
    fixture.events.filter((event) => event.type === "provider_request_end")
      .length,
    terminalCount,
  );
});

test("zero disables only the selected provider safeguards", async () => {
  const time = clock();
  const fixture = wrapped(
    {
      providerRequestDeadlineMs: duration(0),
      reasoningStallTimeoutMs: duration(0),
    },
    time.watchdog,
  );
  const result = fixture.runtime.streamSimple(model, { messages: [] }).result();
  fixture.source.push({ type: "start", partial: message() });
  fixture.source.push({
    type: "thinking_delta",
    contentIndex: 0,
    delta: "private",
    partial: message(),
  });
  await eventually(() => fixture.states.includes("reasoning"));
  time.advance(1_000_000);
  assert.equal(fixture.signal()?.aborted, false);
  fixture.source.push({ type: "done", reason: "stop", message: message() });
  fixture.source.end();
  assert.equal((await result).stopReason, "stop");
});

test("the earliest hard or reasoning deadline wins with its exact reason", async () => {
  for (const expected of [
    "provider_request_deadline_exceeded",
    "reasoning_stall_detected",
  ] as const) {
    const time = clock();
    const fixture = wrapped(
      {
        providerRequestDeadlineMs: duration(
          expected === "provider_request_deadline_exceeded" ? 5 : 10,
        ),
        reasoningStallTimeoutMs: duration(
          expected === "reasoning_stall_detected" ? 5 : 10,
        ),
      },
      time.watchdog,
    );
    const result = fixture.runtime
      .streamSimple(model, { messages: [] })
      .result();
    fixture.source.push({ type: "start", partial: message() });
    fixture.source.push({
      type: "thinking_delta",
      contentIndex: 0,
      delta: "private",
      partial: message(),
    });
    await eventually(() => fixture.states.includes("reasoning"));
    time.advance(5);
    assert.equal((await result).stopReason, "aborted");
    assert.equal(
      fixture.events.filter((event) =>
        [
          "provider_request_deadline_exceeded",
          "reasoning_stall_detected",
        ].includes(event.type),
      )[0]?.type,
      expected,
    );
  }
});

test("continuous reasoning and raw heartbeats do not reset the reasoning stall", async () => {
  const time = clock();
  const fixture = wrapped(
    {
      providerRequestDeadlineMs: duration(100),
      reasoningStallTimeoutMs: duration(10),
    },
    time.watchdog,
  );
  const result = fixture.runtime.streamSimple(model, { messages: [] }).result();
  fixture.source.push({ type: "start", partial: message() });
  fixture.source.push({
    type: "thinking_start",
    contentIndex: 0,
    partial: message(),
  });
  await eventually(() => fixture.states.includes("reasoning"));
  for (let index = 0; index < 5; index++) {
    time.advance(2);
    fixture.source.push({
      type: "thinking_delta",
      contentIndex: 0,
      delta: "private",
      partial: message(),
    });
    await fixture.raw()?.({ heartbeat: true }, model);
  }
  const response = await result;
  assert.equal(response.stopReason, "aborted");
  const detected = fixture.events.find(
    (event) => event.type === "reasoning_stall_detected",
  );
  assert.equal(detected?.reasoningOnlyDurationMs, 10);
  assert.equal(detected?.toolCallStarted, false);
  assert.equal(detected?.finalResponseStarted, false);
  assert.ok((detected?.reasoningStreamEventCount ?? 0) >= 1);
});

test("final-answer and tool-call transitions end reasoning-only monitoring", async () => {
  for (const transition of ["text_start", "toolcall_start"] as const) {
    const time = clock();
    const fixture = wrapped(
      {
        providerRequestDeadlineMs: duration(100),
        reasoningStallTimeoutMs: duration(10),
      },
      time.watchdog,
    );
    const result = fixture.runtime
      .streamSimple(model, { messages: [] })
      .result();
    fixture.source.push({ type: "start", partial: message() });
    fixture.source.push({
      type: "thinking_delta",
      contentIndex: 0,
      delta: "private",
      partial: message(),
    });
    await eventually(() => fixture.states.includes("reasoning"));
    time.advance(9);
    fixture.source.push({
      type: transition,
      contentIndex: 1,
      partial: message(),
    });
    if (transition === "toolcall_start")
      fixture.source.push({
        type: "toolcall_end",
        contentIndex: 1,
        toolCall: {
          type: "toolCall",
          id: "complete",
          name: "read",
          arguments: { path: "src/a.ts" },
        },
        partial: message(),
      });
    await eventually(() =>
      transition === "text_start"
        ? fixture.states.includes("generating")
        : fixture.states.filter((state) => state === "tool_calling").length >=
          2,
    );
    time.advance(50);
    fixture.source.push({ type: "done", reason: "stop", message: message() });
    fixture.source.end();
    assert.equal((await result).stopReason, "stop");
    assert.equal(
      fixture.events.some((event) => event.type === "reasoning_stall_detected"),
      false,
    );
  }
});

test("an incomplete tool call does not count as meaningful reasoning progress", async () => {
  const time = clock();
  const fixture = wrapped(
    {
      providerRequestDeadlineMs: duration(100),
      reasoningStallTimeoutMs: duration(10),
    },
    time.watchdog,
  );
  const result = fixture.runtime.streamSimple(model, { messages: [] }).result();
  fixture.source.push({ type: "start", partial: message() });
  fixture.source.push({
    type: "thinking_delta",
    contentIndex: 0,
    delta: "private",
    partial: message(),
  });
  await eventually(() => fixture.states.includes("reasoning"));
  fixture.source.push({
    type: "toolcall_start",
    contentIndex: 1,
    partial: message(),
  });
  await eventually(() => fixture.states.includes("tool_calling"));
  time.advance(10);
  assert.equal((await result).stopReason, "aborted");
  const detected = fixture.events.find(
    (event) => event.type === "reasoning_stall_detected",
  );
  assert.equal(detected?.toolCallStarted, true);
  assert.equal(detected?.finalResponseStarted, false);
});

test("partial tool-call arguments cannot extend the absolute request deadline", async () => {
  const time = clock();
  const fixture = wrapped(
    {
      providerRequestDeadlineMs: duration(20),
      reasoningStallTimeoutMs: duration(5),
    },
    time.watchdog,
  );
  const result = fixture.runtime.streamSimple(model, { messages: [] }).result();
  fixture.source.push({ type: "start", partial: message() });
  fixture.source.push({
    type: "toolcall_start",
    contentIndex: 0,
    partial: message(),
  });
  await eventually(() => fixture.states.includes("tool_calling"));
  for (let index = 0; index < 4; index++) {
    time.advance(5);
    fixture.source.push({
      type: "toolcall_delta",
      contentIndex: 0,
      delta: "{",
      partial: message(),
    });
  }
  assert.equal((await result).stopReason, "aborted");
  assert.equal(
    fixture.events.some(
      (event) => event.type === "provider_request_deadline_exceeded",
    ),
    true,
  );
  assert.equal(
    fixture.events.some((event) => event.type === "reasoning_stall_detected"),
    false,
  );
});

function cutoff(
  type: "provider_request_deadline_exceeded" | "reasoning_stall_detected",
) {
  return {
    type,
    providerRequest: 1,
    provider: "fixture",
    model: "fixture",
    api: "openai-completions",
    networkRetry: 0,
    requestStartedAt: new Date(0).toISOString(),
    requestDurationMs: type === "reasoning_stall_detected" ? 10 : 20,
    cancellationReason:
      type === "reasoning_stall_detected"
        ? ("reasoning_stall" as const)
        : ("provider_request_deadline" as const),
    ...(type === "reasoning_stall_detected"
      ? { reasoningStallThresholdMs: 10, reasoningOnlyDurationMs: 10 }
      : { deadlineMs: 20 }),
    reasoningStreamEventCount: 5,
    streamEventCount: 6,
    state: "reasoning" as const,
    toolCallStarted: false,
    finalResponseStarted: false,
  };
}

async function recoveryFixture(
  role: Role,
  response: unknown,
  cutoffs: Array<ReturnType<typeof cutoff>>,
) {
  const cwd = await repository();
  const state = newState(cwd, "request limits", config(), await baseline(cwd));
  const runner = new PiRunner();
  let prompts = 0;
  let disabled = 0;
  const instructions: string[] = [];
  runner.createSession = async (...args: any[]) => {
    const reportCutoff = args[17] as
      ((event: ReturnType<typeof cutoff>) => void) | undefined;
    const session = {
      messages: [] as any[],
      async prompt(text: string) {
        instructions.push(text);
        prompts++;
        const requestCutoff = cutoffs.shift();
        if (requestCutoff) {
          reportCutoff?.(requestCutoff);
          session.messages.push({ role: "assistant", stopReason: "aborted" });
        } else session.messages.push({ role: "assistant", stopReason: "stop" });
      },
      getLastAssistantText: () =>
        typeof response === "string" ? response : JSON.stringify(response),
      setActiveToolsByName(tools: string[]) {
        assert.deepEqual(tools, []);
        disabled++;
      },
      clearQueue() {},
      abort: async () => {},
      extensionRunner: { emit: async () => {} },
      dispose() {},
    };
    return session as any;
  };
  const events: ProviderRequestEvent[] = [];
  const run = () =>
    runner.run(
      role,
      state,
      undefined,
      undefined,
      1,
      undefined,
      undefined,
      undefined,
      undefined,
      (event) => {
        if ("providerRequest" in event) events.push(event);
      },
    );
  return {
    run,
    events,
    instructions,
    prompts: () => prompts,
    disabled: () => disabled,
  };
}

test("reasoning stall uses one bounded finalization in the same agent attempt", async () => {
  const fixture = await recoveryFixture("researcher", output("researcher"), [
    cutoff("reasoning_stall_detected"),
  ]);
  assert.deepEqual(await fixture.run(), output("researcher"));
  assert.equal(fixture.prompts(), 2);
  assert.equal(fixture.disabled(), 1);
  assert.match(
    fixture.instructions[1]!,
    /Do not repeat the previous investigation/,
  );
  assert.deepEqual(
    fixture.events
      .filter((event) => event.type.startsWith("reasoning_stall_recovery_"))
      .map((event) => event.type),
    ["reasoning_stall_recovery_started", "reasoning_stall_recovery_succeeded"],
  );
});

test("invalid reasoning-stall finalization fails without recursive schema repair", async () => {
  const fixture = await recoveryFixture("researcher", "{invalid", [
    cutoff("reasoning_stall_detected"),
  ]);
  await assert.rejects(fixture.run(), ReasoningStallError);
  assert.equal(fixture.prompts(), 2);
  assert.equal(
    fixture.events.filter(
      (event) => event.type === "reasoning_stall_recovery_failed",
    ).length,
    1,
  );
});

test("hard provider deadline is a precise failure and does not start stall recovery", async () => {
  const fixture = await recoveryFixture("researcher", output("researcher"), [
    cutoff("provider_request_deadline_exceeded"),
  ]);
  await assert.rejects(fixture.run(), ProviderRequestDeadlineError);
  assert.equal(fixture.prompts(), 1);
  assert.equal(
    fixture.events.some((event) =>
      event.type.startsWith("reasoning_stall_recovery_"),
    ),
    false,
  );
});

test("a recovery request has its own hard deadline and cannot overlap", async () => {
  const fixture = await recoveryFixture("researcher", output("researcher"), [
    cutoff("reasoning_stall_detected"),
    cutoff("provider_request_deadline_exceeded"),
  ]);
  await assert.rejects(fixture.run(), ProviderRequestDeadlineError);
  assert.equal(fixture.prompts(), 2);
  assert.deepEqual(
    fixture.events
      .filter((event) => event.type.startsWith("reasoning_stall_recovery_"))
      .map((event) => event.type),
    ["reasoning_stall_recovery_started", "reasoning_stall_recovery_failed"],
  );
});

test("stalled Pentester finalization cannot turn incomplete evidence into PASS", async () => {
  const fixture = await recoveryFixture("pentester", output("pentester"), [
    cutoff("reasoning_stall_detected"),
  ]);
  const result = (await fixture.run()) as any;
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.blocker.code, "REASONING_STALL_INCOMPLETE");
  assert.match(result.blocker.remediation, /team-retry pentester/);
});

test("stalled Security Reviewer cannot complete a quality gate through recovery", async () => {
  const fixture = await recoveryFixture(
    "securityReviewer",
    output("securityReviewer"),
    [cutoff("reasoning_stall_detected")],
  );
  await assert.rejects(fixture.run(), ReasoningStallError);
  assert.equal(fixture.prompts(), 2);
});
