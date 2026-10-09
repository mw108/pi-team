import { test } from "node:test";
import assert from "node:assert/strict";
import { WorkflowEngine } from "../src/workflow/engine.ts";
import {
  classifyQualityGateBlocker,
  getWorkflowRecoveryPlan,
} from "../src/workflow/recovery.ts";
import { renderLiveProgress, renderProgress } from "../src/ui/progress.ts";
import { renderBlocked } from "../src/workflow/report.ts";
import { FixtureRunner, config, output, repository } from "./helpers.ts";

const ui = { progress: () => {}, ask: async () => undefined };

async function blockedTester() {
  const cwd = await repository();
  const cfg = config();
  cfg.qualityGates.commit.enabled = false;
  cfg.qualityGates.pentest.enabled = true;
  cfg.logging.agentLogs.level = "off";
  const runner = new FixtureRunner(async (role) =>
    role === "tester"
      ? {
          status: "BLOCKED",
          reason: "No approved command IDs are available",
          commands: [],
          failedAreas: [],
        }
      : undefined,
  );
  const engine = new WorkflowEngine(cwd, runner, ui);
  const state = await engine.start("Fix addition", cfg);
  await engine.run(state);
  assert.equal(state.phase, "BLOCKED");
  assert.equal(state.agentFailures, 0);
  return { cwd, state, engine, runner };
}

test("completed BLOCKED Tester retries after restart without rewinding upstream gates", async () => {
  const { cwd, state, engine } = await blockedTester();
  const upstream = {
    implementor: structuredClone(state.results.implementor),
    codeReviewer: structuredClone(state.results.codeReviewer),
    pentester: structuredClone(state.results.pentester),
    securityReviewer: structuredClone(state.results.securityReviewer),
  };
  for (const event of state.history) {
    if (event.meta?.agent === "tester" && event.meta.attempt === 1) {
      event.meta.attempt = 5;
      if (event.event === "agent_attempt_started") event.meta.retryNumber = 3;
    }
  }
  state.blockerMeta!.sourceAttempt = 5;
  state.agentFailures = 1;
  state.results.commitAgent = output("commitAgent");
  state.results.reporter = output("reporter");
  const historyLength = state.history.length;
  await engine.store.save(state);

  const restarted = new WorkflowEngine(cwd, new FixtureRunner(), ui);
  const loaded = await restarted.store.load(state.id);
  assert.deepEqual(classifyQualityGateBlocker(loaded), {
    kind: "owned",
    agent: "tester",
    phase: "TEST",
    attempt: 5,
  });
  const plan = await getWorkflowRecoveryPlan(loaded, cwd);
  assert.equal(plan.kind, "completed-quality-gate-blocked", plan.reason);
  assert.ok(
    plan.actions.some((action) => action.command === "/team-retry tester"),
  );
  assert.match(renderBlocked(loaded, plan), /Next action\n\/team-retry tester/);
  assert.doesNotMatch(renderBlocked(loaded, plan), /✓ Tester/);
  await assert.rejects(
    restarted.continueBlocked(loaded),
    /\/team-retry tester/,
  );
  await assert.rejects(
    restarted.retryAgent(loaded, "tester", false, "keep"),
    /No interrupted mutating attempt/,
  );
  assert.doesNotMatch(
    renderProgress(loaded, undefined, true).join("\n"),
    /✓ Tester/,
  );
  assert.match(
    renderProgress(loaded, undefined, true).join("\n"),
    /◉ Tester \(tester\).*BLOCKED/,
  );
  assert.equal(
    renderLiveProgress(loaded).filter((line) => line.startsWith("◉ Tester"))
      .length,
    1,
  );

  assert.equal(await restarted.retryAgent(loaded, "tester"), "prepared");
  assert.equal(loaded.phase, "TEST");
  assert.equal(loaded.blocker, undefined);
  assert.equal(loaded.blockerMeta, undefined);
  assert.equal(loaded.results.tester, undefined);
  assert.equal(loaded.results.previous_tester?.status, "BLOCKED");
  assert.equal(loaded.agentFailures, 1);
  assert.deepEqual(loaded.results.implementor, upstream.implementor);
  assert.deepEqual(loaded.results.codeReviewer, upstream.codeReviewer);
  assert.deepEqual(loaded.results.pentester, upstream.pentester);
  assert.deepEqual(loaded.results.securityReviewer, upstream.securityReviewer);
  assert.equal(loaded.results.commitAgent, undefined);
  assert.equal(loaded.results.reporter, undefined);
  assert.ok(loaded.results.previous_commitAgent);
  assert.ok(loaded.results.previous_reporter);
  assert.deepEqual(
    loaded.history.slice(0, historyLength),
    state.history.slice(0, historyLength),
  );
  assert.ok(
    loaded.history.some(
      (event) =>
        event.event === "agent_retry_requested_by_user" &&
        event.meta?.sourceOutcome === "BLOCKED" &&
        event.meta.sourceAttempt === 5,
    ),
  );
  await restarted.run(loaded);
  assert.equal(loaded.phase, "DONE", loaded.blocker);
  assert.equal(loaded.agentFailures, 1);
  assert.equal(
    (await restarted.store.load(loaded.id)).results.tester?.status,
    "PASS",
  );
  const starts = loaded.history.filter(
    (event) =>
      event.event === "agent_attempt_started" && event.meta?.agent === "tester",
  );
  assert.equal(starts.at(-1)?.meta?.attempt, 6);
  assert.equal(starts.at(-1)?.meta?.trigger, "manual_retry");
});

test("legacy completed Tester blocker is inferred only from matching lifecycle", async () => {
  const { cwd, state, engine } = await blockedTester();
  delete state.blockerMeta;
  await engine.store.save(state);
  const restarted = new WorkflowEngine(cwd, new FixtureRunner(), ui);
  const loaded = await restarted.store.load(state.id);
  assert.equal(classifyQualityGateBlocker(loaded)?.kind, "owned");
  assert.equal(await restarted.retryAgent(loaded, "tester"), "prepared");
});

test("structured gate provenance remains usable when display reason changes", async () => {
  const { state, engine } = await blockedTester();
  state.results.tester!.reason = "Updated diagnostic wording";
  await engine.store.save(state);
  assert.equal(classifyQualityGateBlocker(state)?.kind, "owned");
  assert.equal(await engine.retryAgent(state, "tester"), "prepared");
});

test("unrelated and ambiguous blockers cannot be cleared by Tester retry", async () => {
  for (const variant of [
    "wrong-owner",
    "legacy-ambiguous",
    "configuration-drift",
  ] as const) {
    const { state, engine } = await blockedTester();
    if (variant === "wrong-owner")
      state.blockerMeta!.sourceAgent = "implementor";
    if (variant === "legacy-ambiguous") {
      delete state.blockerMeta;
      state.history = state.history.filter(
        (event) =>
          event.event !== "agent_completed" || event.detail !== "tester",
      );
    }
    if (variant === "configuration-drift")
      state.blocker = "Configuration drift detected";
    await engine.store.save(state);
    await assert.rejects(
      engine.retryAgent(state, "tester"),
      /ambiguous|blocker|drift/i,
    );
    assert.equal(state.phase, "BLOCKED");
    assert.equal(state.results.tester?.status, "BLOCKED");
  }
});

test("pending approval and live Tester prevent duplicate retry", async () => {
  const { state, engine } = await blockedTester();
  state.pendingApproval = {
    kind: "commands",
    title: "Approve?",
    prompt: "Command",
    options: [],
  };
  await engine.store.save(state);
  await assert.rejects(
    engine.retryAgent(state, "tester"),
    /waiting|pending|approval/i,
  );
  delete state.pendingApproval;
  await engine.store.save(state);
  engine.sessions.register({
    workflowId: state.id,
    agentId: "tester",
    attempt: 2,
    session: {} as never,
    startedAt: Date.now(),
    state: "running",
  });
  await assert.rejects(engine.retryAgent(state, "tester"), /active/i);
});

test("Tester PASS still renders as successful", async () => {
  const cwd = await repository();
  const cfg = config();
  cfg.qualityGates.commit.enabled = false;
  const engine = new WorkflowEngine(cwd, new FixtureRunner(), ui);
  const state = await engine.start("Fix addition", cfg);
  await engine.run(state);
  assert.equal(state.phase, "DONE", state.blocker);
  assert.match(renderProgress(state).join("\n"), /✓ Tester/);
});
