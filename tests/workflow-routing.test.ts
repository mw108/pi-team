import { test } from "node:test";
import assert from "node:assert/strict";
import { newState } from "../src/workflow/state.ts";
import { transition } from "../src/workflow/router.ts";
import { config, finding } from "./helpers.ts";
import { repository, FixtureRunner } from "./helpers.ts";
import { WorkflowEngine } from "../src/workflow/engine.ts";
import { baseline, prepareCommit, git } from "../src/workflow/git.ts";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { contract, output } from "./helpers.ts";
import {
  FileMutationTracker,
  type MutationObserver,
} from "../src/agents/mutation-attribution.ts";
async function successfulMutation(
  cwd: string,
  observer: MutationObserver | undefined,
  path: string,
  tool = "edit",
) {
  if (!observer) throw new Error("Missing mutation observer");
  const tracker = new FileMutationTracker(cwd, observer);
  tracker.start("fixture-call", tool, { path });
  await tracker.end("fixture-call", false);
}
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
test("FIX_DESIGN leaves old implementation paths that fail a narrowed commit", async () => {
  const cwd = await repository();
  await writeFile(join(cwd, "old.js"), "old implementation\n");
  await git(cwd, ["add", "old.js"]);
  await git(cwd, [
    "-c",
    "core.hooksPath=/dev/null",
    "commit",
    "-m",
    "old baseline",
  ]);
  const s = newState(cwd, "task", config(), await baseline(cwd));
  s.phase = "IMPLEMENT";
  s.results.reviewer = { ...contract, filesToModify: ["math.js", "old.js"] };
  await writeFile(join(cwd, "math.js"), "new math\n");
  await writeFile(join(cwd, "old.js"), "new old implementation\n");
  s.results.implementor = {
    status: "IMPLEMENTATION_BLOCKED",
    reason: "redesign",
    suggestedRoute: "FIX_DESIGN",
  };
  transition(s);
  assert.equal(s.phase, "RESEARCH");
  s.results.reviewer = contract;
  s.results.codeReviewer = output("codeReviewer");
  s.results.securityReviewer = output("securityReviewer");
  s.results.tester = output("tester");
  await assert.rejects(
    () => prepareCommit(s, ["math.js"], "fix"),
    /unexpected generated files/,
  );
});
for (const choice of ["keep", "discard", "abort"] as const)
  test(`FIX_DESIGN orphan decision ${choice} preserves exact ownership`, async () => {
    const cwd = await repository();
    await writeFile(join(cwd, "old.js"), "old baseline\n");
    await git(cwd, ["add", "old.js"]);
    await git(cwd, [
      "-c",
      "core.hooksPath=/dev/null",
      "commit",
      "-m",
      "old baseline",
    ]);
    const cfg = config();
    cfg.qualityGates.commit.enabled = false;
    let reviews = 0;
    let implementations = 0;
    const runner = new FixtureRunner(async (role, _state, _count, observer) => {
      if (role === "reviewer") {
        reviews++;
        return reviews === 1
          ? { ...contract, filesToModify: ["math.js", "old.js"] }
          : contract;
      }
      if (role === "implementor") {
        implementations++;
        await writeFile(
          join(cwd, "math.js"),
          "export const add = (a,b) => a+b;\n",
        );
        if (implementations === 1) {
          await writeFile(join(cwd, "old.js"), "old workflow edit\n");
          await successfulMutation(cwd, observer, "old.js");
          return {
            status: "IMPLEMENTATION_BLOCKED",
            reason: "redesign",
            suggestedRoute: "FIX_DESIGN",
            evidence: ["Old implementation no longer fits"],
          };
        }
        return output(role);
      }
    });
    const engine = new WorkflowEngine(cwd, runner, {
      progress: () => {},
      ask: async () => undefined,
      approve: async (request) =>
        request.kind === "orphanedImplementation" ? [choice] : undefined,
    });
    const state = await engine.start("Fix", cfg);
    await engine.run(state);
    assert.ok(
      state.history.some(
        (event) => event.event === "orphaned_implementation_detected",
      ),
      `${state.phase}: ${state.blocker}: ${JSON.stringify(state.history.slice(-5))}`,
    );
    if (choice === "discard") {
      assert.equal(state.phase, "DONE", state.blocker);
      assert.equal(
        await readFile(join(cwd, "old.js"), "utf8"),
        "old baseline\n",
      );
      assert.equal(implementations, 2);
    } else {
      assert.equal(state.phase, "BLOCKED");
      assert.equal(
        await readFile(join(cwd, "old.js"), "utf8"),
        "old workflow edit\n",
      );
    }
  });
test("FIX_DESIGN discards only a workflow-created orphan", async () => {
  const cwd = await repository();
  const cfg = config();
  cfg.qualityGates.commit.enabled = false;
  let reviews = 0;
  let implementations = 0;
  const runner = new FixtureRunner(async (role, _state, _count, observer) => {
    if (role === "reviewer") {
      reviews++;
      return reviews === 1
        ? { ...contract, filesToCreate: ["new-old.js"] }
        : contract;
    }
    if (role === "implementor") {
      implementations++;
      await writeFile(
        join(cwd, "math.js"),
        "export const add = (a,b) => a+b;\n",
      );
      if (implementations === 1) {
        await writeFile(join(cwd, "new-old.js"), "workflow file\n");
        await successfulMutation(cwd, observer, "new-old.js", "write");
        return {
          status: "IMPLEMENTATION_BLOCKED",
          reason: "redesign",
          suggestedRoute: "FIX_DESIGN",
          evidence: ["obsolete file"],
        };
      }
      return output(role);
    }
  });
  const engine = new WorkflowEngine(cwd, runner, {
    progress: () => {},
    ask: async () => undefined,
    approve: async (request) =>
      request.kind === "orphanedImplementation" ? ["discard"] : undefined,
  });
  const state = await engine.start("Fix", cfg);
  await engine.run(state);
  assert.equal(state.phase, "DONE", state.blocker);
  await assert.rejects(() => readFile(join(cwd, "new-old.js"), "utf8"));
  assert.match(await readFile(join(cwd, "math.js"), "utf8"), /a\+b/);
});
test("pre-existing dirty files are never orphan discard candidates", async () => {
  const cwd = await repository();
  await writeFile(join(cwd, "old.js"), "old baseline\n");
  await git(cwd, ["add", "old.js"]);
  await git(cwd, [
    "-c",
    "core.hooksPath=/dev/null",
    "commit",
    "-m",
    "old baseline",
  ]);
  await writeFile(join(cwd, "old.js"), "user edit\n");
  const cfg = config();
  cfg.qualityGates.commit.enabled = false;
  let reviews = 0;
  let implementations = 0;
  const runner = new FixtureRunner(async (role, _state, _count, observer) => {
    if (role === "reviewer") {
      reviews++;
      return reviews === 1
        ? { ...contract, filesToModify: ["math.js", "old.js"] }
        : contract;
    }
    if (role === "implementor") {
      implementations++;
      await writeFile(
        join(cwd, "math.js"),
        "export const add = (a,b) => a+b;\n",
      );
      if (implementations === 1) {
        await writeFile(join(cwd, "old.js"), "user edit\nworkflow edit\n");
        await successfulMutation(cwd, observer, "old.js");
        return {
          status: "IMPLEMENTATION_BLOCKED",
          reason: "redesign",
          suggestedRoute: "FIX_DESIGN",
          evidence: ["old path"],
        };
      }
      return output(role);
    }
  });
  const engine = new WorkflowEngine(cwd, runner, {
    progress: () => {},
    ask: async () => undefined,
    approve: async (request) =>
      request.kind === "dirtyPaths"
        ? ["old.js"]
        : request.kind === "orphanedImplementation"
          ? ["discard"]
          : undefined,
  });
  const state = await engine.start("Fix", cfg);
  await engine.run(state);
  assert.equal(state.phase, "BLOCKED", state.blocker);
  assert.match(state.blocker ?? "", /Ambiguous orphaned changes/);
  assert.equal(
    await readFile(join(cwd, "old.js"), "utf8"),
    "user edit\nworkflow edit\n",
  );
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
