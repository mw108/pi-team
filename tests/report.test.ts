import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { WorkflowEngine } from "../src/workflow/engine.ts";
import {
  buildCompletionReportInput,
  fallbackReport,
  finalizeReport,
  renderBlocked,
  renderReport,
} from "../src/workflow/report.ts";
import { baseline } from "../src/workflow/git.ts";
import { newState } from "../src/workflow/state.ts";
import { allowedTools } from "../src/agents/permissions.ts";
import { AgentTimeoutError } from "../src/agents/errors.ts";
import { initTeam } from "../src/config/init.ts";
import { loadConfig } from "../src/config/loader.ts";
import { teamRoot } from "../src/config/project.ts";
import {
  config,
  contract,
  FixtureRunner,
  output,
  repository,
} from "./helpers.ts";
import teamExtension from "../src/index.ts";

const ui = { progress: () => {}, ask: async () => undefined };
function noCommit() {
  const cfg = config();
  cfg.qualityGates.commit.enabled = false;
  return cfg;
}

test("report input uses actual changed paths and recorded validation, not Solver proposals", async () => {
  const cwd = await repository();
  const s = newState(cwd, "Fix login errors", noCommit(), await baseline(cwd));
  s.requirements = ["Show login errors"];
  s.results.solver1 = {
    ...output("solver1"),
    filesToChange: ["auth.service.ts"],
  };
  s.results.reviewer = { ...contract, goal: "Fix login errors" };
  s.results.implementor = {
    status: "IMPLEMENTED",
    summary: "Corrected login errors",
    changedFiles: ["login.component.ts", "login.component.spec.ts"],
    checks: [],
  };
  await writeFile(
    join(cwd, "login.component.ts"),
    "export const login = true;\n",
  );
  await writeFile(
    join(cwd, "login.component.spec.ts"),
    "export const covered = true;\n",
  );
  s.results.codeReviewer = { status: "APPROVED", findings: [] };
  s.results.tester = {
    status: "PASS",
    commands: [{ id: "test", exitCode: 0, output: "pass" }],
    failedAreas: [],
  };
  const input = await buildCompletionReportInput(s);
  assert.equal(input.task, "Fix login errors");
  assert.deepEqual(input.requirements, ["Show login errors"]);
  assert.equal(input.implementation.contractSummary, "Fix login errors");
  assert.deepEqual(input.implementation.changedFiles, [
    "login.component.spec.ts",
    "login.component.ts",
  ]);
  assert.equal(
    input.implementation.changedFiles.includes("auth.service.ts"),
    false,
  );
  assert.match(
    input.validation.find((v) => v.label.includes("--test"))?.label ?? "",
    /tests\/math.test.mjs/,
  );
  assert.equal(input.validationCommands[0].exitCode, 0);
  assert.equal(input.validationCommands[0].success, true);
  assert.equal(input.validationCommands[0].purpose, "test");
  assert.equal(
    input.validation.find((v) => v.label === "Pentest")?.status,
    "disabled",
  );
  assert.equal(input.commit.created, false);
  assert.match(input.commit.detail ?? "", /Disabled/);
  assert.deepEqual(input.cycles, { design: 1, localFix: 0, pentest: 0 });
  assert.equal(
    renderReport(fallbackReport(input)).includes("auth.service.ts"),
    false,
  );
  const fabricated = finalizeReport(input, {
    summary: "Changed auth.service.ts and corrected login errors",
    implemented: ["Changed auth.service.ts"],
    changedFiles: ["auth.service.ts"],
    validation: [{ label: "Pentest", status: "passed" }],
    notes: ["Invented detail"],
    unresolvedIssues: ["Invented issue"],
    commit: { created: true, hash: "fake" },
  });
  assert.deepEqual(fabricated.changedFiles, input.implementation.changedFiles);
  assert.equal(fabricated.summary, "Corrected login errors");
  assert.deepEqual(fabricated.implemented, ["Corrected login errors"]);
  assert.equal(
    fabricated.validation.find((v) => v.label === "Pentest")?.status,
    "disabled",
  );
  assert.equal(fabricated.commit.created, false);
  assert.equal(fabricated.notes.includes("Invented detail"), false);
});

test("commit and review facts remain authoritative in finalized report", async () => {
  const cwd = await repository();
  const s = newState(cwd, "task", config(), await baseline(cwd));
  s.results.implementor = {
    status: "IMPLEMENTED",
    summary: "Fixed addition",
    changedFiles: ["math.js"],
    checks: [],
  };
  s.results.commitAgent = { message: "fix addition", files: ["math.js"] };
  s.commit = { hash: "abc123", files: ["math.js"] };
  const input = await buildCompletionReportInput(s);
  assert.deepEqual(input.implementation.changedFiles, ["math.js"]);
  assert.deepEqual(input.commit, {
    created: true,
    hash: "abc123",
    message: "fix addition",
  });
  s.commit = undefined;
  s.blocker = "Unrelated dirty files prevented a safe commit";
  assert.match(
    (await buildCompletionReportInput(s)).commit.detail ?? "",
    /Unrelated dirty files/,
  );
});

test("report input preserves review findings, limitations, cycles, and failed command evidence", async () => {
  const cwd = await repository();
  const cfg = config();
  cfg.qualityGates.pentest.enabled = true;
  const s = newState(cwd, "task", cfg, await baseline(cwd));
  s.fullCycle = 2;
  s.localFixCycle = 1;
  s.pentestCycle = 1;
  s.results.codeReviewer = {
    status: "FIX_LOCAL",
    findings: [
      {
        severity: "low",
        file: "math.js",
        problem: "Fallback is unclear",
        suggestedFix: "Clarify it",
        requiresRedesign: false,
      },
    ],
  };
  s.results.pentester = {
    status: "PASS",
    findings: [],
    coverage: ["math.js"],
    limitations: ["No browser was available"],
  };
  s.results.securityReviewer = {
    findings: [],
    summary: "No security findings",
  };
  s.results.tester = {
    status: "FAIL",
    commands: [{ id: "test", exitCode: 1, output: "failed" }],
    failedAreas: ["test"],
  };
  const input = await buildCompletionReportInput(s);
  assert.ok(
    input.unresolvedIssues.some((item) => item.includes("Fallback is unclear")),
  );
  assert.deepEqual(input.limitations, ["No browser was available"]);
  assert.deepEqual(input.cycles, { design: 2, localFix: 1, pentest: 1 });
  assert.equal(input.validationCommands[0].success, false);
  assert.equal(
    input.validation.find((v) => v.label === "Testing")?.status,
    "failed",
  );
  assert.equal(
    input.validation.find((v) => v.label === "Pentest")?.status,
    "passed",
  );
  s.results.pentester = {
    status: "FINDINGS",
    findings: [
      {
        id: "P1",
        title: "Suspected issue",
        severity: "low",
        category: "test",
        affectedComponent: "math.js",
        reproductionSteps: [],
        evidence: "Fixture evidence",
        impact: "None",
        suggestedFix: "Review classification",
      },
    ],
    coverage: [],
    limitations: [],
  };
  s.results.securityReviewer = {
    findings: [
      {
        id: "P1",
        classification: "FALSE_POSITIVE",
        evidence: "Reproduced safely",
      },
    ],
    summary: "No actionable findings",
  };
  const classified = await buildCompletionReportInput(s);
  assert.equal(
    classified.validation.find((v) => v.label === "Pentest")?.status,
    "warning",
  );
  assert.equal(
    classified.validation.find((v) => v.label === "Security review")?.status,
    "passed",
  );
});

for (const [name, failure] of [
  ["malformed result", async () => ({ bad: true })],
  [
    "provider failure",
    async () => {
      throw new Error("provider terminated");
    },
  ],
  [
    "timeout",
    async () => {
      throw new AgentTimeoutError("reporter", 1000, 1);
    },
  ],
] as const)
  test(`Reporter ${name} preserves completed work and renders fallback`, async () => {
    const cwd = await repository();
    const cfg = noCommit();
    const runner = new FixtureRunner(async (role) =>
      role === "reporter" ? failure() : undefined,
    );
    const engine = new WorkflowEngine(cwd, runner, ui);
    const s = await engine.start("Fix addition", cfg);
    await engine.run(s);
    assert.equal(s.phase, "DONE", s.blocker);
    assert.ok(s.results.implementor);
    assert.ok(s.results.tester);
    assert.ok(s.results.reporter);
    assert.ok(s.reportFailure);
    assert.match(
      renderReport(s.results.reporter, s.reportFailure),
      /Narrative report failed/,
    );
    assert.equal(engine.retryConfirmation(s, "reporter"), undefined);
  });

test("REPORT resumes only Reporter, and a completed Reporter can be retried", async () => {
  const cwd = await repository();
  const cfg = noCommit();
  const runner = new FixtureRunner();
  const engine = new WorkflowEngine(cwd, runner, ui);
  const s = await engine.start("Fix addition", cfg);
  await engine.run(s);
  assert.equal(s.phase, "DONE", s.blocker);
  const count = runner.calls.length;
  s.phase = "REPORT";
  s.inFlight = { phase: "REPORT", roles: ["reporter"] };
  await engine.store.save(s);
  const loaded = await engine.store.load(s.id);
  await engine.run(loaded);
  assert.deepEqual(runner.calls.slice(count), ["reporter"]);
  assert.equal(loaded.phase, "DONE");
  const retried = await engine.retryAgent(loaded, "reporter", true);
  assert.equal(retried, "prepared");
  await engine.run(loaded);
  assert.deepEqual(runner.calls.slice(count), ["reporter", "reporter"]);
  assert.equal(loaded.phase, "DONE");
});

test("aborting Reporter preserves completed implementation and shows fallback", async () => {
  const cwd = await repository();
  const base = new FixtureRunner();
  const runner = {
    run: async (role: any, state: any, signal?: AbortSignal) => {
      if (role !== "reporter") return base.run(role, state);
      return new Promise((_resolve, reject) => {
        if (signal?.aborted) {
          reject(new Error("terminated"));
          return;
        }
        signal?.addEventListener(
          "abort",
          () => reject(new Error("terminated")),
          { once: true },
        );
      });
    },
  } as any;
  const engine = new WorkflowEngine(cwd, runner, ui);
  const s = await engine.start("Fix addition", noCommit());
  const controller = new AbortController();
  const running = engine.run(s, controller.signal);
  try {
    for (
      let i = 0;
      i < 3000 && !engine.activeAttempt("reporter") && s.phase !== "BLOCKED";
      i++
    )
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(engine.activeAttempt("reporter"), s.blocker);
    await engine.abortAgent(s, "reporter");
    await running;
  } finally {
    controller.abort();
    await running;
  }
  assert.equal(s.phase, "DONE");
  assert.ok(s.results.implementor);
  assert.ok(s.reportFailure?.includes("aborted"));
  assert.ok(s.results.reporter);
});

test("future Reporter prompt drift uses new prompt without replaying work", async () => {
  const cwd = await repository();
  const runner = new FixtureRunner();
  const engine = new WorkflowEngine(cwd, runner, ui);
  const s = await engine.start("task", noCommit());
  s.phase = "REPORT";
  s.results.implementor = output("implementor");
  s.results.securityReviewer = output("securityReviewer");
  await engine.store.save(s);
  await writeFile(
    join(teamRoot(cwd), "agents", "reporter.md"),
    "Changed reporter instructions",
  );
  await engine.run(s);
  assert.equal(s.phase, "DONE");
  assert.equal(s.reportFailure, undefined);
  assert.deepEqual(runner.calls, ["reporter"]);
});

test("Reporter provider failure after commit preserves the created commit", async () => {
  const cwd = await repository();
  const runner = new FixtureRunner(async (role) => {
    if (role === "reporter") throw new Error("provider terminated");
  });
  const engine = new WorkflowEngine(cwd, runner, ui);
  const s = await engine.start("Fix addition", config());
  await engine.run(s);
  assert.equal(s.phase, "DONE", s.blocker);
  assert.ok(s.commit?.hash);
  assert.equal(s.results.reporter?.commit.hash, s.commit.hash);
  assert.ok(s.reportFailure);
});

test("/team-report redisplays persisted report, selects an ID, and falls back for old DONE state", async () => {
  const cwd = await repository();
  const cfg = noCommit();
  const runner = new FixtureRunner();
  const engine = new WorkflowEngine(cwd, runner, ui);
  const first = await engine.start("First task", cfg);
  await engine.run(first);
  assert.equal(first.phase, "DONE", first.blocker);
  const calls = runner.calls.length;
  const commands = new Map<string, any>();
  teamExtension({
    on: () => {},
    registerCommand: (name: string, definition: any) =>
      commands.set(name, definition),
  } as any);
  let notice = "";
  const ctx = {
    cwd,
    ui: {
      notify: (message: string) => {
        notice = message;
      },
    },
  };
  await commands.get("team-report").handler(first.id, ctx);
  assert.match(notice, /Team DONE[\s\S]*Fixed addition/);
  await commands.get("team-report").handler("", ctx);
  assert.match(notice, /Team DONE[\s\S]*Fixed addition/);
  assert.equal(runner.calls.length, calls);
  delete first.results.reporter;
  delete first.reportInput;
  await engine.store.save(first);
  await writeFile(join(cwd, "later.ts"), "export const later = true;\n");
  const newer = await engine.start("Second task", cfg);
  newer.phase = "RESEARCH";
  await engine.store.save(newer);
  await commands.get("team-report").handler(first.id, ctx);
  assert.match(notice, /Team DONE[\s\S]*Fixed addition/);
  assert.doesNotMatch(notice, /later\.ts/);
  assert.match(notice, /Changed paths are unavailable/);
  await commands.get("team-report").handler(newer.id, ctx);
  assert.match(notice, /Report is not final yet[\s\S]*RESEARCH/);
  assert.equal(runner.calls.length, calls);
});

test("Reporter has zero tools; repair adds its config and prompt to an older project", async () => {
  const cwd = await repository();
  assert.deepEqual(allowedTools("reporter", config()), []);
  const yamlPath = join(teamRoot(cwd), "team.yaml");
  const original = await readFile(yamlPath, "utf8");
  const old = original.replace(/\n  reporter:\n(?:    [^\n]*\n)+/, "\n");
  await writeFile(yamlPath, old);
  await unlink(join(teamRoot(cwd), "agents", "reporter.md"));
  const result = await initTeam(cwd, "repair");
  assert.ok(result.created.includes(".pi/team/agents/reporter.md"));
  assert.ok(result.created.includes(".pi/team/team.yaml reporter entry"));
  assert.equal((await loadConfig(cwd)).config.agents.reporter.name, "Reporter");
});

test("explicit Reporter configuration validates its prompt, role, temperature, and timeout", async () => {
  const cwd = await repository();
  const cfg = config();
  assert.deepEqual(allowedTools("reporter", cfg), []);
  const prompt = join(teamRoot(cwd), "agents", "reporter.md");
  await unlink(prompt);
  await assert.rejects(loadConfig(cwd), /Missing agent prompt for "reporter"/);
  await initTeam(cwd, "repair");
  assert.ok((await loadConfig(cwd)).agentPromptHashes.reporter);
  const { configSchema } = await import("../src/config/schema.ts");
  for (const reporter of [
    { ...cfg.agents.reporter, role: "tester" },
    { ...cfg.agents.reporter, temperature: 3 },
    { ...cfg.agents.reporter, timeoutMs: -1 },
    { ...cfg.agents.reporter, prompt: "" },
  ])
    assert.equal(
      configSchema.safeParse({ ...cfg, agents: { ...cfg.agents, reporter } })
        .success,
      false,
    );
});

test("blocked summary uses persisted cause and a safe next action", async () => {
  const cwd = await repository();
  const s = newState(cwd, "task", noCommit(), await baseline(cwd));
  s.config.agents.researcher.name = "Research Analyst";
  s.phase = "BLOCKED";
  s.blocker = "Agent execution failed: researcher: provider terminated";
  s.history.push({
    at: new Date().toISOString(),
    phase: "RESEARCH",
    event: "agent_failure",
    detail: "researcher: provider terminated",
  });
  s.history.push({
    at: new Date().toISOString(),
    phase: "RESEARCH",
    event: "blocked",
    detail: s.blocker,
  });
  assert.match(
    renderBlocked(s),
    /Stopped at\nRESEARCH · Research Analyst \(researcher\)[\s\S]*Agent execution failed: Research Analyst \(researcher\):[\s\S]*\/team-retry researcher/,
  );
});
