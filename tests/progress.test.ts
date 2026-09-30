import test from "node:test";
import assert from "node:assert/strict";
import {
  config,
  repository,
  FixtureRunner,
  output,
  research,
} from "./helpers.ts";
import { configSchema } from "../src/config/schema.ts";
import { newState, record, type WorkflowState } from "../src/workflow/state.ts";
import { ProgressRuntime } from "../src/ui/runtime.ts";
import {
  deriveAgentProgressState,
  elapsed,
  renderProgress,
} from "../src/ui/progress.ts";
import { fix } from "../src/workflow/router.ts";
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
  delete s.config.agents.solver2.name;
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

test("configured names and legacy fallback render without changing agent IDs", () => {
  const s = state();
  s.config.agents.solver1.name = "Architecture Expert";
  assert.match(lines(s), /○ Architecture Expert/);
  assert.doesNotMatch(lines(s), /Solver Architecture/);
  assert.equal(s.results["Architecture Expert"], undefined);
  delete s.config.agents.solver1.name;
  assert.match(lines(s), /○ Solver Architecture/);
  assert.equal(s.results.solver1, undefined);
});

test("FIX_LOCAL invalidates historical success while Implementor attempt 2 runs or fails", () => {
  const s = state();
  s.results.implementor = { status: "IMPLEMENTED" };
  s.results.codeReviewer = { status: "FIX_LOCAL", findings: [] };
  record(s, "agent_attempt_completed", "implementor attempt 1 completed", {
    agent: "implementor",
    attempt: 1,
  });
  record(s, "agent_attempt_completed", "codeReviewer attempt 1 completed", {
    agent: "codeReviewer",
    attempt: 1,
  });
  fix(s, "FIX_LOCAL");
  const runtime = new ProgressRuntime(() => {}, 2000, Date.now, false);
  runtime.bind(s);
  record(s, "agent_attempt_started", "implementor attempt 2 started", {
    agent: "implementor",
    attempt: 2,
    retryNumber: 0,
    trigger: "fix_local",
  });
  assert.doesNotMatch(lines(s), /✓ Implementor/);
  runtime.event({ type: "start", role: "implementor", attempt: 2 });
  assert.equal(
    deriveAgentProgressState(s, "implementor", runtime).status,
    "running",
  );
  assert.equal(
    deriveAgentProgressState(s, "codeReviewer", runtime).status,
    "invalidated",
  );
  assert.match(lines(s, runtime), /● Implementor.*run 2/);
  assert.match(lines(s, runtime), /returned by Code Reviewer/);
  assert.match(lines(s, runtime), /↺ Code Reviewer.*re-review pending/);
  assert.doesNotMatch(lines(s, runtime), /✓ Implementor|✓ Code Reviewer/);
  record(s, "agent_attempt_failed", "implementor attempt 2 failed", {
    agent: "implementor",
    attempt: 2,
  });
  runtime.event({ type: "fail", role: "implementor", error: "failure" });
  assert.match(lines(s, runtime), /✗ Implementor.*run 2/);
  assert.match(lines(s, runtime), /↺ Code Reviewer/);
  assert.doesNotMatch(lines(s, runtime), /✓ Implementor|✓ Code Reviewer/);
  record(s, "agent_attempt_completed", "implementor attempt 3 completed", {
    agent: "implementor",
    attempt: 3,
  });
  runtime.event({ type: "complete", role: "implementor" });
  s.results.codeReviewer = { status: "APPROVED", findings: [] };
  record(s, "agent_attempt_completed", "codeReviewer attempt 2 completed", {
    agent: "codeReviewer",
    attempt: 2,
  });
  assert.match(lines(s, runtime), /✓ Implementor/);
  assert.match(lines(s, runtime), /✓ Code Reviewer/);
  runtime.dispose();
});
test("run and retry labels distinguish remediation from technical recovery", () => {
  for (const [trigger, returnedBy] of [
    ["pentest_remediation", "Pentester"],
    ["security_remediation", "Security Reviewer"],
  ] as const) {
    const s = state();
    record(s, "agent_attempt_started", "implementor run 2 started", {
      agent: "implementor",
      attempt: 2,
      retryNumber: 0,
      trigger,
    });
    assert.match(lines(s), /Implementor.*run 2/);
    assert.match(lines(s), new RegExp(`returned by ${returnedBy}`));
    assert.doesNotMatch(lines(s), /retry 1/);
  }
  const s = state();
  record(s, "agent_attempt_started", "implementor run 3 started", {
    agent: "implementor",
    attempt: 3,
    retryNumber: 1,
    trigger: "automatic_retry",
  });
  assert.match(lines(s), /Implementor.*run 3 · retry 1/);
  assert.doesNotMatch(lines(s), /returned by/);
});

test("FIX_DESIGN and FIX_REQUIREMENTS remove current success across rewinds", () => {
  for (const route of ["FIX_DESIGN", "FIX_REQUIREMENTS"] as const) {
    const s = state();
    s.results.orchestrator = { requirements: ["x"] };
    s.results.researcher = { unresolvedQuestions: [] };
    s.results.solver1 = { solverId: "solver1" };
    s.results.implementor = { status: "IMPLEMENTED" };
    for (const role of [
      "orchestrator",
      "researcher",
      "solver1",
      "implementor",
    ] as const)
      record(s, "agent_attempt_completed", `${role} completed`, {
        agent: role,
        attempt: 1,
      });
    fix(s, route);
    assert.equal(
      deriveAgentProgressState(s, "researcher").status,
      "invalidated",
    );
    assert.equal(deriveAgentProgressState(s, "solver1").status, "invalidated");
    assert.equal(
      deriveAgentProgressState(s, "implementor").status,
      "invalidated",
    );
    assert.equal(
      deriveAgentProgressState(s, "orchestrator").status,
      route === "FIX_REQUIREMENTS" ? "invalidated" : "completed",
    );
  }
});

test("runtime command syntax continues to require the stable agent ID", async () => {
  const cwd = await repository();
  const cfg = config();
  cfg.agents.solver1.name = "Architecture Expert";
  await writeFile(join(cwd, ".pi", "team", "team.yaml"), YAML.stringify(cfg));
  const commands = new Map<string, any>();
  const notices: string[] = [];
  teamExtension({
    on: () => {},
    registerCommand: (name: string, command: any) =>
      commands.set(name, command),
  } as any);
  const ctx = {
    cwd,
    ui: { notify: (message: string) => notices.push(message) },
  };
  await commands.get("team-retry").handler("Architecture Expert", ctx);
  assert.match(notices.at(-1) ?? "", /Usage: \/team-retry <agent-id>/);
  await commands.get("team-retry").handler("solver1", ctx);
  assert.match(notices.at(-1) ?? "", /No team workflow in this repository/);
});

test("zero doom-loop interventions stay hidden while tool calls and finalization remain visible", () => {
  const s = state();
  const runtime = new ProgressRuntime(() => {});
  runtime.bind(s);
  runtime.event({ type: "start", role: "solver1" });
  runtime.agents.solver1!.toolCalls = 12;
  let text = lines(s, runtime);
  assert.match(text, /tool calls: 12\/80/);
  assert.doesNotMatch(text, /doom-loop interventions/);
  runtime.agents.solver1!.doomLoopInterventions = 1;
  runtime.agents.solver1!.toolCalls = 53;
  text = lines(s, runtime);
  assert.match(text, /doom-loop interventions: 1\/2 · tool calls: 53\/80/);
  runtime.agents.solver1!.toolsDisabledForFinalization = true;
  assert.match(lines(s, runtime), /tools: disabled for finalization/);
  runtime.agents.solver1!.doomLoopInterventions = 0;
  text = lines(s, runtime);
  assert.doesNotMatch(text, /doom-loop interventions/);
  assert.match(text, /tool calls: 53\/80 · tools: disabled for finalization/);
  runtime.dispose();
});

test("unlimited tool budget renders a count without /0", () => {
  const s = state();
  s.config.workflow.maxToolCalls = 0;
  const runtime = new ProgressRuntime(() => {});
  runtime.bind(s);
  runtime.event({ type: "start", role: "solver1" });
  runtime.agents.solver1!.toolCalls = 53;
  assert.match(lines(s, runtime), /tool calls: 53(?:\n|$)/);
  assert.doesNotMatch(lines(s, runtime), /tool calls: 53\/0/);
  runtime.dispose();
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
  s.results.researcher = research;
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
  assert.equal(result.phase, "DONE", result.blocker);
  runtime.dispose();
});

test("/team-status reports live agent and /team-stop removes working display", async () => {
  const cwd = await repository();
  const cfg = config();
  cfg.agents.researcher.timeoutMs = 0;
  cfg.agents.researcher.name = "Research Analyst";
  await writeFile(join(cwd, ".pi", "team", "team.yaml"), YAML.stringify(cfg));
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
        widget?.some((line) => line.includes("● Research Analyst")),
      ),
    );
    await commands.get("team-status").handler("", ctx);
    assert.match(notices.at(-1) ?? "", /● Research Analyst/);
    assert.match(notices.at(-1) ?? "", /Pentest disabled/);
    await commands.get("team-stop").handler("", ctx);
    assert.match(widgets.at(-1)?.join("\n") ?? "", /stopped/);
    assert.match(statuses.at(-1) ?? "", /STOPPED/);
    assert.doesNotMatch(widgets.at(-1)?.join("\n") ?? "", /● Research Analyst/);
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
