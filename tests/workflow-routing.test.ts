import { test } from "node:test";
import assert from "node:assert/strict";
import { newState } from "../src/workflow/state.ts";
import { transition } from "../src/workflow/router.ts";
import { config, finding } from "./helpers.ts";
import { repository, FixtureRunner } from "./helpers.ts";
import { WorkflowEngine } from "../src/workflow/engine.ts";
import { baseline, prepareCommit } from "../src/workflow/git.ts";
function state() {
  return newState("/tmp/test", "task", config(), {
    head: null,
    dirtyPaths: [],
    status: "",
    diff: "",
    cachedDiff: "",
  });
}
test("APPROVED advances through configured quality gates", () => {
  const s = state();
  s.phase = "CODE_REVIEW";
  s.results.codeReviewer = { status: "APPROVED", findings: [] };
  transition(s);
  assert.equal(s.phase, "SECURITY_REVIEW");
  s.results.securityReviewer = { findings: [], summary: "No findings" };
  transition(s);
  assert.equal(s.phase, "TEST");
  s.config.qualityGates.pentest.enabled = true;
  s.phase = "CODE_REVIEW";
  transition(s);
  assert.equal(s.phase, "PENTEST");
  s.results.pentester = {
    status: "PASS",
    findings: [],
    coverage: [],
    limitations: [],
  };
  transition(s);
  assert.equal(s.phase, "SECURITY_REVIEW");
});
test("FIX_LOCAL returns only to implementation and invalidates approval", () => {
  const s = state();
  s.phase = "CODE_REVIEW";
  s.results.codeReviewer = { status: "FIX_LOCAL", findings: [finding] };
  transition(s);
  assert.equal(s.phase, "IMPLEMENT");
  assert.equal(s.localFixCycle, 1);
  assert.equal(s.fullCycle, 1);
  assert.equal(s.results.codeReviewer, undefined);
  assert.ok(s.results.previous_codeReviewer);
});
test("FIX_DESIGN restarts research with previous findings", () => {
  const s = state();
  s.phase = "CODE_REVIEW";
  s.results.codeReviewer = { status: "FIX_DESIGN", findings: [finding] };
  s.results.solver1 = { old: true };
  transition(s);
  assert.equal(s.phase, "RESEARCH");
  assert.equal(s.fullCycle, 2);
  assert.equal(s.results.solver1, undefined);
  assert.ok(s.results.previous_codeReviewer);
});
test("FIX_REQUIREMENTS pauses for orchestrator", () => {
  const s = state();
  s.phase = "CODE_REVIEW";
  s.results.codeReviewer = {
    status: "FIX_REQUIREMENTS",
    findings: [],
    question: "Integers only?",
  };
  transition(s);
  assert.equal(s.phase, "WAITING_USER");
  assert.equal(s.resumePhase, "ORCHESTRATE");
  assert.equal(s.pendingQuestion?.question, "Integers only?");
});
for (const route of ["FIX_LOCAL", "FIX_DESIGN"] as const)
  test(`security ${route} routes correctly`, () => {
    const s = state();
    s.phase = "SECURITY_REVIEW";
    s.results.pentester = { findings: [{ id: "F1" }] };
    s.results.securityReviewer = {
      findings: [{ id: "F1", classification: "CONFIRMED", route }],
    };
    transition(s);
    assert.equal(s.phase, route === "FIX_LOCAL" ? "IMPLEMENT" : "RESEARCH");
  });
test("security reviewer cannot omit findings or accept risks autonomously", () => {
  const s = state();
  s.config.qualityGates.pentest.enabled = true;
  s.phase = "SECURITY_REVIEW";
  s.results.pentester = { findings: [{ id: "F1" }] };
  s.results.securityReviewer = { findings: [] };
  transition(s);
  assert.equal(s.phase, "BLOCKED");
  const t = state();
  t.config.qualityGates.pentest.enabled = true;
  t.phase = "SECURITY_REVIEW";
  t.results.pentester = { findings: [{ id: "F1" }] };
  t.results.securityReviewer = {
    findings: [{ id: "F1", classification: "ACCEPTED_RISK" }],
  };
  transition(t);
  assert.equal(t.phase, "BLOCKED");
});
test("failed tests never route to commit", () => {
  const s = state();
  s.phase = "TEST";
  s.results.tester = {
    status: "FAIL",
    commands: [{ exitCode: 1 }],
    classification: "FIX_LOCAL",
  };
  transition(s);
  assert.equal(s.phase, "IMPLEMENT");
  const t = state();
  t.phase = "TEST";
  t.results.tester = { status: "PASS", commands: [{ exitCode: 1 }] };
  transition(t);
  assert.notEqual(t.phase, "COMMIT");
});
test("full cycle and local fix limits are hard global counters", () => {
  for (const route of ["FIX_LOCAL", "FIX_DESIGN"] as const) {
    const s = state();
    s.phase = "CODE_REVIEW";
    s.fullCycle = 3;
    s.localFixCycle = 5;
    s.results.codeReviewer = { status: route, findings: [finding] };
    transition(s);
    assert.equal(s.phase, "BLOCKED");
  }
});

test("disabled Pentest still runs Security Reviewer before Tester", async () => {
  const cwd = await repository();
  const runner = new FixtureRunner();
  const cfg = config();
  cfg.qualityGates.pentest.enabled = false;
  cfg.qualityGates.commit.enabled = false;
  const engine = new WorkflowEngine(cwd, runner, {
    progress: () => {},
    ask: async () => undefined,
  });
  const result = await engine.start("Fix addition", cfg);
  await engine.run(result);
  assert.equal(result.phase, "DONE", result.blocker);
  const roles = runner.calls;
  assert.equal(roles.includes("pentester"), false);
  assert.ok(roles.indexOf("codeReviewer") < roles.indexOf("securityReviewer"));
  assert.ok(roles.indexOf("securityReviewer") < roles.indexOf("tester"));
});

test("commit security gate is independent of Pentest configuration", async () => {
  const cwd = await repository();
  const cfg = config();
  cfg.qualityGates.pentest.enabled = false;
  cfg.qualityGates.codeReview.enabled = false;
  cfg.qualityGates.testing.enabled = false;
  const s = newState(cwd, "Task", cfg, await baseline(cwd));
  await assert.rejects(() => prepareCommit(s, [], "test"), /Security gate/);
  s.results.securityReviewer = { findings: [], summary: "No findings" };
  s.results.reviewer = {
    goal: "Task",
    filesToModify: [],
    filesToCreate: [],
    filesToDelete: [],
    requiredChanges: [],
    technicalDecisions: [],
    constraints: [],
    requiredTests: [],
    acceptanceCriteria: [],
    knownRisks: [],
  };
  await assert.rejects(() => prepareCommit(s, [], "test"), /Commit files/);
});

test("in-progress legacy workflow past review returns to Security Review", async () => {
  const cwd = await repository();
  const cfg = config();
  cfg.qualityGates.commit.enabled = false;
  const runner = new FixtureRunner();
  const engine = new WorkflowEngine(cwd, runner, {
    progress: () => {},
    ask: async () => undefined,
  });
  const s = await engine.start("Legacy task", cfg);
  s.phase = "REPORT";
  await engine.run(s);
  assert.equal(runner.calls[0], "securityReviewer");
  assert.ok(
    s.history.some((event) => event.event === "security_review_migration"),
  );
});
