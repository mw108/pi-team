import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import YAML from "yaml";
import { join } from "node:path";
import { WorkflowEngine } from "../src/workflow/engine.ts";
import teamExtension from "../src/index.ts";
import {
  block,
  type Phase,
  type WorkflowState,
} from "../src/workflow/state.ts";
import {
  getWorkflowRecoveryPlan,
  recoveryAction,
} from "../src/workflow/recovery.ts";
import { renderBlocked } from "../src/workflow/report.ts";
import { FixtureRunner, config, repository } from "./helpers.ts";
import { semanticConfigHash } from "../src/config/drift.ts";

const ui = { progress: () => {}, ask: async () => undefined };
async function completed(commit = false) {
  const cwd = await repository();
  const cfg = config();
  cfg.qualityGates.commit.enabled = commit;
  cfg.logging.agentLogs.level = "off";
  const runner = new FixtureRunner();
  const engine = new WorkflowEngine(cwd, runner, ui);
  const state = await engine.start("Fix addition", cfg);
  await engine.run(state);
  assert.equal(state.phase, "DONE", state.blocker);
  return { cwd, state, engine, runner };
}
async function blockedAt(phase: Phase, remove: string[], commit = false) {
  const fixture = await completed(commit);
  const { state, engine } = fixture;
  for (const role of remove) delete state.results[role];
  if (phase !== "COMMIT" && phase !== "REPORT") {
    if (phase === "IMPLEMENT") delete state.gateHashes;
    delete state.commit;
    delete state.commitIntent;
  }
  state.history = state.history.filter((event) => {
    if (
      event.event === "agent_attempt_started" ||
      event.event === "agent_attempt_completed" ||
      event.event === "agent_completed"
    )
      return !remove.includes(event.meta?.agent ?? event.detail);
    return true;
  });
  state.phase = phase;
  block(state, `Workflow stopped after ${phase} completed`);
  await engine.store.save(state);
  return fixture;
}

async function editConfig(cwd: string, edit: (config: any) => void) {
  const path = join(cwd, ".pi/team/team.yaml");
  const value = YAML.parse(await readFile(path, "utf8"));
  edit(value);
  await writeFile(path, YAML.stringify(value));
}

test("semantic fingerprint ignores runtime and presentation fields", () => {
  const previous = config();
  const current = structuredClone(previous);
  current.workflow.maxAgentFailures = 3;
  current.workflow.maxToolCalls = 0;
  current.agents.solver1.name = "Architecture Expert";
  current.ui.progress.refreshMs = 3000;
  assert.equal(semanticConfigHash(previous), semanticConfigHash(current));
  current.agents.reviewer.model = "different-model";
  assert.notEqual(semanticConfigHash(previous), semanticConfigHash(current));
});

test("runtime guardrail drift 2→3 and 80→9999 allows Code Reviewer continuation", async () => {
  const { cwd, state, engine, runner } = await blockedAt("IMPLEMENT", [
    "codeReviewer",
    "tester",
    "reporter",
  ]);
  state.blocker = "Interrupted mutating phase; inspect effects before recovery";
  await engine.store.save(state);
  await editConfig(cwd, (value) => {
    value.workflow.maxAgentFailures = 3;
    value.workflow.maxToolCalls = 9999;
  });
  const plan = await getWorkflowRecoveryPlan(state, cwd);
  assert.equal(plan.kind, "continue");
  assert.match(renderBlocked(state, plan), /Next action\n\/team-continue/);
  await engine.continueBlocked(state);
  assert.equal(state.phase, "DONE", state.blocker);
  assert.equal(runner.counts.codeReviewer, 2);
  assert.equal(state.config.workflow.maxAgentFailures, 3);
  assert.equal(state.config.workflow.maxToolCalls, 9999);
  assert.match(
    state.history.find((event) => event.event === "config_drift_accepted")
      ?.detail ?? "",
    /workflow.maxToolCalls/,
  );
});

test("runtime drift 80→0 gives the next agent unlimited tool calls", async () => {
  const { cwd, state, engine } = await blockedAt("IMPLEMENT", [
    "codeReviewer",
    "tester",
    "reporter",
  ]);
  state.blocker = "Interrupted mutating phase; inspect effects before recovery";
  await engine.store.save(state);
  await editConfig(cwd, (value) => {
    value.workflow.maxToolCalls = 0;
  });
  assert.equal((await getWorkflowRecoveryPlan(state, cwd)).kind, "continue");
  await engine.continueBlocked(state);
  assert.equal(state.phase, "DONE", state.blocker);
  assert.equal(state.config.workflow.maxToolCalls, 0);
});

test("resume accepts runtime drift using the shared analysis", async () => {
  const { cwd, state, engine } = await blockedAt("IMPLEMENT", [
    "codeReviewer",
    "tester",
    "reporter",
  ]);
  state.blocker = "Interrupted mutating phase; inspect effects before recovery";
  await engine.store.save(state);
  await editConfig(cwd, (value) => {
    value.workflow.maxToolCalls = 0;
  });
  await engine.resumeReadonly(state);
  assert.equal(state.config.workflow.maxToolCalls, 0);
  assert.equal((await getWorkflowRecoveryPlan(state, cwd)).kind, "continue");
});

test("legacy state blocks changed team YAML without a semantic snapshot", async () => {
  const { cwd, state, engine } = await blockedAt("IMPLEMENT", [
    "codeReviewer",
    "tester",
    "reporter",
  ]);
  state.blocker = "Interrupted mutating phase; inspect effects before recovery";
  delete state.semanticConfigHash;
  delete state.driftConfigSnapshot;
  await engine.store.save(state);
  assert.equal((await getWorkflowRecoveryPlan(state, cwd)).kind, "continue");
  await editConfig(cwd, (value) => {
    value.workflow.maxToolCalls = 0;
  });
  const plan = await getWorkflowRecoveryPlan(state, cwd);
  assert.equal(plan.kind, "unsafe");
  assert.match(plan.reason, /legacy state/);
});

test("presentation drift in name, UI, and logging allows continuation", async () => {
  const { cwd, state, engine } = await blockedAt("IMPLEMENT", [
    "codeReviewer",
    "tester",
    "reporter",
  ]);
  state.blocker = "Interrupted mutating phase; inspect effects before recovery";
  await engine.store.save(state);
  await editConfig(cwd, (value) => {
    value.agents.solver1.name = "Architecture Expert";
    value.ui.progress.refreshMs = 3000;
    value.logging.agentLogs.level = "off";
  });
  assert.equal((await getWorkflowRecoveryPlan(state, cwd)).kind, "continue");
  await engine.continueBlocked(state);
  assert.equal(state.phase, "DONE", state.blocker);
  assert.equal(state.config.agents.solver1.name, "Architecture Expert");
});

test("future Code Reviewer prompt and model changes are accepted", async () => {
  const { cwd, state, engine } = await blockedAt("IMPLEMENT", [
    "codeReviewer",
    "tester",
    "reporter",
  ]);
  state.blocker = "Interrupted mutating phase; inspect effects before recovery";
  await engine.store.save(state);
  await editConfig(cwd, (value) => {
    value.agents.codeReviewer.model = "future-model";
  });
  await writeFile(
    join(cwd, ".pi/team/agents/code-reviewer.md"),
    "Updated Code Reviewer instructions",
  );
  assert.equal((await getWorkflowRecoveryPlan(state, cwd)).kind, "continue");
  await engine.continueBlocked(state);
  assert.equal(state.phase, "DONE", state.blocker);
  assert.equal(state.config.agents.codeReviewer.model, "future-model");
  assert.match(
    state.history.find((event) => event.event === "config_drift_accepted")
      ?.detail ?? "",
    /agents.codeReviewer.prompt/,
  );
});

test("consumed Reviewer prompt and model changes block continuation", async () => {
  for (const kind of ["prompt", "model"] as const) {
    const { cwd, state, engine } = await blockedAt("IMPLEMENT", [
      "codeReviewer",
      "tester",
      "reporter",
    ]);
    state.blocker =
      "Interrupted mutating phase; inspect effects before recovery";
    await engine.store.save(state);
    if (kind === "prompt")
      await writeFile(
        join(cwd, ".pi/team/agents/reviewer.md"),
        "Changed Reviewer instructions",
      );
    else
      await editConfig(cwd, (value) => {
        value.agents.reviewer.model = "changed-model";
      });
    const plan = await getWorkflowRecoveryPlan(state, cwd);
    assert.equal(plan.kind, "unsafe");
    assert.match(plan.reason, /agents.reviewer/);
    await assert.rejects(engine.continueBlocked(state), /Configuration drift/);
  }
});

test("completed Implementor continues with Code Reviewer attempt 1 and consistent advice", async () => {
  const { cwd, state, engine, runner } = await blockedAt("IMPLEMENT", [
    "codeReviewer",
    "tester",
    "reporter",
  ]);
  state.blocker = "Interrupted mutating phase; inspect effects before recovery";
  state.history.findLast((event) => event.event === "blocked")!.detail =
    state.blocker;
  await engine.store.save(state);
  const plan = await getWorkflowRecoveryPlan(state, cwd);
  assert.equal(plan.kind, "continue");
  assert.equal(plan.kind === "continue" && plan.nextPhase, "CODE_REVIEW");
  assert.equal(recoveryAction(plan), "/team-continue");
  assert.match(renderBlocked(state, plan), /Next action\n\/team-continue/);
  const before = runner.counts.implementor;
  await engine.continueBlocked(state);
  assert.equal(state.phase, "DONE", state.blocker);
  assert.equal(runner.counts.implementor, before);
  const attempt = state.history.findLast(
    (event) =>
      event.event === "agent_attempt_started" &&
      event.meta?.agent === "codeReviewer",
  );
  assert.equal(attempt?.meta?.attempt, 1);
  assert.equal(attempt?.meta?.trigger, "manual_continue");
  assert.ok(
    state.history.some(
      (event) =>
        event.event === "workflow_continue_requested" &&
        event.phase === "BLOCKED",
    ),
  );
  assert.ok(
    state.history.some(
      (event) =>
        event.event === "workflow_continued" && event.detail === "CODE_REVIEW",
    ),
  );
  const persisted = await engine.store.load(state.id);
  assert.equal(persisted.phase, "DONE");
  assert.equal(
    persisted.history.findLast(
      (event) =>
        event.event === "agent_attempt_started" &&
        event.meta?.agent === "codeReviewer",
    )?.meta?.trigger,
    "manual_continue",
  );
});

test("failed Implementor recommends retry and cannot continue", async () => {
  const { cwd, state, engine } = await blockedAt("IMPLEMENT", [
    "implementor",
    "codeReviewer",
    "tester",
    "reporter",
  ]);
  state.history.push({
    at: new Date().toISOString(),
    phase: "IMPLEMENT",
    event: "agent_attempt_started",
    detail: "implementor attempt 1",
    meta: { agent: "implementor", attempt: 1 },
  });
  state.history.push({
    at: new Date().toISOString(),
    phase: "IMPLEMENT",
    event: "agent_failure",
    detail: "implementor: provider failed",
  });
  state.blocker = "Agent execution failed: provider failed";
  await engine.store.save(state);
  const plan = await getWorkflowRecoveryPlan(state, cwd);
  assert.equal(recoveryAction(plan), "/team-retry implementor");
  state.config.agents.implementor.name = "Build Expert";
  assert.match(renderBlocked(state, plan), /Build Expert \(implementor\)/);
  assert.match(renderBlocked(state, plan), /\/team-retry implementor/);
  await assert.rejects(
    engine.continueBlocked(state),
    /has not completed successfully/,
  );
  assert.equal(
    state.history.filter(
      (event) =>
        event.event === "agent_attempt_started" &&
        event.meta?.agent === "codeReviewer",
    ).length,
    0,
  );
});

test("interrupted mutating phase refuses continuation", async () => {
  const { cwd, state, engine } = await blockedAt("IMPLEMENT", [
    "implementor",
    "codeReviewer",
    "tester",
    "reporter",
  ]);
  state.history.push({
    at: new Date().toISOString(),
    phase: "IMPLEMENT",
    event: "agent_attempt_started",
    detail: "implementor attempt 1",
    meta: { agent: "implementor", attempt: 1 },
  });
  state.blocker = "Interrupted mutating phase; inspect effects before recovery";
  await engine.store.save(state);
  const plan = await getWorkflowRecoveryPlan(state, cwd);
  assert.equal(plan.kind, "unsafe");
  await assert.rejects(
    engine.continueBlocked(state),
    /inspect repository changes/,
  );
});

test("a prior Implementor result cannot satisfy a later local fix", async () => {
  const { cwd, state, engine } = await blockedAt("IMPLEMENT", [
    "codeReviewer",
    "tester",
    "reporter",
  ]);
  state.history.push({
    at: new Date().toISOString(),
    phase: "CODE_REVIEW",
    event: "FIX_LOCAL",
    detail: "",
  });
  await engine.store.save(state);
  const plan = await getWorkflowRecoveryPlan(state, cwd);
  assert.equal(plan.kind, "unsafe");
  await assert.rejects(
    engine.continueBlocked(state),
    /inspect repository changes/,
  );
  assert.equal(
    state.history.filter(
      (event) =>
        event.event === "agent_attempt_started" &&
        event.meta?.agent === "codeReviewer",
    ).length,
    0,
  );
});

test("an invalidated old Code Reviewer attempt does not block the new phase", async () => {
  const { cwd, state, engine } = await completed();
  for (const role of ["codeReviewer", "tester", "reporter"])
    delete state.results[role];
  delete state.gateHashes;
  state.history.push({
    at: new Date().toISOString(),
    phase: "CODE_REVIEW",
    event: "FIX_LOCAL",
    detail: "",
  });
  state.history.push({
    at: new Date().toISOString(),
    phase: "IMPLEMENT",
    event: "agent_completed",
    detail: "implementor",
  });
  state.phase = "IMPLEMENT";
  block(state, "Workflow stopped after IMPLEMENT completed");
  await engine.store.save(state);
  const plan = await getWorkflowRecoveryPlan(state, cwd);
  assert.equal(plan.kind === "continue" && plan.nextPhase, "CODE_REVIEW");
  await engine.continueBlocked(state);
  assert.equal(state.phase, "DONE", state.blocker);
  assert.equal(
    state.history.findLast(
      (event) =>
        event.event === "agent_attempt_started" &&
        event.meta?.agent === "codeReviewer",
    )?.meta?.attempt,
    2,
  );
});

test("completed Code Reviewer advances to next enabled phase and skips disabled Pentest", async () => {
  const { cwd, state, engine, runner } = await blockedAt("CODE_REVIEW", [
    "tester",
    "reporter",
  ]);
  const plan = await getWorkflowRecoveryPlan(state, cwd);
  assert.equal(plan.kind === "continue" && plan.nextPhase, "TEST");
  const before = runner.counts.codeReviewer;
  await engine.continueBlocked(state);
  assert.equal(state.phase, "DONE", state.blocker);
  assert.equal(runner.counts.codeReviewer, before);
  assert.equal(runner.counts.pentester, undefined);
  assert.equal(
    state.history.findLast(
      (event) =>
        event.event === "agent_attempt_started" &&
        event.meta?.agent === "tester",
    )?.meta?.trigger,
    "manual_continue",
  );
});

test("committed work can continue directly to Reporter", async () => {
  const { cwd, state, engine, runner } = await blockedAt(
    "COMMIT",
    ["reporter"],
    true,
  );
  const plan = await getWorkflowRecoveryPlan(state, cwd);
  assert.equal(plan.kind === "continue" && plan.nextPhase, "REPORT");
  const commits = runner.counts.commitAgent;
  await engine.continueBlocked(state);
  assert.equal(state.phase, "DONE", state.blocker);
  assert.equal(runner.counts.commitAgent, commits);
  assert.equal(
    state.history.findLast(
      (event) =>
        event.event === "agent_attempt_started" &&
        event.meta?.agent === "reporter",
    )?.meta?.attempt,
    1,
  );
});

test("configuration drift and repository drift refuse continuation", async () => {
  const configFixture = await blockedAt("IMPLEMENT", [
    "codeReviewer",
    "tester",
    "reporter",
  ]);
  const changedConfigPath = join(configFixture.cwd, ".pi/team/team.yaml");
  const changedConfig = YAML.parse(await readFile(changedConfigPath, "utf8"));
  changedConfig.qualityGates.testing.enabled =
    !changedConfig.qualityGates.testing.enabled;
  await writeFile(changedConfigPath, YAML.stringify(changedConfig));
  assert.equal(
    (await getWorkflowRecoveryPlan(configFixture.state, configFixture.cwd))
      .kind,
    "unsafe",
  );
  await assert.rejects(
    configFixture.engine.continueBlocked(configFixture.state),
    /Configuration drift/i,
  );
  const repoFixture = await blockedAt("CODE_REVIEW", ["tester", "reporter"]);
  await writeFile(join(repoFixture.cwd, "unrelated.txt"), "unrelated\n");
  assert.equal(
    (await getWorkflowRecoveryPlan(repoFixture.state, repoFixture.cwd)).kind,
    "unsafe",
  );
  await assert.rejects(
    repoFixture.engine.continueBlocked(repoFixture.state),
    /Repository changed/,
  );
});

test("WAITING_USER, DONE, and running phases do not continue", async () => {
  const { cwd, state, engine } = await completed();
  assert.equal(
    (await getWorkflowRecoveryPlan(state, cwd)).reason,
    "Workflow is already DONE.",
  );
  await assert.rejects(engine.continueBlocked(state), /already DONE/);
  state.phase = "WAITING_USER";
  state.pendingQuestion = {
    type: "QUESTION_REQUEST",
    blocking: true,
    question: "Proceed?",
    reason: "Need answer",
  };
  await engine.store.save(state);
  assert.equal(
    (await getWorkflowRecoveryPlan(state, cwd)).kind,
    "waiting-user",
  );
  await assert.rejects(engine.continueBlocked(state), /waiting for user input/);
  delete state.pendingQuestion;
  state.phase = "TEST";
  await engine.store.save(state);
  assert.equal(
    (await getWorkflowRecoveryPlan(state, cwd)).reason,
    "Workflow is already running.",
  );
  await assert.rejects(engine.continueBlocked(state), /already running/);
});

test("concurrent continuation produces one new attempt", async () => {
  const { state, engine, runner } = await blockedAt("IMPLEMENT", [
    "codeReviewer",
    "tester",
    "reporter",
  ]);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const original = runner.custom;
  // A new engine shares the same persisted state and lock with the first.
  const waiting = new FixtureRunner(async (role, s, count) => {
    if (role === "codeReviewer") await gate;
    return original?.(role, s, count);
  });
  const firstEngine = new WorkflowEngine(state.cwd, waiting, ui);
  const secondEngine = new WorkflowEngine(state.cwd, new FixtureRunner(), ui);
  const first = firstEngine.continueBlocked(state);
  while (!waiting.calls.includes("codeReviewer"))
    await new Promise((resolve) => setTimeout(resolve, 5));
  await assert.rejects(secondEngine.continueBlocked(state), /already running/);
  release();
  await first;
  assert.equal(waiting.counts.codeReviewer, 1);
});

test("runtime command rejects arguments and status and report share recovery advice", async () => {
  const { cwd, state, engine } = await blockedAt("IMPLEMENT", [
    "codeReviewer",
    "tester",
    "reporter",
  ]);
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
  assert.ok(commands.has("team-continue"));
  await commands.get("team-status").handler("", ctx);
  assert.match(notices.at(-1) ?? "", /Next safe action: \/team-continue/);
  await commands.get("team-report").handler("", ctx);
  assert.match(notices.at(-1) ?? "", /Next action\n\/team-continue/);
  for (const argument of ["codeReviewer", "CODE_REVIEW"] as const) {
    await commands.get("team-continue").handler(argument, ctx);
    assert.match(notices.at(-1) ?? "", /Usage: \/team-continue/);
  }
  assert.equal((await engine.store.load(state.id)).phase, "BLOCKED");
});
