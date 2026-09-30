import { test } from "node:test";
import assert from "node:assert/strict";
import { WorkflowEngine } from "../src/workflow/engine.ts";
import {
  FixtureRunner,
  config,
  repository,
  output,
  finding,
} from "./helpers.ts";
import { writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { git, head } from "../src/workflow/git.ts";
import { record, type WorkflowState } from "../src/workflow/state.ts";
import { AgentTimeoutError } from "../src/agents/errors.ts";
import { renderProgress } from "../src/ui/progress.ts";
const ui = { progress: () => {}, ask: async () => undefined };
test("complete team pipeline executes real tests and creates intended commit", async () => {
  const cwd = await repository();
  const runner = new FixtureRunner(),
    engine = new WorkflowEngine(cwd, runner, ui);
  const s = await engine.start("Fix addition", config());
  const before = await head(cwd);
  await engine.run(s);
  assert.equal(s.phase, "DONE", s.blocker);
  assert.notEqual(await head(cwd), before);
  assert.deepEqual(s.commit?.files, ["math.js"]);
  assert.match((s.results.tester as any).commands[0].output, /pass 1/);
  assert.ok(
    runner.calls.indexOf("tester") < runner.calls.indexOf("commitAgent"),
  );
  assert.equal((await git(cwd, ["status", "--short"])).trim(), "");
  assert.equal((await engine.store.load(s.id)).phase, "DONE");
});
for (const status of ["FIX_LOCAL", "FIX_DESIGN", "FIX_REQUIREMENTS"] as const)
  test(`end-to-end ${status} routing`, async () => {
    const cwd = await repository();
    const cfg = config();
    cfg.qualityGates.commit.enabled = false;
    let questions = 0;
    const runner = new FixtureRunner(async (role, _s, count) =>
      role === "codeReviewer" && count === 1
        ? {
            status,
            findings: status === "FIX_REQUIREMENTS" ? [] : [finding],
            ...(status === "FIX_REQUIREMENTS"
              ? { question: "Integers only?" }
              : {}),
          }
        : undefined,
    );
    const engine = new WorkflowEngine(cwd, runner, {
      progress: () => {},
      ask: async () => {
        questions++;
        return "Support integers";
      },
    });
    const s = await engine.start("Fix addition", cfg);
    await engine.run(s);
    assert.equal(s.phase, "DONE", s.blocker);
    assert.equal(runner.counts.researcher, status === "FIX_LOCAL" ? 1 : 2);
    assert.equal(runner.counts.implementor, 2);
    assert.equal(s.agentFailures, 0);
    const implementationRuns = s.history.filter(
      (event) =>
        event.event === "agent_attempt_started" &&
        event.meta?.agent === "implementor",
    );
    assert.deepEqual(
      implementationRuns.map((event) => event.meta?.retryNumber),
      [0, 0],
    );
    assert.equal(
      implementationRuns[1]?.meta?.trigger,
      status === "FIX_LOCAL"
        ? "fix_local"
        : status === "FIX_DESIGN"
          ? "fix_design"
          : "fix_requirements",
    );
    assert.equal(
      s.history.filter((event) => event.event === "agent_retry").length,
      0,
    );
    assert.equal(questions, status === "FIX_REQUIREMENTS" ? 1 : 0);
  });
test("three solvers execute concurrently with isolated initial context", async () => {
  const cwd = await repository(),
    cfg = config();
  cfg.qualityGates.commit.enabled = false;
  let started = 0;
  let release!: () => void;
  const barrier = new Promise<void>((r) => {
    release = r;
  });
  const runner = new FixtureRunner(async (role, s) => {
    if (role.startsWith("solver")) {
      assert.equal(s.results.solver1, undefined);
      assert.equal(s.results.solver2, undefined);
      assert.equal(s.results.solver3, undefined);
      started++;
      if (started === 3) release();
      await barrier;
    }
    return undefined;
  });
  const engine = new WorkflowEngine(cwd, runner, ui),
    s = await engine.start("Fix", cfg);
  await engine.run(s);
  assert.equal(started, 3);
  assert.equal(s.phase, "DONE", s.blocker);
});
test("one solver failure preserves successful siblings and continues with quorum", async () => {
  const cwd = await repository();
  const runner = new FixtureRunner(async (role) => {
    if (role === "solver2") throw new Error("Malformed output");
  });
  const engine = new WorkflowEngine(cwd, runner, ui),
    s = await engine.start("Fix", config());
  await engine.run(s);
  assert.equal(s.phase, "DONE", s.blocker);
  assert.ok(s.results.solver1);
  assert.ok(s.results.solver3);
  assert.equal(runner.counts.implementor, 1);
});
test("read-only agent timeout retries once and is accounted globally", async () => {
  const cwd = await repository(),
    cfg = config();
  cfg.qualityGates.commit.enabled = false;
  cfg.workflow.maxAgentFailures = 3;
  const runner = new FixtureRunner(async (role, _s, count) => {
    if (role === "researcher" && count === 1)
      throw new AgentTimeoutError("researcher", 1000, 1);
  });
  const engine = new WorkflowEngine(cwd, runner, ui),
    s = await engine.start("Fix", cfg);
  await engine.run(s);
  assert.equal(s.phase, "DONE", s.blocker);
  assert.equal(runner.counts.researcher, 2);
  assert.equal(s.agentFailures, 1);
  assert.deepEqual(
    s.history
      .filter(
        (event) =>
          event.event === "agent_attempt_started" &&
          event.meta?.agent === "researcher",
      )
      .map((event) => [
        event.meta?.attempt,
        event.meta?.retryNumber,
        event.meta?.trigger,
      ]),
    [
      [1, 0, "initial"],
      [2, 1, "automatic_retry"],
    ],
  );
});
test("provider failure stops without consuming a hard retry", async () => {
  const cwd = await repository();
  const runner = new FixtureRunner(async (role) => {
    if (role === "researcher") throw new Error("503 provider unavailable");
  });
  const engine = new WorkflowEngine(cwd, runner, ui),
    s = await engine.start("Fix", config());
  await engine.run(s);
  assert.equal(s.phase, "BLOCKED");
  assert.equal(s.agentFailures, 1);
  assert.equal(runner.counts.researcher, 1);
  assert.equal(runner.counts.commitAgent, undefined);
});
test("read-only interruption resumes; mutating interruption stops for inspection", async () => {
  for (const phase of ["RESEARCH", "IMPLEMENT"] as const) {
    const cwd = await repository();
    const engine = new WorkflowEngine(cwd, new FixtureRunner(), ui),
      s = await engine.start("Fix", config());
    s.phase = phase;
    s.inFlight = {
      phase,
      roles: [phase === "RESEARCH" ? "researcher" : "implementor"],
    };
    await engine.store.save(s);
    const loaded = await engine.store.load(s.id);
    await engine.run(loaded);
    assert.equal(
      loaded.phase,
      phase === "RESEARCH" ? "DONE" : "BLOCKED",
      loaded.blocker,
    );
  }
});
test("pending question persists, resumes, and never assumes an answer", async () => {
  const cwd = await repository();
  const runner = new FixtureRunner(async (role, s) =>
    role === "orchestrator" && !s.answers.length
      ? {
          type: "QUESTION_REQUEST",
          blocking: true,
          question: "Integers?",
          reason: "Scope",
        }
      : undefined,
  );
  let engine = new WorkflowEngine(cwd, runner, ui);
  const s = await engine.start("Fix", config());
  await engine.run(s);
  assert.equal(s.phase, "WAITING_USER");
  assert.equal(s.answers.length, 0);
  engine = new WorkflowEngine(cwd, runner, {
    progress: () => {},
    ask: async () => "Yes",
  });
  const loaded = await engine.store.load(s.id);
  await engine.run(loaded);
  assert.equal(loaded.phase, "DONE", loaded.blocker);
  assert.equal(loaded.answers[0].answer, "Yes");
});
test("pentest global limit prevents infinite security repair loops", async () => {
  const cwd = await repository(),
    cfg = config();
  cfg.qualityGates.pentest.enabled = true;
  const runner = new FixtureRunner(async (role) => {
    if (role === "pentester")
      return {
        findings: [
          {
            id: "F1",
            title: "Arithmetic",
            severity: "low",
            category: "logic",
            affectedComponent: "math.js",
            reproductionSteps: ["inspect"],
            evidence: "fixture",
            impact: "fixture",
            suggestedFix: "fix",
          },
        ],
        coverage: [],
        limitations: [],
      };
    if (role === "securityReviewer")
      return {
        findings: [
          {
            id: "F1",
            classification: "CONFIRMED",
            route: "FIX_LOCAL",
            evidence: "fixture",
          },
        ],
        summary: "confirmed",
      };
  });
  const engine = new WorkflowEngine(cwd, runner, ui),
    s = await engine.start("Fix", cfg);
  await engine.run(s);
  assert.equal(s.phase, "BLOCKED");
  assert.match(s.blocker ?? "", /Pentest cycle limit/);
  assert.equal(runner.counts.pentester, 2);
  assert.equal(s.agentFailures, 0);
  const implementationRuns = s.history.filter(
    (event) =>
      event.event === "agent_attempt_started" &&
      event.meta?.agent === "implementor",
  );
  assert.deepEqual(
    implementationRuns.map((event) => [
      event.meta?.attempt,
      event.meta?.retryNumber,
      event.meta?.trigger,
    ]),
    [
      [1, 0, "initial"],
      [2, 0, "security_remediation"],
      [3, 0, "security_remediation"],
    ],
  );
  assert.equal(
    s.history.filter((event) => event.event === "agent_retry").length,
    0,
  );
  assert.ok(
    s.history.some(
      (event) =>
        event.event === "FIX_LOCAL" && event.detail === "SECURITY_REVIEW",
    ),
  );
  assert.equal(runner.counts.commitAgent, undefined);
});
for (const [source, trigger, returnedBy] of [
  ["PENTEST", "pentest_remediation", "Pentester"],
  ["SECURITY_REVIEW", "security_remediation", "Security Reviewer"],
] as const)
  test(`${source} return starts a normal Implementor run with the correct TUI reason`, async () => {
    const cwd = await repository();
    const engine = new WorkflowEngine(cwd, new FixtureRunner(), ui);
    const state = await engine.start("Fix", config());
    state.phase = "IMPLEMENT";
    record(state, "agent_attempt_started", "implementor run 1 started", {
      agent: "implementor",
      attempt: 1,
      retryNumber: 0,
      trigger: "initial",
    });
    record(state, "agent_attempt_completed", "implementor run 1 completed", {
      agent: "implementor",
      attempt: 1,
      retryNumber: 0,
    });
    record(state, "FIX_LOCAL", source);
    const result = await engine.invoke("implementor", state);
    state.results.implementor = result.result;
    const starts = state.history.filter(
      (event) =>
        event.event === "agent_attempt_started" &&
        event.meta?.agent === "implementor",
    );
    assert.deepEqual(
      starts.map((event) => [
        event.meta?.attempt,
        event.meta?.retryNumber,
        event.meta?.trigger,
      ]),
      [
        [1, 0, "initial"],
        [2, 0, trigger],
      ],
    );
    assert.equal(result.failures, 0);
    assert.equal(state.agentFailures, 0);
    assert.equal(
      state.history.filter((event) => event.event === "agent_retry").length,
      0,
    );
    assert.equal(
      state.history.filter((event) => event.event === "network_retry_started")
        .length,
      0,
    );
    const display = renderProgress(state).join("\n");
    assert.match(display, /Implementor.*run 2/);
    assert.match(display, new RegExp(`returned by ${returnedBy}`));
    assert.doesNotMatch(display, /Implementor.*retry 1/);
  });
test("failing real checks prevent commit even after claimed approval", async () => {
  const cwd = await repository();
  const cfg = config();
  cfg.workflow.maxLocalFixCycles = 0;
  const runner = new FixtureRunner(async (role, s) => {
    if (role === "implementor") return output(role);
  });
  const before = await head(cwd),
    engine = new WorkflowEngine(cwd, runner, ui),
    s = await engine.start("Fix", cfg);
  await engine.run(s);
  assert.equal(s.phase, "BLOCKED");
  assert.equal(await head(cwd), before);
  assert.equal(runner.counts.commitAgent, undefined);
  assert.equal((s.results.tester as any).commands[0].exitCode, 1);
});
test("pre-existing user changes are preserved and never committed", async () => {
  const cwd = await repository();
  await writeFile(join(cwd, "user.txt"), "user content");
  const engine = new WorkflowEngine(cwd, new FixtureRunner(), ui),
    s = await engine.start("Fix", config());
  await engine.run(s);
  assert.equal(s.phase, "DONE", s.blocker);
  assert.equal(await readFile(join(cwd, "user.txt"), "utf8"), "user content");
  assert.match(await git(cwd, ["status", "--short"]), /user.txt/);
  assert.deepEqual(s.commit?.files, ["math.js"]);
});
test("contract touching a dirty baseline file waits for approval before editing", async () => {
  const cwd = await repository();
  await writeFile(join(cwd, "math.js"), "user changes");
  const runner = new FixtureRunner(),
    engine = new WorkflowEngine(cwd, runner, ui),
    s = await engine.start("Fix", config());
  await engine.run(s);
  assert.equal(s.phase, "WAITING_USER");
  assert.equal(s.pendingApproval?.kind, "dirtyPaths");
  assert.equal(runner.counts.implementor, undefined);
  assert.equal(await readFile(join(cwd, "math.js"), "utf8"), "user changes");
});
test("failed solver with quorum is not retried during explicit resume", async () => {
  const cwd = await repository();
  const runner = new FixtureRunner(async (role, _s, count) => {
    if (role === "solver2" && count === 1) throw new Error("Malformed result");
  });
  const engine = new WorkflowEngine(cwd, runner, ui),
    s = await engine.start("Fix", config());
  await engine.run(s);
  assert.equal(s.phase, "DONE", s.blocker);
  await engine.resumeReadonly(s);
  assert.equal(s.phase, "DONE", s.blocker);
  assert.equal(s.agentFailures, 1);
  assert.equal(runner.counts.solver1, 1);
  assert.equal(runner.counts.solver2, 1);
  assert.equal(runner.counts.solver3, 1);
});
test("source changes made after approvals cannot be committed", async () => {
  const cwd = await repository();
  const runner = new FixtureRunner(async (role, s) => {
    if (role === "commitAgent") {
      await writeFile(join(s.cwd, "math.js"), "export const add = () => 99;\n");
      return output(role);
    }
  });
  const before = await head(cwd),
    engine = new WorkflowEngine(cwd, runner, ui),
    s = await engine.start("Fix", config());
  await engine.run(s);
  assert.equal(s.phase, "BLOCKED");
  assert.match(s.blocker ?? "", /Reviewed files changed/);
  assert.equal(await head(cwd), before);
});
test("pre-existing staged user files prevent automatic commit", async () => {
  const cwd = await repository();
  await writeFile(join(cwd, "user.txt"), "user data");
  await git(cwd, ["add", "user.txt"]);
  const before = await head(cwd),
    engine = new WorkflowEngine(cwd, new FixtureRunner(), ui),
    s = await engine.start("Fix", config());
  await engine.run(s);
  assert.equal(s.phase, "BLOCKED");
  assert.match(s.blocker ?? "", /Existing staged changes/);
  assert.equal(await head(cwd), before);
  assert.match(await git(cwd, ["diff", "--cached", "--name-only"]), /user.txt/);
});
