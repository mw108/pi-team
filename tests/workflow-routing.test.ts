import { test } from "node:test";
import assert from "node:assert/strict";
import { newState } from "../src/workflow/state.ts";
import { transition } from "../src/workflow/router.ts";
import { config, finding } from "./helpers.ts";
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
  assert.equal(s.phase, "TEST");
  s.config.qualityGates.pentest.enabled = true;
  s.phase = "CODE_REVIEW";
  transition(s);
  assert.equal(s.phase, "PENTEST");
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
  s.phase = "SECURITY_REVIEW";
  s.results.pentester = { findings: [{ id: "F1" }] };
  s.results.securityReviewer = { findings: [] };
  transition(s);
  assert.equal(s.phase, "BLOCKED");
  const t = state();
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
