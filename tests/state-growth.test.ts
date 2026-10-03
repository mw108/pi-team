import { test } from "node:test";
import assert from "node:assert/strict";
import { compactValidationEvidence } from "../src/agents/runner.ts";
import { newState, record } from "../src/workflow/state.ts";
import { config } from "./helpers.ts";

test("validation state retains routing facts and bounds command output", () => {
  const [item] = compactValidationEvidence([
    {
      id: "test",
      exitCode: 1,
      output: "x".repeat(50000),
      timedOut: false,
      durationMs: 123,
      sandbox: {
        mode: "constrained-host",
        network: "host",
        temporaryHome: true,
        filesystemIsolation: false,
      },
    },
  ]);
  assert.equal(item.output.length, 2000);
  assert.equal(item.id, "test");
  assert.equal(item.exitCode, 1);
  assert.equal(item.durationMs, 123);
});

test("semantic history remains available while large details are bounded", () => {
  const state = newState("/tmp", "task", config(), {
    head: null,
    dirtyPaths: [],
    status: "",
    diff: "",
    cachedDiff: "",
  });
  record(state, "agent_failure", "tester: " + "x".repeat(50000));
  assert.equal(state.history.length, 1);
  assert.equal(state.history[0].event, "agent_failure");
  assert.ok(state.history[0].detail.length <= 4000);
  assert.match(state.history[0].detail, /^tester:/);
});
