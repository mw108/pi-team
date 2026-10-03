import { test } from "node:test";
import assert from "node:assert/strict";
import { WorkflowEngine } from "../src/workflow/engine.ts";
import { block, validateState } from "../src/workflow/state.ts";
import { getWorkflowRecoveryPlan } from "../src/workflow/recovery.ts";
import { FixtureRunner, config, output, repository } from "./helpers.ts";

const ui = { progress: () => {}, ask: async () => undefined };
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("simultaneous retries prepare one manual transition", async () => {
  const cwd = await repository();
  const first = new WorkflowEngine(cwd, new FixtureRunner(), ui);
  const state = await first.start("Fix", config());
  state.phase = "DONE";
  state.results.reporter = output("reporter");
  await first.store.save(state);
  const second = new WorkflowEngine(cwd, new FixtureRunner(), ui);
  const detached = await second.store.load(state.id);
  const outcomes = await Promise.allSettled([
    first.retryAgent(state, "reporter", true),
    second.retryAgent(detached, "reporter", true),
  ]);
  assert.equal(
    outcomes.filter((result) => result.status === "fulfilled").length,
    1,
  );
  const latest = (await first.store.latest())!;
  assert.deepEqual(latest.manualRetry, { agent: "reporter", phase: "REPORT" });
  assert.equal(
    latest.history.filter(
      (event) => event.event === "agent_retry_requested_by_user",
    ).length,
    1,
  );
  await assert.rejects(
    second.retryAgent(detached, "reporter", true),
    /pending manual retry/,
  );
  validateState(latest);
});

test("retry and continue on one blocked state cannot both mutate it", async () => {
  const cwd = await repository();
  const cfg = config();
  cfg.qualityGates.commit.enabled = false;
  cfg.logging.agentLogs.level = "off";
  const initial = new WorkflowEngine(cwd, new FixtureRunner(), ui);
  const state = await initial.start("Fix", cfg);
  await initial.run(state);
  assert.equal(state.phase, "DONE", state.blocker);
  const removed = [
    "codeReviewer",
    "securityReviewer",
    "tester",
    "reporter",
  ] as const;
  for (const role of removed) delete state.results[role];
  state.history = state.history.filter((event) =>
    [
      "agent_attempt_started",
      "agent_attempt_completed",
      "agent_completed",
    ].includes(event.event)
      ? !removed.includes(
          (event.meta?.agent ?? event.detail) as (typeof removed)[number],
        )
      : true,
  );
  delete state.gateHashes;
  delete state.commit;
  delete state.commitIntent;
  state.phase = "IMPLEMENT";
  block(state, "Workflow stopped after IMPLEMENT completed");
  await initial.store.save(state);
  const plan = await getWorkflowRecoveryPlan(state, cwd);
  assert.equal(plan.kind, "continue", plan.reason);
  const retryEngine = new WorkflowEngine(cwd, new FixtureRunner(), ui);
  const continueEngine = new WorkflowEngine(cwd, new FixtureRunner(), ui);
  const retryState = await retryEngine.store.load(state.id);
  const continueState = await continueEngine.store.load(state.id);
  const acquired = deferred();
  const release = deferred();
  const originalLock = continueEngine.store.lock.bind(continueEngine.store);
  continueEngine.store.lock = async () => {
    const unlock = await originalLock();
    acquired.resolve();
    await release.promise;
    return unlock;
  };
  const continuation = continueEngine.continueBlocked(continueState);
  await acquired.promise;
  try {
    await assert.rejects(
      retryEngine.retryAgent(retryState, "implementor", true),
      /already running/,
    );
  } finally {
    release.resolve();
  }
  await continuation;
  const latest = (await initial.store.latest())!;
  validateState(latest);
  const retryEvents = latest.history.filter(
    (event) => event.event === "agent_retry_requested_by_user",
  );
  const continueEvents = latest.history.filter(
    (event) => event.event === "workflow_continue_requested",
  );
  assert.equal(retryEvents.length, 0);
  assert.equal(continueEvents.length, 1);
});

test("a failed mutation releases the workflow lock", async () => {
  const cwd = await repository();
  const engine = new WorkflowEngine(cwd, new FixtureRunner(), ui);
  const state = await engine.start("Fix", config());
  await assert.rejects(
    engine.retryAgent(state, "implementor"),
    /no attempt to retry yet/,
  );
  const unlock = await engine.store.lock();
  await unlock();
});
