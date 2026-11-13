import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import YAML from "yaml";
import { join } from "node:path";
import { WorkflowEngine } from "../src/workflow/engine.ts";
import teamExtension from "../src/index.ts";
import {
  block,
  record,
  type Phase,
  type WorkflowState,
} from "../src/workflow/state.ts";
import {
  getWorkflowRecoveryPlan,
  interruptedQualityGate,
  recoveryAction,
} from "../src/workflow/recovery.ts";
import { renderBlocked } from "../src/workflow/report.ts";
import { FixtureRunner, config, repository } from "./helpers.ts";
import { semanticConfigHash } from "../src/config/drift.ts";
import { analyzeConfigDrift } from "../src/config/drift.ts";
import { loadConfig } from "../src/config/loader.ts";
import { fix } from "../src/workflow/router.ts";
import { isLimitBlockerStillActive } from "../src/workflow/limit-blocker.ts";
import { git } from "../src/workflow/git.ts";

async function pendingCodeReviewerRetry() {
  const fixture = await blockedAt("CODE_REVIEW", [
    "codeReviewer",
    "pentester",
    "securityReviewer",
    "tester",
    "commitAgent",
    "reporter",
  ]);
  const { state, engine } = fixture;
  state.agentFailures = 1;
  record(state, "agent_attempt_started", "codeReviewer run 4 started", {
    agent: "codeReviewer",
    attempt: 4,
    retryNumber: 2,
  });
  record(state, "agent_attempt_failed", "codeReviewer run 4: network error", {
    agent: "codeReviewer",
    attempt: 4,
    retryNumber: 2,
    reason: "network",
  });
  record(state, "agent_retry_requested_by_user", "codeReviewer manual retry", {
    agent: "codeReviewer",
    attempt: 4,
  });
  state.manualRetry = { agent: "codeReviewer", phase: "CODE_REVIEW" };
  state.blocker =
    "Project team changed after implementation; inspect repository effects and start a new workflow.";
  await engine.store.save(state);
  return fixture;
}

for (const command of ["retry", "continue"] as const)
  test(`uploaded Code Reviewer state resumes run 5 through ${command} after restart`, async () => {
    const { cwd, state } = await pendingCodeReviewerRetry();
    const plan = await getWorkflowRecoveryPlan(state, cwd);
    assert.equal(plan.kind, "unconsumed-manual-retry");
    assert.deepEqual(
      plan.actions.map((action) => action.command),
      ["/team-retry codeReviewer", "/team-continue", "/team-abort"],
    );
    assert.match(renderBlocked(state, plan), /\/team-retry codeReviewer/);
    assert.doesNotMatch(plan.reason, /incomplete attempt/);
    const runner = new FixtureRunner();
    const restarted = new WorkflowEngine(cwd, runner, ui);
    const loaded = await restarted.store.load(state.id);
    const requestsBefore = loaded.history.filter(
      (event) => event.event === "agent_retry_requested_by_user",
    ).length;
    const failuresBefore = loaded.agentFailures;
    if (command === "retry") {
      assert.equal(
        await restarted.retryAgent(loaded, "codeReviewer"),
        "prepared",
      );
      assert.equal(loaded.agentFailures, failuresBefore);
      assert.equal(
        loaded.history.filter(
          (event) => event.event === "agent_retry_requested_by_user",
        ).length,
        requestsBefore,
      );
      await restarted.run(loaded);
    } else await restarted.continueBlocked(loaded);
    const starts = loaded.history.filter(
      (event) =>
        event.event === "agent_attempt_started" &&
        event.meta?.agent === "codeReviewer",
    );
    assert.equal(starts.at(-1)?.meta?.attempt, 5);
    assert.equal(starts.at(-1)?.meta?.trigger, "manual_retry");
    assert.equal(loaded.manualRetry, undefined);
    assert.equal(
      loaded.history.filter(
        (event) => event.event === "agent_retry_requested_by_user",
      ).length,
      requestsBefore,
    );
    assert.equal(loaded.agentFailures, failuresBefore);
    assert.ok(loaded.results.implementor);
    assert.ok(loaded.results.codeReviewer);
  });

test("wrong agent cannot consume a pending Code Reviewer retry", async () => {
  const { cwd, state } = await pendingCodeReviewerRetry();
  const engine = new WorkflowEngine(cwd, new FixtureRunner(), ui);
  await assert.rejects(
    engine.retryAgent(state, "implementor"),
    /\/team-retry codeReviewer/,
  );
  assert.deepEqual(state.manualRetry, {
    agent: "codeReviewer",
    phase: "CODE_REVIEW",
  });
});

test("runtime drift between retry request and start remains resumable", async () => {
  const { cwd, state } = await pendingCodeReviewerRetry();
  await editConfig(cwd, (value) => {
    value.workflow.requestTimeoutMs = 123456;
    value.agents.implementor.thinking = "high";
  });
  const drift = analyzeConfigDrift(state, await loadConfig(cwd));
  assert.equal(drift.blocking, false);
  assert.deepEqual(drift.runtimeChanges, [
    "agents.implementor.thinking",
    "workflow.requestTimeoutMs",
  ]);
  assert.equal(
    (await getWorkflowRecoveryPlan(state, cwd)).kind,
    "unconsumed-manual-retry",
  );
  const restarted = new WorkflowEngine(cwd, new FixtureRunner(), ui);
  const loaded = await restarted.store.load(state.id);
  await restarted.continueBlocked(loaded);
  assert.equal(
    loaded.history.findLast(
      (event) =>
        event.event === "agent_attempt_started" &&
        event.meta?.agent === "codeReviewer",
    )?.meta?.attempt,
    5,
  );
  assert.equal(loaded.phase, "DONE");
});

test("interrupted read-only Code Reviewer run retries without repository recovery", async () => {
  const { cwd, state } = await pendingCodeReviewerRetry();
  delete state.manualRetry;
  state.history = state.history.filter(
    (event) =>
      !(
        event.event === "agent_attempt_failed" &&
        event.meta?.agent === "codeReviewer"
      ) &&
      !(
        event.event === "agent_retry_requested_by_user" &&
        event.meta?.agent === "codeReviewer"
      ),
  );
  state.inFlight = { phase: "CODE_REVIEW", roles: ["codeReviewer"] };
  const engine = new WorkflowEngine(cwd, new FixtureRunner(), ui);
  await engine.store.save(state);
  const plan = await getWorkflowRecoveryPlan(state, cwd);
  assert.equal(plan.kind, "retry-agent");
  assert.equal(plan.actions[0].command, "/team-retry codeReviewer");
  assert.equal(await engine.retryAgent(state, "codeReviewer"), "prepared");
  await engine.run(state);
  assert.equal(
    state.history.findLast(
      (event) =>
        event.event === "agent_attempt_started" &&
        event.meta?.agent === "codeReviewer",
    )?.meta?.attempt,
    5,
  );
  assert.ok(state.results.implementor);
});

test("retry attempt started before a crash is a separate read-only interruption", async () => {
  const { cwd, state } = await pendingCodeReviewerRetry();
  state.phase = "CODE_REVIEW";
  delete state.blocker;
  state.inFlight = { phase: "CODE_REVIEW", roles: ["codeReviewer"] };
  record(state, "agent_attempt_started", "codeReviewer run 5 started", {
    agent: "codeReviewer",
    attempt: 5,
    trigger: "manual_retry",
    retryNumber: 3,
  });
  const engine = new WorkflowEngine(cwd, new FixtureRunner(), ui);
  await engine.store.save(state);
  const plan = await getWorkflowRecoveryPlan(state, cwd);
  assert.equal(plan.kind, "retry-agent");
  assert.equal(plan.actions[0].command, "/team-retry codeReviewer");
  assert.equal(await engine.retryAgent(state, "codeReviewer"), "prepared");
  await engine.run(state);
  assert.equal(
    state.history.findLast(
      (event) =>
        event.event === "agent_attempt_started" &&
        event.meta?.agent === "codeReviewer",
    )?.meta?.attempt,
    6,
  );
  assert.equal(state.manualRetry, undefined);
});

test("persisted abort terminates a queued retry without changing repository files", async () => {
  const { cwd, state } = await pendingCodeReviewerRetry();
  const before = await git(cwd, ["status", "--short"]);
  const engine = new WorkflowEngine(cwd, new FixtureRunner(), ui);
  await assert.rejects(
    engine.abortPersisted(state, "implementor"),
    /Pending retry belongs to codeReviewer/,
  );
  await engine.abortPersisted(state, "codeReviewer");
  assert.equal(state.phase, "ABORTED");
  assert.equal(state.manualRetry, undefined);
  assert.equal(await git(cwd, ["status", "--short"]), before);
  assert.equal((await getWorkflowRecoveryPlan(state, cwd)).actions.length, 0);
});

test("semantic drift after implementation does not offer Resume", async () => {
  const { cwd, state, engine } = await pendingCodeReviewerRetry();
  delete state.manualRetry;
  delete state.blocker;
  state.phase = "CODE_REVIEW";
  await engine.store.save(state);
  await editConfig(cwd, (value) => {
    value.qualityGates.codeReview.enabled = false;
  });
  await engine.run(state);
  assert.equal(state.phase, "WAITING_USER");
  assert.equal(state.pendingApproval?.kind, "configDrift");
  assert.deepEqual(
    state.pendingApproval?.options.map((option) => option.value),
    ["abort"],
  );
  assert.match(
    state.pendingApproval?.prompt ?? "",
    /Resume is unavailable after implementation/,
  );
});

test("recovery planner always exposes an executable action for persisted nonterminal states", async () => {
  const { cwd, state } = await pendingCodeReviewerRetry();
  const cases: [string, (copy: WorkflowState) => void][] = [
    ["unconsumed retry", () => {}],
    [
      "ordinary blocked",
      (copy) => {
        delete copy.manualRetry;
        copy.blocker = "Agent execution failed: codeReviewer: network error";
      },
    ],
    [
      "read-only interrupted",
      (copy) => {
        delete copy.manualRetry;
        copy.inFlight = { phase: "CODE_REVIEW", roles: ["codeReviewer"] };
        copy.history = copy.history.filter(
          (event) =>
            !(
              event.event === "agent_attempt_failed" &&
              event.meta?.agent === "codeReviewer"
            ),
        );
      },
    ],
    [
      "mutating interrupted",
      (copy) => {
        delete copy.manualRetry;
        copy.inFlight = { phase: "IMPLEMENT", roles: ["implementor"] };
      },
    ],
    [
      "research question",
      (copy) => {
        delete copy.manualRetry;
        copy.phase = "WAITING_USER";
        copy.pendingResearchQuestions = ["What is required?"];
      },
    ],
    [
      "command approval",
      (copy) => {
        delete copy.manualRetry;
        copy.phase = "WAITING_USER";
        copy.pendingApproval = {
          kind: "runtimeCommand",
          title: "Approve",
          prompt: "Approve?",
          options: [],
        };
      },
    ],
    [
      "file approval",
      (copy) => {
        delete copy.manualRetry;
        copy.phase = "WAITING_USER";
        copy.pendingApproval = {
          kind: "runtimeFile",
          title: "Approve",
          prompt: "Approve?",
          options: [],
        };
      },
    ],
    [
      "FIX_REQUIREMENTS decision",
      (copy) => {
        delete copy.manualRetry;
        copy.phase = "WAITING_USER";
        copy.pendingQuestion = {
          type: "QUESTION_REQUEST",
          question: "Clarify?",
          reason: "Needed",
          blocking: true,
        };
      },
    ],
  ];
  for (const [name, change] of cases) {
    const copy = structuredClone(state);
    change(copy);
    const plan = await getWorkflowRecoveryPlan(copy, cwd);
    assert.ok(plan.actions.length, `${name}: ${plan.reason}`);
  }
});

const ui = { progress: () => {}, ask: async () => undefined };
async function completed(
  commit = false,
  pentest = false,
  testerWrites = false,
) {
  const cwd = await repository();
  const cfg = config();
  cfg.qualityGates.commit.enabled = commit;
  cfg.qualityGates.pentest.enabled = pentest;
  cfg.logging.agentLogs.level = "off";
  cfg.tester.mayModifyTests = testerWrites;
  const runner = new FixtureRunner();
  const engine = new WorkflowEngine(cwd, runner, ui);
  const state = await engine.start("Fix addition", cfg);
  await engine.run(state);
  assert.equal(state.phase, "DONE", state.blocker);
  return { cwd, state, engine, runner };
}
async function blockedAt(
  phase: Phase,
  remove: string[],
  commit = false,
  testerWrites = false,
) {
  const fixture = await completed(commit, false, testerWrites);
  const { state, engine } = fixture;
  for (const role of remove) delete state.results[role];
  state.executions = state.executions.filter((e) => !remove.includes(e.agent));
  if (phase !== "COMMIT" && phase !== "REPORT") {
    if (phase === "IMPLEMENT") delete state.gateHashes;
    delete state.commit;
    delete state.commitIntent;
  }
  state.history = state.history.filter((event) => {
    if (
      event.event === "agent_attempt_started" ||
      event.event === "execution_reserved" ||
      event.event === "execution_identity_updated" ||
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

test("legacy interrupted Pentester retry requires approval and resumes at attempt two", async () => {
  const { cwd, state, engine } = await blockedAt("PENTEST", [
    "pentester",
    "securityReviewer",
    "tester",
    "commitAgent",
    "reporter",
  ]);
  state.config.qualityGates.pentest.enabled = true;
  state.phase = "PENTEST";
  record(state, "agent_attempt_started", "pentester run 1 started", {
    agent: "pentester",
    attempt: 1,
  });
  block(
    state,
    "Interrupted PENTEST; inspect repository effects before recovery. Automatic replay of mutating work is disabled.",
  );
  record(state, "agent_retry_requested_by_user", "pentester manual retry", {
    agent: "pentester",
    attempt: 1,
  });
  state.manualRetry = { agent: "pentester", phase: "PENTEST" };
  await engine.store.save(state);
  const plan = await getWorkflowRecoveryPlan(state, cwd);
  assert.ok(
    plan.actions.some(
      (action) => action.command === "/team-retry pentester recover",
    ),
  );
  await assert.rejects(engine.retryAgent(state, "pentester"), /Interrupted/);
  const restarted = new WorkflowEngine(cwd, new FixtureRunner(), {
    ...ui,
    approve: async () => ["recover"],
  });
  assert.equal(
    await restarted.retryAgent(state, "pentester", false, "recover"),
    "prepared",
  );
  const accepted = await restarted.store.load(state.id);
  assert.ok(
    accepted.history.some(
      (event) => event.event === "interrupted_agent_recovery_accepted",
    ),
  );
  await restarted.run(state);
  assert.equal(
    state.history.filter(
      (event) =>
        event.event === "agent_attempt_started" &&
        event.meta?.agent === "pentester" &&
        event.meta.attempt === 2,
    ).length,
    1,
  );
  assert.equal(
    state.history.filter(
      (event) =>
        event.event === "agent_attempt_completed" &&
        event.meta?.agent === "pentester" &&
        event.meta.attempt === 1,
    ).length,
    0,
  );
  assert.ok(state.results.securityReviewer);
});

test("interrupted Tester requires approval and preserves upstream gates", async () => {
  const { cwd, state, engine } = await blockedAt("TEST", [
    "tester",
    "commitAgent",
    "reporter",
  ]);
  state.phase = "TEST";
  record(state, "agent_attempt_started", "tester run 1 started", {
    agent: "tester",
    attempt: 1,
  });
  block(
    state,
    "Interrupted TEST; inspect repository effects before recovery. Automatic replay of mutating work is disabled.",
  );
  await engine.store.save(state);
  assert.ok(
    (await getWorkflowRecoveryPlan(state, cwd)).actions.some(
      (action) => action.command === "/team-retry tester recover",
    ),
  );
  await assert.rejects(
    engine.retryAgent(state, "tester", false, "recover"),
    /cancelled/,
  );
  assert.equal((await engine.store.load(state.id)).manualRetry, undefined);
  const runner = new FixtureRunner();
  const restarted = new WorkflowEngine(cwd, runner, {
    ...ui,
    approve: async () => ["recover"],
  });
  assert.equal(
    await restarted.retryAgent(state, "tester", false, "recover"),
    "prepared",
  );
  await restarted.run(state);
  assert.equal(
    state.history.filter(
      (e) =>
        e.event === "agent_attempt_started" &&
        e.meta?.agent === "tester" &&
        e.meta.attempt === 2,
    ).length,
    1,
  );
  assert.ok(state.results.codeReviewer);
  assert.ok(state.results.securityReviewer);
  assert.ok(state.results.tester);
});

test("interrupted recovery rejects changed repository and missing snapshot without approving", async () => {
  const { cwd, state, engine } = await blockedAt("TEST", [
    "tester",
    "commitAgent",
    "reporter",
  ]);
  state.phase = "TEST";
  record(state, "agent_attempt_started", "tester run 1 started", {
    agent: "tester",
    attempt: 1,
  });
  block(
    state,
    "Interrupted TEST; inspect repository effects before recovery. Automatic replay of mutating work is disabled.",
  );
  await engine.store.save(state);
  let approvals = 0;
  const retry = new WorkflowEngine(cwd, new FixtureRunner(), {
    ...ui,
    approve: async () => {
      approvals++;
      return ["recover"];
    },
  });
  await writeFile(join(cwd, "unexpected.txt"), "external change");
  await assert.rejects(
    retry.retryAgent(state, "tester", false, "recover"),
    /Repository changed/,
  );
  assert.equal(approvals, 0);
  assert.equal((await retry.store.load(state.id)).manualRetry, undefined);
  const loaded = await retry.store.load(state.id);
  delete loaded.gateRepositorySnapshot;
  await retry.store.save(loaded);
  await assert.rejects(
    retry.retryAgent(loaded, "tester", false, "recover"),
    /Missing pre-attempt/,
  );
});

test("accepted crash recovery survives restart and can only be accepted once", async () => {
  const { cwd, state, engine } = await blockedAt("TEST", [
    "tester",
    "commitAgent",
    "reporter",
  ]);
  state.phase = "TEST";
  record(state, "agent_attempt_started", "tester run 1 started", {
    agent: "tester",
    attempt: 1,
  });
  block(
    state,
    "Interrupted TEST; inspect repository effects before recovery. Automatic replay of mutating work is disabled.",
  );
  await engine.store.save(state);
  const retry = new WorkflowEngine(cwd, new FixtureRunner(), {
    ...ui,
    approve: async () => ["recover"],
  });
  await retry.retryAgent(state, "tester", false, "recover");
  const fresh = new WorkflowEngine(cwd, new FixtureRunner(), ui);
  const loaded = await fresh.store.load(state.id);
  assert.equal(
    (await getWorkflowRecoveryPlan(loaded, cwd)).kind,
    "unconsumed-manual-retry",
  );
  await assert.rejects(fresh.retryAgent(loaded, "tester", false, "recover"));
  await fresh.continueBlocked(loaded);
  assert.equal(
    loaded.history.filter(
      (e) =>
        e.event === "agent_attempt_started" &&
        e.meta?.agent === "tester" &&
        e.meta.attempt === 2,
    ).length,
    1,
  );
  assert.equal(
    loaded.history.filter(
      (e) => e.event === "interrupted_agent_recovery_accepted",
    ).length,
    1,
  );
});

test("crash after retry startup requires a fresh decision for the newer attempt", async () => {
  const { cwd, state, engine } = await blockedAt("TEST", [
    "tester",
    "commitAgent",
    "reporter",
  ]);
  state.phase = "TEST";
  record(state, "agent_attempt_started", "tester run 1 started", {
    agent: "tester",
    attempt: 1,
  });
  block(
    state,
    "Interrupted TEST; inspect repository effects before recovery. Automatic replay of mutating work is disabled.",
  );
  await engine.store.save(state);
  const retry = new WorkflowEngine(cwd, new FixtureRunner(), {
    ...ui,
    approve: async () => ["recover"],
  });
  await retry.retryAgent(state, "tester", false, "recover");
  state.inFlight = { phase: "TEST", roles: ["tester"] };
  record(state, "agent_attempt_started", "tester run 2 started", {
    agent: "tester",
    attempt: 2,
    trigger: "manual_retry",
  });
  await retry.store.save(state);
  await retry.recover(state);
  assert.ok(
    (await getWorkflowRecoveryPlan(state, cwd)).actions.some(
      (a) => a.command === "/team-retry tester recover",
    ),
  );
  await retry.retryAgent(state, "tester", false, "recover");
  await retry.run(state);
  assert.equal(
    state.history.filter(
      (e) =>
        e.event === "agent_attempt_started" &&
        e.meta?.agent === "tester" &&
        e.meta.attempt === 3,
    ).length,
    1,
  );
});

test("interrupted quality gate classification rejects contradictory lifecycle", async () => {
  const { state } = await blockedAt("TEST", [
    "tester",
    "commitAgent",
    "reporter",
  ]);
  state.phase = "TEST";
  record(state, "agent_attempt_started", "tester run 1 started", {
    agent: "tester",
    attempt: 1,
  });
  block(
    state,
    "Interrupted TEST; inspect repository effects before recovery. Automatic replay of mutating work is disabled.",
  );
  assert.equal(interruptedQualityGate(state, "tester"), 1);
  assert.equal(interruptedQualityGate(state, "pentester"), undefined);
  const duplicate = structuredClone(state);
  duplicate.history.push(
    structuredClone(
      duplicate.history.findLast(
        (e) =>
          e.event === "agent_attempt_started" && e.meta?.agent === "tester",
      )!,
    ),
  );
  assert.equal(interruptedQualityGate(duplicate, "tester"), undefined);
  const missing = structuredClone(state);
  missing.history = missing.history.filter(
    (e) => !(e.event === "agent_attempt_started" && e.meta?.agent === "tester"),
  );
  assert.equal(interruptedQualityGate(missing, "tester"), undefined);
  const completed = structuredClone(state);
  record(completed, "agent_attempt_completed", "tester run 1 completed", {
    agent: "tester",
    attempt: 1,
  });
  assert.equal(interruptedQualityGate(completed, "tester"), undefined);
  const newerTerminal = structuredClone(state);
  record(newerTerminal, "agent_attempt_failed", "tester run 2 failed", {
    agent: "tester",
    attempt: 2,
  });
  assert.equal(interruptedQualityGate(newerTerminal, "tester"), undefined);
});

test("concurrent crash recovery requests cannot accept twice", async () => {
  const { cwd, state, engine } = await blockedAt("TEST", [
    "tester",
    "commitAgent",
    "reporter",
  ]);
  state.phase = "TEST";
  record(state, "agent_attempt_started", "tester run 1 started", {
    agent: "tester",
    attempt: 1,
  });
  block(
    state,
    "Interrupted TEST; inspect repository effects before recovery. Automatic replay of mutating work is disabled.",
  );
  await engine.store.save(state);
  const callbacks = { ...ui, approve: async () => ["recover"] };
  const a = new WorkflowEngine(cwd, new FixtureRunner(), callbacks);
  const b = new WorkflowEngine(cwd, new FixtureRunner(), callbacks);
  const [first, second] = await Promise.allSettled([
    a.retryAgent(structuredClone(state), "tester", false, "recover"),
    b.retryAgent(structuredClone(state), "tester", false, "recover"),
  ]);
  assert.equal(
    [first, second].filter((result) => result.status === "fulfilled").length,
    1,
  );
  const saved = await engine.store.load(state.id);
  assert.equal(
    saved.history.filter(
      (e) => e.event === "interrupted_agent_recovery_accepted",
    ).length,
    1,
  );
});

test("repository changes during recovery confirmation invalidate approval", async () => {
  const { cwd, state, engine } = await blockedAt("TEST", [
    "tester",
    "commitAgent",
    "reporter",
  ]);
  state.phase = "TEST";
  record(state, "agent_attempt_started", "tester run 1 started", {
    agent: "tester",
    attempt: 1,
  });
  block(
    state,
    "Interrupted TEST; inspect repository effects before recovery. Automatic replay of mutating work is disabled.",
  );
  await engine.store.save(state);
  const retry = new WorkflowEngine(cwd, new FixtureRunner(), {
    ...ui,
    approve: async () => {
      await writeFile(join(cwd, "changed-during-review.txt"), "change");
      return ["recover"];
    },
  });
  await assert.rejects(
    retry.retryAgent(state, "tester", false, "recover"),
    /changed-during-review\.txt/,
  );
  const saved = await retry.store.load(state.id);
  assert.equal(saved.manualRetry, undefined);
  assert.equal(
    saved.history.some(
      (e) => e.event === "interrupted_agent_recovery_accepted",
    ),
    false,
  );
});

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
  current.workflow.maxResearchClarifications = 10;
  current.workflow.requestTimeoutMs = 0;
  current.agents.implementor.requestTimeoutMs = 900000;
  current.agents.solver1.name = "Architecture Expert";
  current.ui.progress.refreshMs = 3000;
  current.execution.sandbox.mode = "required";
  current.execution.sandbox.network = "allow";
  current.execution.sandbox.pentestNetwork = "allow";
  assert.equal(semanticConfigHash(previous), semanticConfigHash(current));
  current.agents.reviewer.model = "different-model";
  assert.notEqual(semanticConfigHash(previous), semanticConfigHash(current));
});

test("sandbox settings are non-blocking runtime drift", async () => {
  const { cwd, state } = await blockedAt("IMPLEMENT", [
    "codeReviewer",
    "tester",
    "reporter",
  ]);
  await editConfig(cwd, (value) => {
    value.execution = {
      sandbox: { mode: "required", network: "allow", pentestNetwork: "allow" },
    };
  });
  const drift = analyzeConfigDrift(state, await loadConfig(cwd));
  assert.equal(drift.blocking, false);
  assert.deepEqual(drift.runtimeChanges, [
    "execution.sandbox.mode",
    "execution.sandbox.network",
    "execution.sandbox.pentestNetwork",
  ]);
});

test("request timeout changes remain non-blocking runtime drift", async () => {
  const { cwd, state, engine } = await blockedAt("IMPLEMENT", [
    "codeReviewer",
    "tester",
    "reporter",
  ]);
  state.blocker = "Provider request timed out";
  await engine.store.save(state);
  await editConfig(cwd, (value) => {
    value.workflow.requestTimeoutMs = 600000;
    value.agents.implementor.requestTimeoutMs = 0;
  });
  let drift = analyzeConfigDrift(state, await loadConfig(cwd));
  assert.equal(drift.blocking, false);
  assert.deepEqual(drift.runtimeChanges, [
    "agents.implementor.requestTimeoutMs",
    "workflow.requestTimeoutMs",
  ]);
  await engine.resumeReadonly(state);
  assert.equal(state.config.workflow.requestTimeoutMs, 600000);
  assert.equal(state.config.agents.implementor.requestTimeoutMs, 0);
  await editConfig(cwd, (value) => {
    value.workflow.requestTimeoutMs = 0;
  });
  drift = analyzeConfigDrift(state, await loadConfig(cwd));
  assert.equal(drift.blocking, false);
  assert.deepEqual(drift.runtimeChanges, ["workflow.requestTimeoutMs"]);
});

test("stale local fix limit 5→10 permits /team-continue and retains the counter", async () => {
  const { cwd, state, engine, runner } = await completed();
  state.localFixCycle = 5;
  state.phase = "CODE_REVIEW";
  (state.results.codeReviewer as { status: string }).status = "FIX_LOCAL";
  (state.results.codeReviewer as { findings: unknown[] }).findings = [
    {
      severity: "medium",
      file: "math.js",
      problem: "Missing edge case",
      suggestedFix: "Handle the edge case",
      requiresRedesign: false,
    },
  ];
  fix(state, "FIX_LOCAL");
  assert.equal(state.phase, "BLOCKED");
  await engine.store.save(state);
  await editConfig(cwd, (value) => {
    value.workflow.maxLocalFixCycles = 10;
  });
  const drift = analyzeConfigDrift(state, await loadConfig(cwd));
  assert.deepEqual(drift.runtimeChanges, ["workflow.maxLocalFixCycles"]);
  assert.equal(drift.blocking, false);
  const plan = await getWorkflowRecoveryPlan(state, cwd);
  assert.equal(plan.kind, "continue", plan.reason);
  assert.equal(plan.kind === "continue" && plan.nextPhase, "IMPLEMENT");
  assert.match(plan.reason, /no longer applies/);
  await engine.continueBlocked(state);
  assert.equal(state.phase, "DONE", state.blocker);
  assert.equal(state.localFixCycle, 6);
  assert.equal(state.config.workflow.maxLocalFixCycles, 10);
  assert.equal(runner.counts.implementor, 2);
});

test("other limit blockers are reevaluated against current counters", async () => {
  const { state } = await completed();
  state.blocker = "Pentest cycle limit reached";
  state.pentestCycle = 2;
  assert.equal(isLimitBlockerStillActive(state, state.config), true);
  state.config.workflow.maxPentestCycles = 3;
  assert.equal(isLimitBlockerStillActive(state, state.config), false);
  state.blocker = "Research clarification limit reached. Questions remain.";
  state.researchClarificationCount = 5;
  assert.equal(isLimitBlockerStillActive(state, state.config), true);
  state.config.workflow.maxResearchClarifications = 0;
  assert.equal(isLimitBlockerStillActive(state, state.config), false);
  state.blocker = "Agent failure limit reached";
  state.agentFailures = 2;
  assert.equal(isLimitBlockerStillActive(state, state.config), true);
  state.config.workflow.maxAgentFailures = 3;
  assert.equal(isLimitBlockerStillActive(state, state.config), false);
  state.blocker = "Repository changed";
  assert.equal(isLimitBlockerStillActive(state, state.config), undefined);
});

test("raised research clarification limit restores the pending question dialog", async () => {
  const { cwd, state, engine } = await completed();
  (
    state.results.researcher as { unresolvedQuestions: string[] }
  ).unresolvedQuestions = ["Which outcome is required?"];
  state.researchClarificationCount = 5;
  state.phase = "RESEARCH";
  block(state, "Research clarification limit reached. Questions remain.");
  await engine.store.save(state);
  await editConfig(cwd, (value) => {
    value.workflow.maxResearchClarifications = 10;
  });
  const plan = await getWorkflowRecoveryPlan(state, cwd);
  assert.equal(plan.kind, "continue", plan.reason);
  assert.equal(plan.kind === "continue" && plan.nextPhase, "WAITING_USER");
  await engine.continueBlocked(state);
  assert.equal(state.phase, "WAITING_USER");
  assert.deepEqual(state.pendingResearchQuestions, [
    "Which outcome is required?",
  ]);
  assert.equal(state.researchClarificationCount, 6);
});

test("raised pentest cycle limit permits the next pentest pass", async () => {
  const { cwd, state, engine, runner } = await completed(false, true);
  state.pentestCycle = 2;
  for (const role of ["pentester", "securityReviewer", "tester", "reporter"])
    delete state.results[role];
  state.history.push({
    at: new Date().toISOString(),
    phase: "PENTEST",
    event: "FIX_LOCAL",
    detail: "prior fix completed",
  });
  state.phase = "PENTEST";
  block(state, "Pentest cycle limit reached");
  await engine.store.save(state);
  await editConfig(cwd, (value) => {
    value.workflow.maxPentestCycles = 3;
  });
  const plan = await getWorkflowRecoveryPlan(state, cwd);
  assert.equal(plan.kind, "continue", plan.reason);
  assert.equal(plan.kind === "continue" && plan.nextPhase, "PENTEST");
  await engine.continueBlocked(state);
  assert.equal(state.phase, "DONE", state.blocker);
  assert.equal(state.pentestCycle, 3);
  assert.equal(runner.counts.pentester, 2);
});

test("raised agent failure limit recommends retry for an incomplete read-only agent", async () => {
  const { cwd, state, engine } = await completed();
  for (const role of [
    "researcher",
    "solver1",
    "solver2",
    "solver3",
    "critic",
    "reviewer",
    "implementor",
    "codeReviewer",
    "tester",
    "reporter",
  ])
    delete state.results[role];
  state.agentFailures = 2;
  state.phase = "RESEARCH";
  block(state, "Agent failure limit reached");
  await engine.store.save(state);
  await editConfig(cwd, (value) => {
    value.workflow.maxAgentFailures = 3;
  });
  const plan = await getWorkflowRecoveryPlan(state, cwd);
  assert.equal(plan.kind, "retry-agent", plan.reason);
  assert.equal(plan.kind === "retry-agent" && plan.agentId, "researcher");
  assert.equal(state.agentFailures, 2);
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
    value.workflow.maxResearchClarifications = 10;
  });
  const plan = await getWorkflowRecoveryPlan(state, cwd);
  assert.equal(plan.kind, "continue");
  assert.match(renderBlocked(state, plan), /Next action\n\/team-continue/);
  await engine.continueBlocked(state);
  assert.equal(state.phase, "DONE", state.blocker);
  assert.equal(runner.counts.codeReviewer, 2);
  assert.equal(state.config.workflow.maxAgentFailures, 3);
  assert.equal(state.config.workflow.maxToolCalls, 9999);
  assert.equal(state.config.workflow.maxResearchClarifications, 10);
  assert.match(
    state.history.find((event) => event.event === "config_drift_accepted")
      ?.detail ?? "",
    /workflow.maxToolCalls/,
  );
  assert.match(
    state.history.find((event) => event.event === "config_drift_accepted")
      ?.detail ?? "",
    /workflow.maxResearchClarifications/,
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
  assert.equal(plan.kind, "interrupted-mutation");
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

async function interruptedAssessmentFixture(
  agent: "pentester" | "tester",
  testerWrites = false,
) {
  const phase = agent === "pentester" ? "PENTEST" : "TEST";
  const fixture = await blockedAt(
    phase,
    agent === "pentester"
      ? ["pentester", "securityReviewer", "tester", "commitAgent", "reporter"]
      : ["tester", "commitAgent", "reporter"],
    false,
    testerWrites,
  );
  fixture.state.phase = phase;
  if (agent === "pentester")
    fixture.state.config.qualityGates.pentest.enabled = true;
  record(fixture.state, "agent_attempt_started", `${agent} run 1 started`, {
    agent,
    attempt: 1,
  });
  block(
    fixture.state,
    `Interrupted ${phase}; inspect repository effects before recovery. Automatic replay of mutating work is disabled.`,
  );
  await fixture.engine.store.save(fixture.state);
  return fixture;
}

test("interrupted gate lifecycle rejects contradictory or terminal evidence", async () => {
  const { state } = await interruptedAssessmentFixture("pentester");
  assert.equal(interruptedQualityGate(state, "pentester"), 1);
  assert.equal(interruptedQualityGate(state, "tester"), undefined);
  for (const event of [
    "agent_attempt_completed",
    "agent_attempt_failed",
  ] as const) {
    const copy = structuredClone(state);
    record(copy, event, "terminal", { agent: "pentester", attempt: 1 });
    assert.equal(interruptedQualityGate(copy, "pentester"), undefined);
  }
  const duplicate = structuredClone(state);
  record(duplicate, "agent_attempt_started", "duplicate", {
    agent: "pentester",
    attempt: 1,
  });
  assert.equal(interruptedQualityGate(duplicate, "pentester"), undefined);
  const missing = structuredClone(state);
  missing.history = missing.history.filter(
    (e) => e.meta?.agent !== "pentester",
  );
  assert.equal(interruptedQualityGate(missing, "pentester"), undefined);
  const wrong = structuredClone(state);
  wrong.manualRetry = { agent: "tester", phase: "TEST" };
  assert.equal(interruptedQualityGate(wrong, "pentester"), undefined);
});

for (const agent of ["pentester", "tester"] as const)
  test(`${agent} interrupted command brackets preserve changes and require fresh Code Review`, async () => {
    const { cwd, state, engine } = await interruptedAssessmentFixture(
      agent,
      agent === "tester",
    );
    const { repositorySnapshot, compareRepositorySnapshots } =
      await import("../src/workflow/git.ts");
    const { assessInterruptedGate } =
      await import("../src/workflow/interrupted-gate-assessment.ts");
    const target = agent === "tester" ? "tests/math.test.mjs" : "math.js";
    if (agent === "tester") {
      state.results.reviewer!.filesToModify.push(target);
      state.gateHashes = await (
        await import("../src/workflow/git.ts")
      ).gateSnapshot(state);
    }
    const before = state.gateRepositorySnapshot!;
    const content = await readFile(join(cwd, target), "utf8");
    await writeFile(
      join(cwd, target),
      content + "\n// observed command change\n",
    );
    const after = await repositorySnapshot(cwd);
    const drift = compareRepositorySnapshots(before, after);
    state.commandMutationEvidence.push({
      executionId: "00000000-0000-4000-8000-000000000099",
      commandId: "fixture",
      executable: "fixture",
      args: [],
      purpose: agent === "tester" ? "test" : "pentest",
      agent,
      phase: agent === "tester" ? "TEST" : "PENTEST",
      attempt: 1,
      risk: "SOURCE_MUTATION",
      beforeSnapshotId: before.id,
      afterSnapshotId: after.id,
      addedPaths: drift.added,
      modifiedPaths: drift.modified,
      deletedPaths: drift.deleted,
      attribution: "OBSERVED",
      observedAt: new Date().toISOString(),
    });
    const assessment = await assessInterruptedGate(state, agent, 1);
    assert.equal(
      assessment.status,
      "ATTRIBUTABLE_TO_INTERRUPTED_ATTEMPT",
      assessment.reason,
    );
    assert.equal(assessment.processStatus, "UNKNOWN");
    const ambiguous = structuredClone(state);
    ambiguous.commandMutationEvidence.push({
      ...state.commandMutationEvidence.at(-1)!,
      executionId: "00000000-0000-4000-8000-000000000098",
    });
    assert.equal(
      (await assessInterruptedGate(ambiguous, agent, 1)).eligible,
      false,
    );
    await engine.store.save(state);
    let prompt = "";
    const recovered = new WorkflowEngine(cwd, new FixtureRunner(), {
      ...ui,
      approve: async (request) => {
        prompt = request.prompt;
        return ["recover"];
      },
    });
    await recovered.retryAgent(state, agent, false, "recover");
    assert.match(prompt, /Previous subprocess termination cannot be proven/);
    assert.equal(state.phase, "CODE_REVIEW");
    assert.equal(
      await readFile(join(cwd, target), "utf8"),
      content + "\n// observed command change\n",
    );
    assert.equal(state.results.codeReviewer, undefined);
    assert.ok(state.results.implementor);
    const restarted = new WorkflowEngine(cwd, new FixtureRunner(), ui);
    await restarted.run(state);
    assert.equal(state.phase, "DONE", state.blocker);
    assert.ok(state.results.securityReviewer);
    assert.equal(
      state.history.filter(
        (e) =>
          e.event === "agent_attempt_started" &&
          e.meta?.agent === agent &&
          e.meta.attempt === 2,
      ).length,
      1,
    );
  });

for (const mutation of [
  "untracked",
  "tracked",
  "deleted",
  "protected",
  "head",
  "missing_snapshot",
  "missing_hashes",
] as const)
  test(`interrupted recovery assessment blocks ${mutation} without changing content`, async () => {
    const { cwd, state } = await interruptedAssessmentFixture("tester");
    const { assessInterruptedGate } =
      await import("../src/workflow/interrupted-gate-assessment.ts");
    const { unlink } = await import("node:fs/promises");
    if (mutation === "untracked")
      await writeFile(join(cwd, "external.txt"), "external");
    if (mutation === "tracked")
      await writeFile(join(cwd, "math.js"), "// external\n");
    if (mutation === "deleted") await unlink(join(cwd, "math.js"));
    if (mutation === "protected")
      await writeFile(join(cwd, "package.json"), "{}");
    if (mutation === "head")
      await git(cwd, ["commit", "--allow-empty", "-m", "external commit"]);
    if (mutation === "missing_snapshot") delete state.gateRepositorySnapshot;
    if (mutation === "missing_hashes") delete state.gateHashes;
    const before = JSON.stringify(state);
    const assessment = await assessInterruptedGate(state, "tester", 1);
    assert.equal(assessment.eligible, false, assessment.reason);
    const plan = await getWorkflowRecoveryPlan(state, cwd);
    assert.equal(plan.kind, "unsafe");
    assert.ok(!plan.actions.some((a) => a.command?.includes(" recover")));
    assert.equal(JSON.stringify(state), before);
  });

test("recovery rejects persisted-state changes during approval and wrong workflow", async () => {
  const { cwd, state, engine } = await interruptedAssessmentFixture("tester");
  const wrong = structuredClone(state);
  wrong.id = "00000000-0000-4000-8000-000000000077";
  await assert.rejects(
    engine.retryAgent(wrong, "tester", false, "recover"),
    /Workflow mismatch/,
  );
  const retry = new WorkflowEngine(cwd, new FixtureRunner(), {
    ...ui,
    approve: async () => {
      const changed = await engine.store.load(state.id);
      record(changed, "external_review_event", "state changed during approval");
      await engine.store.save(changed);
      return ["recover"];
    },
  });
  await assert.rejects(
    retry.retryAgent(state, "tester", false, "recover"),
    /conditions changed during review/,
  );
  const durable = await retry.store.load(state.id);
  assert.equal(durable.phase, "BLOCKED");
  assert.ok(
    !durable.history.some(
      (e) => e.event === "interrupted_agent_recovery_accepted",
    ),
  );
});

for (const crashAfterSave of [false, true])
  test(`recovery persistence failure ${crashAfterSave ? "after" : "before"} durable acceptance preserves retry boundary`, async () => {
    const { cwd, state } = await interruptedAssessmentFixture("tester");
    const retry = new WorkflowEngine(cwd, new FixtureRunner(), {
      ...ui,
      approve: async () => ["recover"],
    });
    const save = retry.store.save.bind(retry.store);
    retry.store.save = async (candidate) => {
      if (
        candidate.history.some(
          (e) => e.event === "interrupted_agent_recovery_accepted",
        )
      ) {
        if (crashAfterSave) await save(candidate);
        throw new Error("simulated recovery persistence crash");
      }
      await save(candidate);
    };
    await assert.rejects(
      retry.retryAgent(state, "tester", false, "recover"),
      /simulated recovery persistence crash/,
    );
    const restarted = new WorkflowEngine(cwd, new FixtureRunner(), ui);
    const durable = await restarted.store.load(state.id);
    assert.equal(
      durable.history.filter(
        (e) => e.event === "interrupted_agent_recovery_accepted",
      ).length,
      crashAfterSave ? 1 : 0,
    );
    assert.equal(
      durable.history.filter(
        (e) =>
          e.event === "agent_attempt_started" &&
          e.meta?.agent === "tester" &&
          e.meta.attempt === 2,
      ).length,
      0,
    );
    if (crashAfterSave) {
      await restarted.continueBlocked(durable);
      assert.equal(durable.phase, "DONE", durable.blocker);
      assert.equal(
        durable.history.filter(
          (e) =>
            e.event === "agent_attempt_started" &&
            e.meta?.agent === "tester" &&
            e.meta.attempt === 2,
        ).length,
        1,
      );
    } else {
      assert.equal(durable.phase, "BLOCKED");
      assert.equal(durable.manualRetry, undefined);
      assert.equal(
        (await getWorkflowRecoveryPlan(durable, cwd)).kind,
        "interrupted-quality-gate",
      );
    }
  });

test("ordinary retry racing crash recovery cannot prepare duplicate work", async () => {
  const { cwd, state } = await interruptedAssessmentFixture("tester");
  const recovery = new WorkflowEngine(cwd, new FixtureRunner(), {
    ...ui,
    approve: async () => ["recover"],
  });
  const ordinary = new WorkflowEngine(cwd, new FixtureRunner(), ui);
  const requests = await Promise.allSettled([
    recovery.retryAgent(structuredClone(state), "tester", false, "recover"),
    ordinary.retryAgent(structuredClone(state), "tester"),
  ]);
  const loaded = await recovery.store.load(state.id);
  assert.ok(requests.some((r) => r.status === "rejected"));
  const accepted = loaded.history.filter(
    (e) => e.event === "interrupted_agent_recovery_accepted",
  );
  assert.ok(accepted.length <= 1);
  if (accepted.length) {
    const restarted = new WorkflowEngine(cwd, new FixtureRunner(), ui);
    await restarted.run(loaded);
    assert.equal(
      loaded.history.filter(
        (e) =>
          e.event === "agent_attempt_started" &&
          e.meta?.agent === "tester" &&
          e.meta.attempt === 2,
      ).length,
      1,
    );
  } else assert.equal(loaded.phase, "BLOCKED");
});

test("unchanged interrupted snapshot preserves approved changes on an already dirty baseline", async () => {
  const { cwd, state, engine } = await interruptedAssessmentFixture("tester");
  const { assessInterruptedGate } =
    await import("../src/workflow/interrupted-gate-assessment.ts");
  state.baseline.dirtyPaths.push("math.js");
  const before = await readFile(join(cwd, "math.js"), "utf8");
  await engine.store.save(state);
  const assessment = await assessInterruptedGate(state, "tester", 1);
  assert.equal(assessment.status, "UNCHANGED");
  const restarted = new WorkflowEngine(cwd, new FixtureRunner(), {
    ...ui,
    approve: async () => ["recover"],
  });
  await restarted.retryAgent(state, "tester", false, "recover");
  await restarted.run(state);
  assert.equal(await readFile(join(cwd, "math.js"), "utf8"), before);
  assert.ok(state.results.implementor);
});

for (const boundary of [
  "RESERVED",
  "STARTING",
  "ATTEMPT_STARTED",
  "RUNNING",
  "EXIT_UNPERSISTED",
  "COMPLETED_AFTER",
] as const)
  test(
    `execution identity crash boundary: ${boundary}`,
    { skip: process.platform !== "linux" },
    async () => {
      const { cwd, state } = await interruptedAssessmentFixture("tester");
      let calls = 0;
      const { executionContext } =
        await import("../src/workflow/execution-identity.ts");
      const runner = new FixtureRunner(async (role) => {
        if (role === "tester") {
          calls++;
          await executionContext.getStore()?.update((e) => {
            e.status = "RUNNING";
          });
        }
        return undefined;
      });
      const engine = new WorkflowEngine(cwd, runner, {
        ...ui,
        approve: async () => ["recover"],
      });
      await engine.retryAgent(state, "tester", false, "recover");
      const save = engine.store.save.bind(engine.store);
      let failed = false;
      engine.store.save = async (candidate) => {
        const execution = candidate.executions.find(
          (e) => e.agent === "tester" && e.attempt === 2,
        );
        const start = candidate.history.some(
          (h) =>
            h.event === "agent_attempt_started" &&
            h.meta?.agent === "tester" &&
            h.meta.attempt === 2,
        );
        const terminal = candidate.history.some(
          (h) =>
            h.event === "agent_attempt_completed" &&
            h.meta?.agent === "tester" &&
            h.meta.attempt === 2,
        );
        const hit =
          execution &&
          (boundary === "ATTEMPT_STARTED"
            ? start
            : boundary === "EXIT_UNPERSISTED" || boundary === "COMPLETED_AFTER"
              ? terminal
              : execution.status === boundary);
        if (hit && !failed) {
          failed = true;
          if (boundary !== "EXIT_UNPERSISTED") await save(candidate);
          throw new Error("simulated execution crash");
        }
        await save(candidate);
      };
      await engine.run(state).catch(() => {});
      assert.equal(failed, true);
      const restarted = new WorkflowEngine(cwd, new FixtureRunner(), ui);
      const durable = await restarted.store.load(state.id);
      const execution = durable.executions.find(
        (e) => e.agent === "tester" && e.attempt === 2,
      )!;
      assert.ok(execution?.id);
      assert.equal(
        durable.history.some(
          (h) =>
            h.event === "agent_attempt_completed" &&
            h.meta?.agent === "tester" &&
            h.meta.attempt === 2,
        ),
        boundary === "COMPLETED_AFTER",
      );
      assert.equal(
        calls,
        ["RUNNING", "EXIT_UNPERSISTED", "COMPLETED_AFTER"].includes(boundary)
          ? 1
          : 0,
      );
      assert.equal(
        durable.history.filter(
          (h) =>
            h.event === "agent_attempt_started" &&
            h.meta?.agent === "tester" &&
            h.meta.attempt === 2,
        ).length,
        ["RESERVED", "STARTING"].includes(boundary) ? 0 : 1,
      );
      await restarted.recover(durable);
      const rejected = await getWorkflowRecoveryPlan(durable, cwd);
      assert.notEqual(rejected.kind, "continue");
      await assert.rejects(
        restarted.retryAgent(durable, "tester", false, "recover"),
      );
      assert.equal(durable.executions.filter((e) => e.attempt === 2).length, 1);
      if (boundary !== "COMPLETED_AFTER") {
        // Controlled stand-in for a host crash: the original owner is now provably absent.
        durable.executions.find(
          (e) => e.agent === "tester" && e.attempt === 2,
        )!.owner = { ...execution.owner!, pid: 2147483647 };
        await restarted.store.save(durable);
        const next = new WorkflowEngine(cwd, new FixtureRunner(), {
          ...ui,
          approve: async () => ["recover"],
        });
        const fresh = await next.store.load(state.id);
        await next.retryAgent(fresh, "tester", false, "recover");
        await next.run(fresh);
        assert.equal(fresh.phase, "DONE", fresh.blocker);
        assert.equal(
          fresh.history.filter(
            (h) =>
              h.event === "agent_attempt_started" &&
              h.meta?.agent === "tester" &&
              h.meta.attempt === 3,
          ).length,
          1,
        );
        assert.notEqual(
          fresh.executions.find((e) => e.attempt === 3)!.id,
          execution.id,
        );
      }
    },
  );

test("two independent processes cannot start the same prepared retry", async () => {
  const { cwd, state, engine } = await interruptedAssessmentFixture("tester");
  const prepare = new WorkflowEngine(cwd, new FixtureRunner(), {
    ...ui,
    approve: async () => ["recover"],
  });
  await prepare.retryAgent(state, "tester", false, "recover");
  const { promisify } = await import("node:util");
  const { execFile } = await import("node:child_process");
  const code = `import {WorkflowEngine} from ${JSON.stringify(new URL("../src/workflow/engine.ts", import.meta.url).href)};import {FixtureRunner} from ${JSON.stringify(new URL("./helpers.ts", import.meta.url).href)};const engine=new WorkflowEngine(${JSON.stringify(cwd)},new FixtureRunner(),{progress(){},ask:async()=>undefined});try {await engine.run(await engine.store.load(${JSON.stringify(state.id)}));}catch(error){if(!String(error).includes("already running"))throw error;}`;
  await Promise.all(
    [1, 2].map(() =>
      promisify(execFile)(process.execPath, [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        code,
      ]),
    ),
  );
  const final = await engine.store.load(state.id);
  assert.equal(final.phase, "DONE", final.blocker);
  assert.equal(
    final.executions.filter((e) => e.agent === "tester" && e.attempt === 2)
      .length,
    1,
  );
  assert.equal(
    final.history.filter(
      (h) =>
        h.event === "agent_attempt_started" &&
        h.meta?.agent === "tester" &&
        h.meta.attempt === 2,
    ).length,
    1,
  );
});

test(
  "unknown recorded child startup blocks recovery without asking for approval",
  { skip: process.platform !== "linux" },
  async () => {
    const { cwd, state, engine } = await interruptedAssessmentFixture("tester");
    const { captureProcessIdentity } =
      await import("../src/workflow/execution-identity.ts");
    state.executions.push({
      id: "00000000-0000-4000-8000-000000000061",
      workflowId: state.id,
      agent: "tester",
      attempt: 1,
      status: "STARTING",
      owner: { ...(await captureProcessIdentity()), pid: 2147483647 },
      children: [
        { id: "00000000-0000-4000-8000-000000000062", status: "STARTING" },
      ],
    });
    await engine.store.save(state);
    let approvals = 0;
    const retry = new WorkflowEngine(cwd, new FixtureRunner(), {
      ...ui,
      approve: async () => {
        approvals++;
        return ["recover"];
      },
    });
    await assert.rejects(
      retry.retryAgent(state, "tester", false, "recover"),
      /UNKNOWN/,
    );
    assert.equal(approvals, 0);
    assert.equal((await retry.store.load(state.id)).phase, "BLOCKED");
  },
);

test("concurrent identity callbacks retain cumulative metadata and terminal identity", async () => {
  const { cwd, state } = await interruptedAssessmentFixture("tester");
  const { executionContext } =
    await import("../src/workflow/execution-identity.ts");
  const runner = new FixtureRunner(async (role) => {
    if (role === "tester") {
      const context = executionContext.getStore()!;
      await Promise.all([
        context.update((e) => {
          e.sessionId = "controlled-sdk-session";
        }),
        context.update((e) => {
          e.children.push({
            id: "00000000-0000-4000-8000-000000000063",
            status: "RESERVED",
          });
        }),
      ]);
    }
    return undefined;
  });
  const engine = new WorkflowEngine(cwd, runner, {
    ...ui,
    approve: async () => ["recover"],
  });
  await engine.retryAgent(state, "tester", false, "recover");
  await engine.run(state);
  const durable = await engine.store.load(state.id);
  const execution = durable.executions.find(
    (e) => e.agent === "tester" && e.attempt === 2,
  )!;
  assert.equal(execution.sessionId, "controlled-sdk-session");
  assert.equal(execution.children.length, 2);
  assert.equal(
    execution.children.filter(
      (child) =>
        child.id === "00000000-0000-4000-8000-000000000063" &&
        child.status === "RESERVED",
    ).length,
    1,
  );
  assert.equal(
    execution.children.filter(
      (child) =>
        child.id !== "00000000-0000-4000-8000-000000000063" &&
        child.status === "TERMINATED" &&
        child.exitCode === 0,
    ).length,
    1,
  );
  assert.equal(new Set(execution.children.map((child) => child.id)).size, 2);
  assert.equal(execution.status, "COMPLETED");
  assert.equal(durable.phase, "DONE", durable.blocker);
});

test("lock ownership lost during SDK execution stops identity writes and preserves state", async () => {
  const { cwd, state } = await interruptedAssessmentFixture("tester");
  const { executionContext } =
    await import("../src/workflow/execution-identity.ts");
  const { unlink } = await import("node:fs/promises");
  let runnerEntered = false;
  const runner = new FixtureRunner(async (role) => {
    if (role === "tester") {
      runnerEntered = true;
      await writeFile(
        join(engine.store.dir, "active.lock"),
        JSON.stringify({
          pid: process.pid,
          token: "replacement-owner",
          at: new Date().toISOString(),
        }),
      );
      await executionContext.getStore()!.update((e) => {
        e.sessionId = "must-not-publish";
      });
    }
    return undefined;
  });
  const engine = new WorkflowEngine(cwd, runner, {
    ...ui,
    approve: async () => ["recover"],
  });
  await engine.retryAgent(state, "tester", false, "recover");
  await assert.rejects(engine.run(state), /lock ownership changed/);
  assert.equal(runnerEntered, true);
  const loaded = await engine.store.load(state.id);
  assert.equal(
    loaded.executions.find((e) => e.agent === "tester" && e.attempt === 2)
      ?.sessionId,
    undefined,
  );
  const path = join(engine.store.dir, "active.lock");
  assert.equal(
    JSON.parse(await readFile(path, "utf8")).token,
    "replacement-owner",
  );
  await unlink(path);
});

test(
  "verified active execution cannot be overridden by recovery approval",
  { skip: process.platform !== "linux" },
  async () => {
    const { cwd, state, engine } = await interruptedAssessmentFixture("tester");
    const { captureProcessIdentity } =
      await import("../src/workflow/execution-identity.ts");
    state.executions.push({
      id: "00000000-0000-4000-8000-000000000064",
      workflowId: state.id,
      agent: "tester",
      attempt: 1,
      status: "RUNNING",
      owner: await captureProcessIdentity(),
      children: [],
    });
    await engine.store.save(state);
    let approvals = 0;
    const retry = new WorkflowEngine(cwd, new FixtureRunner(), {
      ...ui,
      approve: async () => {
        approvals++;
        return ["recover"];
      },
    });
    await assert.rejects(
      retry.retryAgent(state, "tester", false, "recover"),
      /ACTIVE/,
    );
    assert.equal(approvals, 0);
    const durable = await retry.store.load(state.id);
    assert.equal(durable.executions.length, 1);
    assert.equal(durable.phase, "BLOCKED");
    assert.ok(
      !durable.history.some(
        (h) => h.event === "interrupted_agent_recovery_accepted",
      ),
    );
  },
);
