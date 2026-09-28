import test from "node:test";
import assert from "node:assert/strict";
import { config, repository, FixtureRunner, output } from "./helpers.ts";
import { configSchema } from "../src/config/schema.ts";
import { newState, type WorkflowState } from "../src/workflow/state.ts";
import { ProgressRuntime } from "../src/ui/runtime.ts";
import { elapsed, renderProgress } from "../src/ui/progress.ts";
import { formatToolActivity } from "../src/ui/activity.ts";
import { WorkflowEngine } from "../src/workflow/engine.ts";
import type { Role } from "../src/agents/schemas.ts";
import teamExtension from "../src/index.ts";
import { PiRunner } from "../src/agents/runner.ts";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import YAML from "yaml";

function state() {
  return newState("/tmp/fixture", "task", config(), {
    head: null,
    dirtyPaths: [],
    status: "",
    diff: "",
    cachedDiff: "",
  });
}
function lines(s: WorkflowState, runtime?: ProgressRuntime) {
  return renderProgress(s, runtime).join("\n");
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function eventually(predicate: () => boolean) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("Expected progress event did not arrive");
}

test("disabled gates are explicit; only enabled gates show counters and agents", () => {
  const s = state();
  let text = lines(s);
  assert.match(text, /Design cycle 1\/3/);
  assert.match(text, /Local fixes 0\/5/);
  assert.match(text, /Pentest disabled/);
  assert.doesNotMatch(text, /Pentest cycle|Pen Tester|Security Reviewer/);
  s.config.qualityGates.pentest.enabled = true;
  s.pentestCycle = 1;
  text = lines(s);
  assert.match(text, /Pentest cycle 1\/2/);
  assert.match(text, /Pen Tester/);
  assert.match(text, /Security Reviewer/);
  s.config.agents.solver2.prompt = "agents/solver-security-heavy.md";
  assert.match(lines(s), /Solver Security Heavy/);
  for (const gate of ["codeReview", "testing", "commit"] as const)
    s.config.qualityGates[gate].enabled = false;
  text = lines(s);
  assert.match(
    text,
    /Code review disabled · Testing disabled · Commit disabled/,
  );
  assert.doesNotMatch(text, /○ Code Reviewer|○ Tester|○ Commit Agent/);
});

test("each disabled quality gate is rendered exactly once", () => {
  const s = state();
  s.config.qualityGates.pentest.enabled = true;
  const gates = [
    ["codeReview", "Code review disabled"],
    ["testing", "Testing disabled"],
    ["commit", "Commit disabled"],
  ] as const;

  for (const [gate, label] of gates) {
    s.config.qualityGates[gate].enabled = false;
    const text = lines(s);
    assert.equal(text.split(label).length - 1, 1);
    for (const [otherGate, otherLabel] of gates)
      if (otherGate !== gate) assert.doesNotMatch(text, new RegExp(otherLabel));
    assert.doesNotMatch(text, /Pentest disabled/);
    s.config.qualityGates[gate].enabled = true;
  }

  for (const [gate] of gates) s.config.qualityGates[gate].enabled = false;
  s.config.qualityGates.pentest.enabled = false;
  const text = lines(s);
  for (const label of ["Pentest disabled", ...gates.map(([, label]) => label)])
    assert.equal(text.split(label).length - 1, 1);
});

test("agent lifecycle and heartbeat update elapsed time without duplicate timers", () => {
  let now = 0,
    redraws = 0,
    scheduled = 0,
    cleared = 0,
    tick = () => {};
  const runtime = new ProgressRuntime(
    () => redraws++,
    2000,
    () => now,
    true,
    (callback, ms) => {
      assert.equal(ms, 2000);
      scheduled++;
      tick = callback;
      return () => cleared++;
    },
  );
  const s = state();
  runtime.bind(s);
  runtime.event({ type: "start", role: "researcher" });
  runtime.event({ type: "start", role: "solver1" });
  assert.equal(scheduled, 1);
  now = 65000;
  tick();
  assert.match(lines(s, runtime), /● Researcher  01:05/);
  assert.ok(redraws >= 4);
  runtime.event({ type: "complete", role: "researcher" });
  assert.equal(runtime.heartbeatActive, true);
  runtime.event({ type: "fail", role: "solver1", error: "secret token" });
  assert.equal(runtime.heartbeatActive, false);
  assert.equal(cleared, 1);
  assert.match(lines(s, runtime), /✗ Solver Architecture/);
  assert.doesNotMatch(lines(s, runtime), /secret token/);
  assert.equal(elapsed(65000), "01:05");
  runtime.dispose();
  assert.equal(cleared, 1);
});

test("cancellation and disposal clear activity and stop heartbeat", () => {
  let cleared = 0;
  const runtime = new ProgressRuntime(
    () => {},
    500,
    Date.now,
    true,
    () => () => cleared++,
  );
  const s = state();
  runtime.bind(s);
  runtime.event({ type: "start", role: "researcher" });
  runtime.event({
    type: "activity",
    role: "researcher",
    toolName: "read",
    toolCallId: "1",
  });
  assert.match(lines(s, runtime), /Reading files/);
  runtime.cancel();
  assert.equal(runtime.heartbeatActive, false);
  assert.equal(cleared, 1);
  assert.match(lines(s, runtime), /stopped/);
  assert.doesNotMatch(lines(s, runtime), /Reading files|● Researcher/);
  runtime.event({ type: "start", role: "researcher" });
  runtime.dispose();
  assert.equal(cleared, 1);
  assert.equal(runtime.heartbeatActive, false);
});

test("tool labels are safe and clear only when the matching call ends", () => {
  for (const [name, label] of [
    ["serena_find_symbol", "Serena: symbols"],
    ["serena_find_referencing_symbols", "Serena: references"],
    ["context7_query-docs", "Context7"],
    ["mcp", "MCP tool"],
    ["web_search", "Web search"],
    ["team_local_http", "Local HTTP test"],
    ["team_command", "Running approved command"],
    ["validation_test", "Running tests"],
  ])
    assert.equal(formatToolActivity(name), label);
  assert.equal(
    formatToolActivity("secret/token?Authorization=Bearer-abc"),
    "Using tool",
  );
  const s = state(),
    runtime = new ProgressRuntime(
      () => {},
      2000,
      () => 0,
      false,
    );
  runtime.bind(s);
  runtime.event({ type: "start", role: "researcher" });
  runtime.event({
    type: "activity",
    role: "researcher",
    toolName: "read",
    toolCallId: "a",
  });
  runtime.event({ type: "activityEnd", role: "researcher", toolCallId: "b" });
  assert.match(lines(s, runtime), /Reading files/);
  runtime.event({ type: "activityEnd", role: "researcher", toolCallId: "a" });
  assert.doesNotMatch(lines(s, runtime), /Reading files/);
  runtime.dispose();
});

test("waiting for pi-ask replaces working state and restart never fabricates live timing", () => {
  const s = state(),
    runtime = new ProgressRuntime(
      () => {},
      2000,
      () => 0,
      false,
    );
  runtime.bind(s);
  runtime.event({ type: "start", role: "orchestrator" });
  runtime.event({ type: "complete", role: "orchestrator" });
  s.phase = "WAITING_USER";
  runtime.bind(s);
  assert.match(lines(s, runtime), /◉ Waiting for user input/);
  assert.doesNotMatch(lines(s, runtime), /● Orchestrator/);
  s.inFlight = { phase: "RESEARCH", roles: ["researcher"] };
  const restarted = lines(s);
  assert.match(restarted, /Live runtime details unavailable/);
  assert.doesNotMatch(restarted, /● Researcher|00:00/);
  runtime.dispose();
  const blocked = state(),
    blockedRuntime = new ProgressRuntime(() => {});
  blockedRuntime.bind(blocked);
  blockedRuntime.event({ type: "start", role: "researcher" });
  blocked.phase = "BLOCKED";
  blockedRuntime.bind(blocked);
  assert.equal(blockedRuntime.heartbeatActive, false);
  assert.match(lines(blocked, blockedRuntime), /✗ Researcher/);
  blockedRuntime.dispose();
});

test("progress configuration validates refresh bounds and defaults", () => {
  const s = state();
  assert.deepEqual(s.config.ui.progress, {
    enabled: true,
    refreshMs: 2000,
    showToolActivity: true,
    showModels: false,
    showToolProvider: false,
  });
  for (const refreshMs of [1, 499, 10001])
    assert.equal(
      configSchema.safeParse({ ...s.config, ui: { progress: { refreshMs } } })
        .success,
      false,
    );
  assert.equal(
    configSchema.safeParse({
      ...s.config,
      ui: { progress: { refreshMs: 500 } },
    }).success,
    true,
  );
});

test("parallel solver events update each result before siblings settle", async () => {
  const cwd = await repository(),
    slots = [deferred<any>(), deferred<any>(), deferred<any>()],
    runtime = new ProgressRuntime(() => {}, 2000, Date.now, false);
  class DelayedRunner extends FixtureRunner {
    override async run(role: Role, s: WorkflowState) {
      if (role.startsWith("solver"))
        return slots[Number(role.slice(-1)) - 1].promise;
      return super.run(role, s);
    }
  }
  const engine = new WorkflowEngine(cwd, new DelayedRunner(), {
    progress: (current) => runtime.bind(current),
    agentEvent: (event) => runtime.event(event),
    ask: async () => undefined,
  });
  const s = await engine.start("Fix addition", config());
  s.phase = "SOLVE";
  s.commandApprovalComplete = true;
  const run = engine.run(s);
  await eventually(() =>
    ["solver1", "solver2", "solver3"].every(
      (role) => runtime.agents[role as Role]?.status === "running",
    ),
  );
  slots[0].resolve(output("solver1"));
  await eventually(() => runtime.agents.solver1?.status === "completed");
  assert.match(lines(s, runtime), /✓ Solver Architecture/);
  assert.match(lines(s, runtime), /● Solver Pragmatic/);
  assert.match(lines(s, runtime), /● Solver Alternative/);
  slots[1].reject(new Error("provider unavailable"));
  await eventually(() => runtime.agents.solver2?.status === "failed");
  assert.match(lines(s, runtime), /✗ Solver Pragmatic/);
  assert.match(lines(s, runtime), /● Solver Alternative/);
  slots[2].resolve(output("solver3"));
  const result = await run;
  assert.equal(result.phase, "BLOCKED");
  runtime.dispose();
});

test("/team-status reports live agent and /team-stop removes working display", async () => {
  const cwd = await repository();
  await writeFile(
    join(cwd, ".pi", "team", "team.yaml"),
    YAML.stringify(config()),
  );
  const commands = new Map<string, any>(),
    notices: string[] = [],
    widgets: string[][] = [],
    statuses: string[] = [];
  teamExtension({
    on: () => {},
    registerCommand: (name: string, command: any) =>
      commands.set(name, command),
    appendEntry: () => {},
  } as any);
  const ctx = {
    cwd,
    waitForIdle: async () => {},
    ui: {
      notify: (message: string) => notices.push(message),
      setStatus: (_key: string, value: string) => statuses.push(value),
      setWidget: (_key: string, value: string[]) => widgets.push(value),
    },
  };
  const researcher = deferred<any>(),
    original = PiRunner.prototype.run;
  PiRunner.prototype.run = async (role: Role) =>
    role === "researcher" ? researcher.promise : output(role);
  try {
    const task = commands.get("team").handler("Fix addition", ctx);
    await eventually(() =>
      widgets.some((widget) =>
        widget?.some((line) => line.includes("● Researcher")),
      ),
    );
    await commands.get("team-status").handler("", ctx);
    assert.match(notices.at(-1) ?? "", /● Researcher/);
    assert.match(notices.at(-1) ?? "", /Pentest disabled/);
    await commands.get("team-stop").handler("", ctx);
    assert.match(widgets.at(-1)?.join("\n") ?? "", /stopped/);
    assert.match(statuses.at(-1) ?? "", /STOPPED/);
    assert.doesNotMatch(widgets.at(-1)?.join("\n") ?? "", /● Researcher/);
    researcher.resolve(output("researcher"));
    await task;
    const restarted = new Map<string, any>();
    teamExtension({
      on: () => {},
      registerCommand: (name: string, command: any) =>
        restarted.set(name, command),
    } as any);
    await restarted.get("team-status").handler("", ctx);
    assert.match(notices.at(-1) ?? "", /Live runtime details unavailable/);
  } finally {
    PiRunner.prototype.run = original;
  }
});

test("progress observer failures cannot change agent or workflow outcomes", async () => {
  const runtime = new ProgressRuntime(() => {
    throw new Error("widget unavailable");
  });
  assert.doesNotThrow(() =>
    runtime.event({ type: "start", role: "researcher" }),
  );
  runtime.dispose();
  const cwd = await repository();
  const engine = new WorkflowEngine(cwd, new FixtureRunner(), {
    progress: () => {},
    agentEvent: () => {
      throw new Error("widget unavailable");
    },
    ask: async () => undefined,
  });
  const s = await engine.start("Fix addition", config());
  assert.equal((await engine.run(s)).phase, "DONE");
});
