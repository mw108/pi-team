import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { WorkflowEngine } from "../src/workflow/engine.ts";
import {
  FixtureRunner,
  config,
  contract,
  output,
  repository,
} from "./helpers.ts";

async function runTesterMutation(
  kind: "test" | "source" | "artifact",
  mayModifyTests: boolean,
) {
  const cwd = await repository();
  const cfg = config();
  cfg.tester.mayModifyTests = mayModifyTests;
  cfg.qualityGates.commit.enabled = false;
  const testContract = {
    ...contract,
    filesToModify: [...contract.filesToModify, "tests/math.test.mjs"],
  };
  let tests = 0;
  const runner = new FixtureRunner(async (role, state) => {
    if (role === "reviewer") return testContract;
    if (role === "implementor") {
      await writeFile(
        join(cwd, "math.js"),
        "export const add = (a, b) => a + b;\n",
      );
      return output(role);
    }
    if (role === "tester") {
      tests++;
      if (tests === 1) {
        const path =
          kind === "test"
            ? "tests/math.test.mjs"
            : kind === "source"
              ? "math.js"
              : ".phpunit.result.cache";
        await writeFile(
          join(cwd, path),
          (kind === "artifact"
            ? "cache"
            : await readFile(join(cwd, path), "utf8")) + "\n// changed",
        );
      }
      return output(role);
    }
  });
  const engine = new WorkflowEngine(cwd, runner, {
    progress: () => {},
    ask: async () => undefined,
  });
  const state = await engine.start("Fix addition", cfg);
  await engine.run(state);
  return { state, runner, tests };
}

test("Tester test edits require another review and a second validation", async () => {
  const { state, runner, tests } = await runTesterMutation("test", true);
  assert.equal(state.phase, "DONE", state.blocker);
  assert.equal(tests, 2);
  assert.equal(runner.counts.codeReviewer, 2);
  assert.ok(
    state.history.some((event) => event.event === "test_source_changed"),
  );
});

test("Tester edits are blocked when disabled, including test source", async () => {
  const { state } = await runTesterMutation("test", false);
  assert.equal(state.phase, "BLOCKED");
  assert.match(state.blocker ?? "", /Validation changed reviewed files/);
});

test("Tester production edits are blocked even with test editing enabled", async () => {
  const { state } = await runTesterMutation("source", true);
  assert.equal(state.phase, "BLOCKED");
  assert.match(state.blocker ?? "", /Validation changed reviewed files/);
});

test("known untracked test output does not invalidate source review", async () => {
  const { state, tests } = await runTesterMutation("artifact", false);
  assert.equal(state.phase, "DONE", state.blocker);
  assert.equal(tests, 1);
});
