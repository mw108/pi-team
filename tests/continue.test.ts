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
async function completed(commit = false, pentest = false) {
  const cwd = await repository();
  const cfg = config();
  cfg.qualityGates.commit.enabled = commit;
  cfg.qualityGates.pentest.enabled = pentest;
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
