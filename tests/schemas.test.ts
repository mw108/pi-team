import { test } from "node:test";
import assert from "node:assert/strict";
import { parseText, parseResult, type Role } from "../src/agents/schemas.ts";
import { PiRunner } from "../src/agents/runner.ts";
import { newState } from "../src/workflow/state.ts";
import { config, contract, output, repository } from "./helpers.ts";
import { baseline } from "../src/workflow/git.ts";
test("structured results accept valid data and reject invalid routing", () => {
  assert.equal(
    parseResult("codeReviewer", { status: "APPROVED", findings: [] }).status,
    "APPROVED",
  );
  assert.throws(() => parseResult("codeReviewer", { status: "probably fine" }));
  assert.throws(() =>
    parseResult("codeReviewer", {
      status: "APPROVED",
      findings: [{ bad: true }],
    }),
  );
  assert.throws(() => parseText("researcher", 'prose {"x":1}'));
});
test("schema correction retry is exactly once and disables actions", async () => {
  const cwd = await repository();
  const s = newState(cwd, "task", config(), await baseline(cwd));
  let prompts = 0,
    disabled = false;
  const fake = {
    messages: [],
    prompt: async () => {
      prompts++;
    },
    getLastAssistantText: () =>
      prompts === 1 ? "invalid" : JSON.stringify(output("orchestrator")),
    setActiveToolsByName: (tools: string[]) => {
      disabled = tools.length === 0;
    },
    extensionRunner: { emit: async () => {} },
    dispose: () => {},
    abort: async () => {},
  };
  const runner = new PiRunner();
  runner.createSession = async () => fake as any;
  const result = await runner.run("orchestrator", s);
  assert.equal(prompts, 2);
  assert.ok(disabled);
  assert.equal(result.summary, "Fix arithmetic");
});
test("Reviewer contract inconsistency triggers output-only correction", async () => {
  const cwd = await repository();
  const s = newState(cwd, "task", config(), await baseline(cwd));
  let prompts = 0;
  let correction = "";
  let disabled = false;
  const valid = {
    ...contract,
    filesToModify: ["math.js", "tests/math.test.mjs"],
    requiredTests: [
      {
        description: "failure",
        action: "modify",
        file: "tests/math.test.mjs",
        acceptanceCriteria: ["error asserted"],
      },
    ],
  };
  const invalid = {
    ...valid,
    requiredTests: [{ description: "failure", action: "modify" }],
  };
  const runner = new PiRunner();
  runner.createSession = async () =>
    ({
      messages: [],
      prompt: async (text: string) => {
        prompts++;
        if (prompts === 2) correction = text;
      },
      getLastAssistantText: () =>
        JSON.stringify(prompts === 1 ? invalid : valid),
      setActiveToolsByName: (tools: string[]) => {
        disabled = tools.length === 0;
      },
      extensionRunner: { emit: async () => {} },
      dispose: () => {},
      abort: async () => {},
    }) as any;
  const result = await runner.run("reviewer", s);
  assert.equal(prompts, 2);
  assert.ok(disabled);
  assert.match(correction, /requires a test file/);
  assert.match(correction, /requiredTests/);
  assert.equal(result.requiredTests[0].file, "tests/math.test.mjs");
});
test("persistent malformed output fails after one correction", async () => {
  const cwd = await repository();
  const s = newState(cwd, "task", config(), await baseline(cwd));
  let prompts = 0;
  const runner = new PiRunner();
  runner.createSession = async () =>
    ({
      messages: [],
      prompt: async () => {
        prompts++;
      },
      getLastAssistantText: () => "{broken",
      setActiveToolsByName: () => {},
      extensionRunner: { emit: async () => {} },
      dispose: () => {},
      abort: async () => {},
    }) as any;
  await assert.rejects(() => runner.run("orchestrator", s));
  assert.equal(prompts, 2);
});
test("Tester executes real configured commands and cannot fabricate PASS", async () => {
  const cwd = await repository(),
    s = newState(cwd, "task", config(), await baseline(cwd));
  let supplied: any;
  const fake = {
    messages: [],
    prompt: async (text: string) => {
      supplied = JSON.parse(text);
    },
    getLastAssistantText: () => JSON.stringify(output("tester")),
    getActiveToolNames: () => ["read", "team_command"],
    setActiveToolsByName: (tools: string[]) =>
      assert.ok(!tools.includes("team_command")),
    extensionRunner: { emit: async () => {} },
    dispose: () => {},
    abort: async () => {},
  };
  const runner = new PiRunner();
  runner.createSession = async () => fake as any;
  const result = await runner.run("tester", s);
  assert.equal(supplied.verifiedCommandResults[0].exitCode, 1);
  assert.equal(result.status, "FAIL");
  assert.equal(result.commands[0].exitCode, 1);
  assert.deepEqual(result.failedAreas, ["test"]);
});
