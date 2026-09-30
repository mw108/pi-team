import assert from "node:assert/strict";
import { test } from "node:test";
import { AgentSession } from "@earendil-works/pi-coding-agent";
import { config } from "./helpers.ts";
import { repository, output } from "./helpers.ts";
import { WorkflowEngine } from "../src/workflow/engine.ts";
import { PiRunner } from "../src/agents/runner.ts";
import { AgentDoomLoopError } from "../src/agents/errors.ts";
import { AgentLogStore } from "../src/workflow/agent-logs.ts";
import { ProgressRuntime } from "../src/ui/runtime.ts";
import { renderProgress } from "../src/ui/progress.ts";
import { configSchema } from "../src/config/schema.ts";
import {
  DoomLoopDetector,
  ToolUseGuard,
  resolveDoomLoop,
  toolBehavior,
  toolInvocation,
  toolSignature,
  type GuardEvent,
} from "../src/agents/doom-loop.ts";

const options = () => resolveDoomLoop(config(), "researcher");
const call = (path: string, offset = 0) => ({ path, offset, limit: 200 });

test("tool signatures order keys, ignore transient metadata, and preserve meaningful ranges", () => {
  assert.equal(
    toolSignature("read", {
      path: "a.ts",
      offset: 0,
      limit: 200,
      requestId: "one",
    }),
    toolSignature("read", {
      limit: 200,
      path: "a.ts",
      offset: 0,
      timestamp: 123,
    }),
  );
  assert.notEqual(
    toolSignature("read", call("a.ts", 0)),
    toolSignature("read", call("a.ts", 200)),
  );
  assert.equal(
    toolSignature("web_search", { query: "  Qwen   model  " }),
    toolSignature("web_search", { query: "Qwen model" }),
  );
  assert.notEqual(
    toolSignature("web_search", { queries: ["A"] }),
    toolSignature("web_search", { queries: ["B"] }),
  );
  const left = toolInvocation("mcp", {
    tool: "context7_query-docs",
    args: '{"libraryId":"/x","query":"A"}',
  });
  const right = toolInvocation("mcp", {
    tool: "context7_query-docs",
    args: { query: "A", libraryId: "/x" },
  });
  assert.equal(
    toolSignature(left.tool, left.input),
    toolSignature(right.tool, right.input),
  );
  assert.notEqual(
    toolSignature("serena_find_symbol", {
      name_path_pattern: "Foo",
      relative_path: "src",
    }),
    toolSignature("serena_find_symbol", {
      name_path_pattern: "Bar",
      relative_path: "src",
    }),
  );
  assert.notEqual(
    toolSignature("team_command", { id: "test" }),
    toolSignature("team_command", { id: "build" }),
  );
  assert.equal(toolBehavior("serena_search_for_pattern"), "observational");
  assert.equal(toolBehavior("serena_replace_content"), "mutating");
  assert.equal(toolBehavior("team_command"), "validation");
  assert.equal(toolBehavior("unlisted_tool"), "unknown");
});

test("identical successful and failed calls trigger independently of result", () => {
  for (const success of [true, false]) {
    const detector = new DoomLoopDetector(options());
    for (let i = 0; i < 3; i++) {
      assert.equal(
        detector.observe("read", { ...call("a.ts"), success }),
        undefined,
      );
    }
    assert.deepEqual(detector.observe("read", { ...call("a.ts"), success }), {
      patternType: "identical",
      tool: "read",
      repeatCount: 4,
      progressEpoch: 0,
    });
  }
  const detector = new DoomLoopDetector(options());
  for (const path of ["A", "B", "A", "C", "A"])
    assert.equal(detector.observe("read", call(path)), undefined);
  assert.equal(detector.observe("read", call("A"))?.patternType, "identical");
});

function guardHarness() {
  const events: GuardEvent[] = [];
  const steers: string[] = [];
  const guard = new ToolUseGuard(
    options(),
    80,
    () => ({
      async steer(message: string) {
        steers.push(message);
      },
      setActiveToolsByName(_names: string[]) {},
    }),
    (event) => events.push(event),
  );
  let nextId = 0;
  async function step(tool: string, input: unknown, success = true) {
    const id = String(++nextId);
    await guard.call(tool, input, false, id);
    guard.complete(id, success);
  }
  const detections = () =>
    events.filter((event) => event.type === "doom_loop_detected");
  return { guard, events, steers, step, detections };
}

test("long read/grep exploration of recurring targets triggers a steer", async () => {
  const fixture = guardHarness();
  for (let i = 0; i < 40 && !fixture.detections().length; i++) {
    const path = `src/file${i % 6}.ts`;
    await fixture.step(i % 7 === 0 ? "read" : "grep", {
      path,
      pattern: `symbol${i}`,
      offset: i,
    });
  }
  assert.equal(fixture.detections()[0]?.patternType, "observational");
  assert.equal(fixture.steers.length, 1);
});

test("forty distinct one-pass reads do not trigger observational detection", () => {
  const detector = new DoomLoopDetector(options());
  for (let i = 0; i < 40; i++)
    assert.equal(
      detector.observe("read", call(`src/unique${i}.ts`)),
      undefined,
    );
});

test("a six-call exact cycle is detected before the observational threshold", () => {
  const detector = new DoomLoopDetector(options());
  let loop;
  for (let i = 0; i < 18; i++)
    loop = detector.observe("read", call(`src/cycle${i % 6}.ts`));
  assert.equal(loop?.patternType, "cycle");
});

test("a distinct successful mutation resets observational no-progress history", () => {
  const detector = new DoomLoopDetector(options());
  for (let i = 0; i < 20; i++)
    assert.equal(
      detector.observe("read", call(`src/file${i % 6}.ts`, i)),
      undefined,
    );
  const input = { path: "src/change.ts", content: "changed" };
  detector.observe("write", input);
  detector.completeMutation("write", toolSignature("write", input), true);
  for (let i = 0; i < 20; i++)
    assert.equal(
      detector.observe("read", call(`src/file${i % 6}.ts`, i + 20)),
      undefined,
    );
});

test("validation calls do not reset observational no-progress history", () => {
  const detector = new DoomLoopDetector(options());
  let loop;
  for (let i = 0; i < 31; i++) {
    if (i === 25)
      assert.equal(detector.observe("team_command", { id: "test" }), undefined);
    else loop = detector.observe("read", call(`src/file${i % 6}.ts`, i));
  }
  assert.equal(loop?.patternType, "observational");
});

test("real Implementor sequence preserves implementation and validation progress", async () => {
  const run = guardHarness();
  await run.step("serena_search_for_pattern", { substring_pattern: "status" });
  await run.step("write", { path: "a.ts", content: "one" });
  await run.step("read", call("a.ts"));
  await run.step("team_command", { id: "test" });
  await run.step("write", { path: "b.ts", content: "two" });
  await run.step("team_command", { id: "test" });
  await run.step("write", { path: "c.ts", content: "three" });
  await run.step("team_command", { id: "test" });
  await run.step("edit", { path: "a.ts", oldText: "one", newText: "four" });
  await run.step("team_command", { id: "test" });
  assert.deepEqual(run.detections(), []);
  assert.deepEqual(run.steers, []);
});

test("validation calls are segmented by distinct successful mutations", async () => {
  const run = guardHarness();
  for (const [tool, input] of [
    ["team_command", { id: "test" }],
    ["write", { path: "x.ts", content: "X" }],
    ["team_command", { id: "test" }],
    ["write", { path: "y.ts", content: "Y" }],
    ["team_command", { id: "test" }],
    ["edit", { path: "z.ts", oldText: "old", newText: "new" }],
    ["team_command", { id: "test" }],
  ] as const)
    await run.step(tool, input);
  assert.deepEqual(run.detections(), []);
});

test("identical validation calls without repository progress still trigger", async () => {
  for (const withReads of [false, true]) {
    const run = guardHarness();
    for (let i = 0; i < 4; i++) {
      await run.step("team_command", { id: "test" });
      if (withReads && i < 3) await run.step("read", call(`file-${i}.ts`));
    }
    assert.deepEqual(run.detections(), [
      {
        type: "doom_loop_detected",
        patternType: "identical",
        tool: "team_command",
        repeatCount: 4,
        progressEpoch: 0,
      },
    ]);
  }
});

test("failed writes do not break repeated validation calls", async () => {
  const run = guardHarness();
  for (let i = 0; i < 4; i++) {
    await run.step("team_command", { id: "test" });
    if (i < 3) await run.step("write", { path: "x.ts", content: "X" }, false);
  }
  assert.equal(run.detections().length > 0, true);
  assert.equal(run.detections().at(-1)?.progressEpoch, 0);
});

test("identical successful writes remain loop-detectable", async () => {
  const run = guardHarness();
  for (let i = 0; i < 4; i++)
    await run.step("write", { path: "x.ts", content: "same" });
  assert.equal(run.detections().at(-1)?.patternType, "identical");
  assert.equal(run.detections().at(-1)?.tool, "write");
  assert.equal(run.detections().at(-1)?.repeatCount, 4);
  assert.equal(run.detections().at(-1)?.progressEpoch, 1);
});

test("identical failed writes remain loop-detectable", async () => {
  const run = guardHarness();
  for (let i = 0; i < 4; i++)
    await run.step("write", { path: "x.ts", content: "same" }, false);
  assert.equal(run.detections().at(-1)?.patternType, "identical");
  assert.equal(run.detections().at(-1)?.tool, "write");
  assert.equal(run.detections().at(-1)?.progressEpoch, 0);
});

test("distinct writes and distinct edit/test cycles count as progress", async () => {
  const writes = guardHarness();
  for (const name of ["A", "B", "C", "D"])
    await writes.step("write", { path: `${name}.ts`, content: name });
  assert.deepEqual(writes.detections(), []);
  const edits = guardHarness();
  for (const patch of ["one", "two", "three"]) {
    await edits.step("edit", {
      path: "a.ts",
      oldText: "old",
      newText: patch,
    });
    await edits.step("team_command", { id: "test" });
  }
  assert.deepEqual(edits.detections(), []);
});

test("repeated cycles are segmented after a successful edit", async () => {
  const run = guardHarness();
  for (let i = 0; i < 2; i++) {
    await run.step("read", call("a.ts"));
    await run.step("find", { pattern: "B" });
  }
  await run.step("edit", {
    path: "c.ts",
    oldText: "before",
    newText: "after",
  });
  for (let i = 0; i < 2; i++) {
    await run.step("read", call("a.ts"));
    await run.step("find", { pattern: "B" });
  }
  assert.deepEqual(run.detections(), []);
  await run.step("read", call("a.ts"));
  await run.step("find", { pattern: "B" });
  assert.equal(run.detections().at(-1)?.patternType, "cycle");
});

test("alternating and three-step cycles trigger, distinct work does not", () => {
  for (const sequence of [
    ["A", "B", "A", "B", "A", "B"],
    ["A", "B", "C", "A", "B", "C", "A", "B", "C"],
  ]) {
    const detector = new DoomLoopDetector(options());
    const events = sequence
      .map((path) => detector.observe("read", call(path)))
      .filter(Boolean);
    assert.equal(events.at(-1)?.patternType, "cycle");
  }
  const detector = new DoomLoopDetector(options());
  for (const path of ["A", "B", "C", "D", "E", "F"])
    assert.equal(detector.observe("read", call(path)), undefined);
  const ranges = new DoomLoopDetector(options());
  for (const offset of [0, 200, 400])
    assert.equal(ranges.observe("read", call("A", offset)), undefined);
});

test("interventions reset history, recur in one attempt, then disable tools", async () => {
  const messages: string[] = [];
  const events: GuardEvent[] = [];
  const disabled: string[][] = [];
  const session = {
    async steer(message: string) {
      messages.push(message);
    },
    setActiveToolsByName(names: string[]) {
      disabled.push(names);
    },
  };
  const guard = new ToolUseGuard(
    options(),
    80,
    () => session,
    (event) => events.push(event),
  );
  for (let i = 0; i < 4; i++) await guard.call("read", call("A"));
  assert.equal(guard.interventions, 1);
  assert.equal(messages.length, 1);
  for (const path of ["B", "C", "D", "E"])
    assert.equal(await guard.call("read", call(path)), undefined);
  assert.equal(guard.interventions, 1);
  for (let i = 0; i < 4; i++) await guard.call("read", call("B"));
  assert.equal(guard.interventions, 2);
  for (let i = 0; i < 4; i++) await guard.call("read", call("C"));
  assert.equal(guard.finalizationReason, "doom_loop");
  assert.equal(messages.length, 3);
  assert.deepEqual(disabled, [[]]);
  assert.equal((await guard.call("read", call("D")))?.block, true);
  assert.equal(messages.length, 3);
  assert.deepEqual(
    events
      .map((event) => event.type)
      .filter((type) => type !== "doom_loop_detected"),
    ["doom_loop_steer", "doom_loop_steer", "doom_loop_finalization"],
  );
});

test("manual steer clears pattern without consuming intervention budget; a new attempt starts empty", async () => {
  const session = {
    steer: async (_: string) => {},
    setActiveToolsByName: (_: string[]) => {},
  };
  const guard = new ToolUseGuard(options(), 80, () => session);
  for (let i = 0; i < 3; i++) await guard.call("read", call("A"));
  guard.resetHistory();
  assert.equal(await guard.call("read", call("A")), undefined);
  assert.equal(guard.interventions, 0);
  const nextAttempt = new ToolUseGuard(options(), 80, () => session);
  assert.equal(nextAttempt.toolCalls, 0);
  assert.equal(nextAttempt.interventions, 0);
});

test("tool budget queues one finalization steer and blocks further tools", async () => {
  const messages: string[] = [];
  const disabled: string[][] = [];
  const guard = new ToolUseGuard(options(), 2, () => ({
    async steer(message: string) {
      messages.push(message);
    },
    setActiveToolsByName(names: string[]) {
      disabled.push(names);
    },
  }));
  await guard.call("read", call("A"));
  await guard.call("read", call("B"));
  assert.equal((await guard.call("read", call("C")))?.block, true);
  assert.equal(guard.finalizationReason, "tool_budget");
  assert.equal((await guard.call("read", call("D")))?.block, true);
  assert.equal(messages.length, 1);
  assert.deepEqual(disabled, [[]]);
});

test("zero tool budget permits over 1000 distinct calls while Doom-Loop remains active", async () => {
  const messages: string[] = [];
  const events: GuardEvent[] = [];
  const guard = new ToolUseGuard(
    options(),
    0,
    () => ({
      async steer(message: string) {
        messages.push(message);
      },
      setActiveToolsByName(_names: string[]) {},
    }),
    (event) => events.push(event),
  );
  for (let i = 0; i < 1001; i++)
    assert.equal(await guard.call("read", { path: `${i}.ts` }), undefined);
  assert.equal(guard.toolCalls, 1001);
  assert.equal(guard.finalizationReason, undefined);
  assert.equal(
    events.some((event) => event.type === "tool_budget_finalization"),
    false,
  );
  for (let i = 0; i < 4; i++) await guard.call("read", { path: "same.ts" });
  assert.ok(events.some((event) => event.type === "doom_loop_detected"));
  assert.equal(messages.length, 1);
});

test("tool budget schema accepts zero and positive integers only", () => {
  const cfg = config();
  for (const value of [0, 3]) {
    cfg.workflow.maxToolCalls = value;
    assert.equal(configSchema.parse(cfg).workflow.maxToolCalls, value);
  }
  for (const value of [-1, 1.5, Number.NaN, "0"]) {
    cfg.workflow.maxToolCalls = value as number;
    assert.equal(configSchema.safeParse(cfg).success, false);
  }
});

test("aborted attempts cannot queue automatic steering", async () => {
  const messages: string[] = [];
  const guard = new ToolUseGuard(options(), 80, () => ({
    async steer(message: string) {
      messages.push(message);
    },
    setActiveToolsByName(_names: string[]) {},
  }));
  for (let i = 0; i < 4; i++)
    assert.equal((await guard.call("read", call("A"), true))?.block, true);
  assert.deepEqual(messages, []);
  assert.equal(guard.interventions, 0);
});

test("invalid no-tools final result becomes a typed doom-loop failure", async () => {
  const cwd = await repository();
  const engine = new WorkflowEngine(
    cwd,
    { run: async () => output("researcher") },
    {
      progress() {},
      async ask() {
        return undefined;
      },
    },
  );
  const state = await engine.start("Fix", config());
  const runner = new PiRunner();
  let promptCount = 0;
  const messages: string[] = [];
  let disabled = 0;
  runner.createSession = async (
    _role: any,
    _state: any,
    _evidence: any,
    _activity: any,
    _network: any,
    _getSignal: any,
    guardState: any,
  ) =>
    ({
      messages: [{ role: "assistant", stopReason: "stop" }],
      async prompt() {
        promptCount++;
        if (promptCount === 1)
          for (const path of ["A", "B", "C"])
            for (let i = 0; i < 4; i++)
              await guardState.guard.call("read", call(path));
      },
      async steer(message: string) {
        messages.push(message);
      },
      setActiveToolsByName(_names: string[]) {
        disabled++;
      },
      getLastAssistantText() {
        return "invalid";
      },
      extensionRunner: { async emit() {} },
      dispose() {},
      async abort() {},
    }) as any;
  await assert.rejects(
    runner.run("researcher", state),
    (error: unknown) =>
      error instanceof AgentDoomLoopError && error.interventions === 2,
  );
  assert.equal(promptCount, 2);
  assert.equal(messages.length, 3);
  assert.ok(disabled >= 1);
});

test("runner cancellation clears queued steering before aborting the session", async () => {
  const cwd = await repository();
  const engine = new WorkflowEngine(
    cwd,
    { run: async () => output("researcher") },
    {
      progress() {},
      async ask() {
        return undefined;
      },
    },
  );
  const state = await engine.start("Fix", config());
  const runner = new PiRunner();
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let rejectPrompt!: (error: Error) => void;
  let queueCleared = 0;
  let aborted = 0;
  runner.createSession = async () =>
    ({
      messages: [],
      prompt: () =>
        new Promise<void>((_resolve, reject) => {
          rejectPrompt = reject;
          entered();
        }),
      clearQueue() {
        queueCleared++;
      },
      async abort() {
        aborted++;
        rejectPrompt(new Error("aborted"));
      },
      getLastAssistantText() {
        return "";
      },
      extensionRunner: { async emit() {} },
      dispose() {},
    }) as any;
  const controller = new AbortController();
  const pending = runner.run("researcher", state, controller.signal);
  await started;
  controller.abort();
  await assert.rejects(pending, /aborted|Workflow interrupted/);
  assert.equal(queueCleared, 1);
  assert.equal(aborted, 1);
});

test("engine persists safe detector events and exposes live finalization status", async () => {
  const cwd = await repository();
  const runtime = new ProgressRuntime(() => {}, 2000, Date.now, false);
  let liveStatus = "";
  const runner: any = {
    async run(
      role: string,
      _state: unknown,
      _signal: unknown,
      _activity: unknown,
      _attempt: unknown,
      _output: unknown,
      _network: unknown,
      _registry: unknown,
      guardEvent: (event: GuardEvent) => void,
    ) {
      guardEvent({
        type: "doom_loop_detected",
        patternType: "identical",
        tool: "read",
        repeatCount: 4,
        progressEpoch: 0,
      });
      guardEvent({
        type: "doom_loop_steer",
        intervention: 1,
        maxInterventions: 2,
      });
      guardEvent({ type: "doom_loop_finalization" });
      return output(role as any);
    },
  };
  const engine = new WorkflowEngine(cwd, runner, {
    progress() {},
    agentEvent: (event) => {
      runtime.event(event);
      if (
        event.type === "guard" &&
        event.event.type === "doom_loop_finalization"
      )
        liveStatus = renderProgress(runtime.state!, runtime).join("\n");
    },
    async ask() {
      return undefined;
    },
  });
  const state = await engine.start("Fix", config());
  state.phase = "SOLVE";
  runtime.bind(state);
  await engine.invoke("solver1", state);
  const events = await new AgentLogStore(cwd).read(state.id, "solver1", 1);
  assert.deepEqual(
    events
      .filter((event) => event.type.startsWith("doom_loop"))
      .map((event) => event.type),
    ["doom_loop_detected", "doom_loop_steer", "doom_loop_finalization"],
  );
  assert.equal(
    events.some((event) => "signature" in event || "input" in event),
    false,
  );
  assert.equal(
    state.history.some((entry) => entry.event === "doom_loop_finalization"),
    true,
  );
  assert.equal(runtime.agents.solver1?.toolsDisabledForFinalization, true);
  assert.match(liveStatus, /doom-loop interventions: 1\/2/);
  assert.match(liveStatus, /tools: disabled for finalization/);
  runtime.dispose();
});

test("engine preserves typed doom-loop failure and counts only the failed attempt", async () => {
  const cwd = await repository();
  const engine = new WorkflowEngine(
    cwd,
    {
      async run() {
        throw new AgentDoomLoopError("researcher", 1, 2);
      },
    },
    {
      progress() {},
      async ask() {
        return undefined;
      },
    },
  );
  const state = await engine.start("Fix", config());
  await assert.rejects(
    engine.invoke("researcher", state),
    (error: unknown) =>
      error instanceof AgentDoomLoopError && (error as any).failures === 1,
  );
  assert.equal(
    state.history.some((entry) => entry.event === "doom_loop_failed"),
    true,
  );
});

test("Pi 0.87.1 AgentSession.steer queues a user-role message", async () => {
  const received: unknown[] = [];
  const fake: any = {
    _steeringMessages: [],
    _emitQueueUpdate() {},
    agent: {
      steer(message: unknown) {
        received.push(message);
      },
    },
    async _queueUserInput(text: string, _images: unknown, kind: string) {
      assert.equal(kind, "steer");
      await (AgentSession.prototype as any)._queueSteer.call(this, text);
    },
  };
  await AgentSession.prototype.steer.call(fake, "Change approach");
  assert.equal((received[0] as any).role, "user");
  assert.equal((received[0] as any).content[0].text, "Change approach");
});

test("doom-loop config validates bounds and inherits per-agent fields", () => {
  const cfg = config();
  cfg.agents.researcher.doomLoop = { maxIdenticalCalls: 6 };
  assert.equal(resolveDoomLoop(cfg, "researcher").maxIdenticalCalls, 6);
  assert.equal(resolveDoomLoop(cfg, "researcher").maxRepeatedPattern, 3);
  for (const invalid of [0, -1, 101, 1.5]) {
    assert.equal(
      configSchema.safeParse({
        ...cfg,
        workflow: {
          ...cfg.workflow,
          doomLoop: { ...cfg.workflow.doomLoop, windowSize: invalid },
        },
      }).success,
      false,
    );
  }
  assert.equal(
    configSchema.safeParse({
      ...cfg,
      workflow: {
        ...cfg.workflow,
        doomLoop: { ...cfg.workflow.doomLoop, maxInterventions: 0 },
      },
    }).success,
    false,
  );
});
