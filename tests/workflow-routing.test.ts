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
const pentestFinding = {
  id: "F1",
  title: "Fixture finding",
  severity: "low" as const,
  category: "test",
  affectedComponent: "math.js",
  reproductionSteps: [],
  evidence: "Fixture",
  impact: "Fixture",
  suggestedFix: "Fix",
};
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
function verifiedOutcome(
  id: string,
  validationType: "TEST" | "STATIC" | "BUILD" | "DIAGNOSTIC",
  outcome:
    | "PASS"
    | "TEST_FAILURE"
    | "STATIC_FORMAT_FAILURE"
    | "STATIC_ANALYSIS_FAILURE"
    | "BUILD_FAILURE"
    | "DIAGNOSTIC_FAILURE"
    | "TOOL_UNAVAILABLE"
    | "NOT_APPLICABLE"
    | "INVOCATION_ERROR"
    | "INFRASTRUCTURE_ERROR"
    | "INDETERMINATE",
  applicability: "REQUIRED" | "OPTIONAL" | "NOT_APPLICABLE" | "AMBIGUOUS",
) {
  return {
    id,
    validationType,
    validator:
      validationType === "TEST"
        ? ("PHPUNIT" as const)
        : validationType === "STATIC"
          ? ("PHPSTAN" as const)
          : validationType === "BUILD"
            ? ("VITE" as const)
            : ("PHP_DIAGNOSTIC" as const),
    validatorSource: "direct" as const,
    outcome,
    reason: `${outcome} fixture`,
    recoverable: [
      "TEST_FAILURE",
      "STATIC_FORMAT_FAILURE",
      "STATIC_ANALYSIS_FAILURE",
      "BUILD_FAILURE",
      "DIAGNOSTIC_FAILURE",
    ].includes(outcome),
    applicability,
  };
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
  s.results.solver1 = output("solver1");
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
    evidence: [],
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
    /Approval required for repository changes outside the Implementation Contract: old\.js \(modify\)/,
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
test("technical Implementor blocker offers a targeted retry without a full-cycle rewind", () => {
  const s = state();
  s.phase = "IMPLEMENT";
  s.results.reviewer = contract;
  s.results.implementor = {
    status: "IMPLEMENTATION_BLOCKED",
    reason: "The host rejected an authorized scaffold edit",
    evidence: ["modify app/Models/Client.php was denied"],
    blockerCategory: "CONTRACT_AUTHORIZATION_BLOCKED",
    suggestedRoute: "FIX_REQUIREMENTS",
  };
  const fullCycle = s.fullCycle;
  transition(s);
  assert.equal(s.phase, "WAITING_USER");
  assert.equal(s.pendingApproval?.kind, "technicalRecovery");
  assert.deepEqual(
    s.pendingApproval?.options.map((option) => option.value),
    ["retry_implementor", "revise_requirements", "abort"],
  );
  assert.equal(s.fullCycle, fullCycle);
  assert.ok(s.results.reviewer);
});
test("Retry Implementor recovery preserves upstream results and continues through quality gates", async () => {
  const cwd = await repository();
  const cfg = config();
  cfg.qualityGates.commit.enabled = false;
  const runner = new FixtureRunner(async (role, _state, count) => {
    if (role === "implementor" && count === 1)
      return {
        status: "IMPLEMENTATION_BLOCKED",
        reason: "A required Contract write was rejected by the host",
        evidence: ["modify app/Models/Client.php denied"],
        blockerCategory: "CONTRACT_AUTHORIZATION_BLOCKED",
        suggestedRoute: "FIX_REQUIREMENTS",
      };
    return undefined;
  });
  const engine = new WorkflowEngine(cwd, runner, {
    progress: () => {},
    ask: async () => undefined,
    approve: async (request) =>
      request.kind === "technicalRecovery"
        ? ["retry_implementor"]
        : request.options.map((option) => option.value),
  });
  const s = await engine.start("Fix addition", cfg);
  await engine.run(s);
  assert.equal(s.phase, "DONE", s.blocker);
  assert.equal(s.fullCycle, 1);
  assert.equal(s.localFixCycle, 0);
  assert.equal(runner.counts.orchestrator, 1);
  assert.equal(runner.counts.researcher, 1);
  assert.equal(runner.counts.reviewer, 1);
  assert.equal(runner.counts.implementor, 2);
  assert.ok(
    s.history.some(
      (event) => event.event === "technical_recovery_retry_implementor",
    ),
  );
});
for (const route of ["FIX_LOCAL", "FIX_DESIGN"] as const)
  test(`security ${route} routes correctly`, () => {
    const s = state();
    s.phase = "SECURITY_REVIEW";
    s.results.pentester = {
      ...output("pentester"),
      status: "FINDINGS",
      findings: [{ ...pentestFinding, id: "F1" }],
    };
    s.results.securityReviewer = {
      findings: [
        { id: "F1", classification: "CONFIRMED", route, evidence: "Fixture" },
      ],
      summary: "Fixture",
    };
    transition(s);
    assert.equal(s.phase, route === "FIX_LOCAL" ? "IMPLEMENT" : "RESEARCH");
  });
test("security reviewer cannot omit findings or accept risks autonomously", () => {
  const s = state();
  s.config.qualityGates.pentest.enabled = true;
  s.phase = "SECURITY_REVIEW";
  s.results.pentester = {
    ...output("pentester"),
    status: "FINDINGS",
    findings: [{ ...pentestFinding, id: "F1" }],
  };
  s.results.securityReviewer = { findings: [], summary: "Fixture" };
  transition(s);
  assert.equal(s.phase, "BLOCKED");
  const t = state();
  t.config.qualityGates.pentest.enabled = true;
  t.phase = "SECURITY_REVIEW";
  t.results.pentester = {
    ...output("pentester"),
    status: "FINDINGS",
    findings: [{ ...pentestFinding, id: "F1" }],
  };
  t.results.securityReviewer = {
    findings: [
      { id: "F1", classification: "ACCEPTED_RISK", evidence: "Fixture" },
    ],
    summary: "Fixture",
  };
  transition(t);
  assert.equal(t.phase, "WAITING_USER");
  assert.equal(t.securityRiskReview?.status, "pending");
});
test("failed tests never route to commit", () => {
  const s = state();
  s.phase = "TEST";
  s.results.tester = {
    status: "FAIL",
    commands: [{ id: "test", exitCode: 1, output: "failure" }],
    failedAreas: ["test"],
    classification: "FIX_LOCAL",
  };
  transition(s);
  assert.equal(s.phase, "IMPLEMENT");
  const t = state();
  t.phase = "TEST";
  t.results.tester = {
    status: "PASS",
    commands: [{ id: "test", exitCode: 1, output: "failure" }],
    failedAreas: [],
  };
  transition(t);
  assert.notEqual(t.phase, "COMMIT");
});
test("host-verified PASS advances with an auditable optional invocation error", () => {
  const s = state();
  s.phase = "TEST";
  s.results.tester = {
    status: "PASS",
    reason: "Host-verified required validation obligations passed.",
    commands: [
      { id: "composer-test", exitCode: 0, output: "PASS" },
      { id: "laravel-test", exitCode: 0, output: "73 tests passed" },
      { id: "pint", exitCode: 0, output: "PASS" },
      {
        id: "detected-8ed057d5f441",
        exitCode: 0,
        output: "OK (73 tests, 415 assertions)",
      },
      { id: "migration", exitCode: 0, output: "PASS" },
      { id: "localization", exitCode: 0, output: "PASS" },
      {
        id: "detected-982ac5089003",
        exitCode: 1,
        output: "PHP Parse error: syntax error",
      },
    ],
    failedAreas: [],
    validationOutcomes: [
      verifiedOutcome("composer-test", "TEST", "PASS", "REQUIRED"),
      verifiedOutcome("laravel-test", "TEST", "PASS", "REQUIRED"),
      verifiedOutcome("pint", "STATIC", "PASS", "REQUIRED"),
      {
        ...verifiedOutcome("detected-80a27dc5b522", "TEST", "PASS", "REQUIRED"),
        requiredCommandId: "detected-80a27dc5b522",
        satisfiedByCommandId: "detected-8ed057d5f441",
        matchType: "VERIFIED_EQUIVALENT",
        matchReasonCode: "PHPUNIT_OUTPUT_ONLY_ARGUMENT_DIFFERENCE",
      },
      verifiedOutcome("vite", "BUILD", "NOT_APPLICABLE", "NOT_APPLICABLE"),
      verifiedOutcome("migration", "DIAGNOSTIC", "PASS", "OPTIONAL"),
      verifiedOutcome("localization", "DIAGNOSTIC", "PASS", "OPTIONAL"),
      verifiedOutcome(
        "detected-982ac5089003",
        "DIAGNOSTIC",
        "INVOCATION_ERROR",
        "OPTIONAL",
      ),
      {
        ...verifiedOutcome(
          "superseded-required-invocation",
          "TEST",
          "INVOCATION_ERROR",
          "REQUIRED",
        ),
        supersededBy: "00000000-0000-4000-8000-000000000001",
      },
    ],
  } as any;
  transition(s);
  assert.equal(s.phase, "COMMIT", s.blocker);
  assert.equal(s.blocker, undefined);
  assert.equal(
    s.results.tester?.validationOutcomes?.find(
      (outcome) => outcome.id === "detected-982ac5089003",
    )?.outcome,
    "INVOCATION_ERROR",
  );
});

test("Tester PASS conflicts remain blocked with actionable host evidence", () => {
  const conflicts = [
    ["phpunit", "TEST", "TEST_FAILURE", "Required test validation"],
    [
      "phpstan",
      "STATIC",
      "STATIC_ANALYSIS_FAILURE",
      "Required static validation",
    ],
    ["vite", "BUILD", "BUILD_FAILURE", "Required build validation"],
    ["tool", "STATIC", "TOOL_UNAVAILABLE", "Required static validation"],
    [
      "diagnostic",
      "DIAGNOSTIC",
      "INVOCATION_ERROR",
      "Required diagnostic validation",
    ],
    [
      "optional-defect",
      "DIAGNOSTIC",
      "DIAGNOSTIC_FAILURE",
      "Verified diagnostic failure",
      "OPTIONAL",
    ],
  ] as const;
  for (const [
    id,
    type,
    outcome,
    source,
    applicability = "REQUIRED",
  ] of conflicts) {
    const s = state();
    s.phase = "TEST";
    s.results.tester = {
      status: "PASS",
      commands: [{ id, exitCode: 1, output: "failure" }],
      failedAreas: [],
      validationOutcomes: [verifiedOutcome(id, type, outcome, applicability)],
    } as any;
    transition(s);
    assert.equal(s.phase, "BLOCKED", `${id} advanced unexpectedly`);
    assert.match(s.blocker ?? "", new RegExp(source, "i"));
    assert.match(s.blocker ?? "", new RegExp(outcome));
  }
});

test("Tester FAIL requires exact current remediation identities", () => {
  const unsupported = state();
  unsupported.phase = "TEST";
  unsupported.results.tester = {
    status: "FAIL",
    commands: [{ id: "phpunit", exitCode: 1, output: "failure" }],
    failedAreas: ["older-phpunit"],
    classification: "FIX_LOCAL",
    validationOutcomes: [
      verifiedOutcome("phpunit", "TEST", "TEST_FAILURE", "REQUIRED"),
    ],
  } as any;
  transition(unsupported);
  assert.equal(unsupported.phase, "BLOCKED");
  assert.match(unsupported.blocker ?? "", /unsupported/i);
  assert.match(unsupported.blocker ?? "", /older-phpunit/);

  const malformed = state();
  malformed.phase = "TEST";
  malformed.results.tester = {
    status: "PASS",
    commands: [{ id: "required", exitCode: 0, output: "PASS" }],
    failedAreas: [],
    validationOutcomes: [
      {
        ...verifiedOutcome("required", "TEST", "PASS", "REQUIRED"),
        satisfiedByCommandId: "equivalent",
      },
    ],
  } as any;
  transition(malformed);
  assert.equal(malformed.phase, "BLOCKED");
  assert.match(malformed.blocker ?? "", /malformed validation evidence/i);
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
