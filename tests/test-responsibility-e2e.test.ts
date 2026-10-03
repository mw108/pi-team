import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { WorkflowEngine } from "../src/workflow/engine.ts";
import { contextFor } from "../src/agents/context.ts";
import { checkTool } from "../src/agents/permissions.ts";
import { git } from "../src/workflow/git.ts";
import { FixtureRunner, config, repository } from "./helpers.ts";
import { contractSchema } from "../src/agents/schemas.ts";

const component = "src/login.js";
const spec = "tests/login.test.mjs";
const contract = {
  goal: "Handle failed authentication and extend regression coverage",
  filesToModify: [component, spec],
  filesToCreate: [],
  filesToDelete: [],
  requiredChanges: ["Display backend error", "Reset submitting state"],
  technicalDecisions: [],
  constraints: [],
  requiredTests: [
    {
      description: "Successful login remains covered",
      action: "existing",
      file: spec,
      scope: "unit",
    },
    {
      description:
        "Failed login displays backend error and resets submitting state",
      action: "modify",
      file: spec,
      scope: "unit",
      acceptanceCriteria: [
        "authentication call rejects with HTTP error",
        "backend error message is displayed",
        "isSubmitting is false after the error",
      ],
    },
  ],
  acceptanceCriteria: ["Failed login is handled"],
  knownRisks: [],
};
const successTest = `import assert from 'node:assert/strict';
import { test } from 'node:test';
import { login } from '../src/login.js';
test('successful login', async () => {
  const state = { isSubmitting: false, error: '' };
  assert.equal(await login(async () => true, state), true);
  assert.equal(state.isSubmitting, false);
});
`;
const failureTest = `test('failed login shows backend error and clears submitting', async () => {
  const state = { isSubmitting: false, error: '' };
  const httpError = new Error('backend unavailable');
  assert.equal(await login(async () => { throw httpError; }, state), false);
  assert.equal(state.error, 'backend unavailable');
  assert.equal(state.isSubmitting, false);
});
`;

async function fixture(omitTest: boolean) {
  const cwd = await repository();
  await mkdir(join(cwd, "src"));
  await writeFile(
    join(cwd, component),
    "export async function login(auth, state) { state.isSubmitting = true; await auth(); state.isSubmitting = false; return true; }\n",
  );
  await writeFile(join(cwd, spec), successTest);
  await git(cwd, ["add", component, spec]);
  await git(cwd, [
    "-c",
    "core.hooksPath=/dev/null",
    "commit",
    "-m",
    "test: login baseline",
  ]);
  const cfg = config();
  cfg.commands = [
    {
      id: "login-test",
      executable: process.execPath,
      args: ["--test", spec],
      purpose: "test",
      timeoutMs: 30000,
    },
  ];
  cfg.qualityGates.commit.enabled = false;
  if (omitTest) cfg.workflow.maxLocalFixCycles = 0;
  let implementorSawContract = false;
  const runner = new FixtureRunner(async (role, s) => {
    if (role === "reviewer") return contract;
    if (role === "implementor") {
      const input = await contextFor(role, s);
      const reviewer = contractSchema.parse(input.reviewer);
      assert.deepEqual(
        reviewer.requiredTests[1].acceptanceCriteria,
        contract.requiredTests[1].acceptanceCriteria,
      );
      assert.equal(reviewer.requiredTests[1].action, "modify");
      assert.equal(reviewer.requiredTests[1].file, spec);
      await checkTool(
        "implementor",
        "edit",
        { path: spec },
        cwd,
        cfg,
        contractSchema.parse(contract),
      );
      implementorSawContract = true;
      await writeFile(
        join(cwd, component),
        `export async function login(auth, state) {
  state.isSubmitting = true;
  try { await auth(); state.isSubmitting = false; return true; }
  catch (error) { state.error = error.message; state.isSubmitting = false; return false; }
}\n`,
      );
      if (!omitTest)
        await writeFile(join(cwd, spec), successTest + failureTest);
      return {
        status: "IMPLEMENTED",
        summary: "Implemented login failure handling",
        changedFiles: omitTest ? [component] : [component, spec],
        checks: [],
      };
    }
    if (role === "codeReviewer") {
      const input = await contextFor(role, s);
      assert.equal(
        contractSchema.parse(input.reviewer).requiredTests[1].action,
        "modify",
      );
      const actual = await readFile(join(cwd, spec), "utf8");
      if (!actual.includes("failed login shows backend error"))
        return {
          status: "FIX_LOCAL",
          findings: [
            {
              severity: "medium",
              file: spec,
              problem: "Required failed-login test was not implemented",
              suggestedFix:
                "Add assertions for backend error and submitting state",
              requiresRedesign: false,
            },
          ],
        };
      return { status: "APPROVED", findings: [] };
    }
  });
  const engine = new WorkflowEngine(cwd, runner, {
    progress: () => {},
    ask: async () => undefined,
  });
  const state = await engine.start("Handle failed authentication", cfg);
  await engine.run(state);
  return { state, runner, implementorSawContract };
}

test("login fixture implements required test before Code Review, then Tester passes", async () => {
  const { state, runner, implementorSawContract } = await fixture(false);
  assert.equal(
    state.phase,
    "DONE",
    `${state.blocker}: ${JSON.stringify(state.results.tester)}`,
  );
  assert.ok(implementorSawContract);
  assert.ok(
    runner.calls.indexOf("implementor") < runner.calls.indexOf("codeReviewer"),
  );
  assert.ok(
    runner.calls.indexOf("codeReviewer") < runner.calls.indexOf("tester"),
  );
  assert.equal(state.results.tester?.status, "PASS");
  assert.equal(state.results.tester?.commands[0].exitCode, 0);
});
test("missing required test produces Code Reviewer FIX_LOCAL before Tester", async () => {
  const { state, runner } = await fixture(true);
  assert.equal(state.phase, "BLOCKED");
  assert.equal(state.results.codeReviewer?.status, "FIX_LOCAL");
  assert.match(
    state.results.codeReviewer?.findings[0].problem,
    /Required failed-login test/,
  );
  assert.equal(runner.counts.tester, undefined);
});
