import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseText,
  parseResult,
  type Role,
  type OutputRecovery,
} from "../src/agents/schemas.ts";
import { PiRunner } from "../src/agents/runner.ts";
import { newState } from "../src/workflow/state.ts";
import { config, contract, output, repository } from "./helpers.ts";
import { baseline } from "../src/workflow/git.ts";
import { AgentOutputError } from "../src/agents/errors.ts";
import { WorkflowEngine } from "../src/workflow/engine.ts";
import { AgentLogStore } from "../src/workflow/agent-logs.ts";
test("structured results accept valid data and reject invalid routing", () => {
  const reviewed = parseResult("codeReviewer", {
    status: "APPROVED",
    findings: [],
  });
  assert.notEqual(reviewed.type, "QUESTION_REQUEST");
  if (reviewed.type === "QUESTION_REQUEST")
    throw new Error("Unexpected question");
  assert.equal(reviewed.status, "APPROVED");
  assert.throws(() => parseResult("codeReviewer", { status: "probably fine" }));
  assert.throws(() =>
    parseResult("codeReviewer", {
      status: "APPROVED",
      findings: [{ bad: true }],
    }),
  );
  assert.throws(() => parseText("researcher", 'prose {"x":1}'));
});
test("structured output recovers only surplus trailing closing delimiters", () => {
  const valid = JSON.stringify(output("orchestrator"));
  const recovered: OutputRecovery[] = [];
  assert.deepEqual(
    parseText("orchestrator", valid, (event) => recovered.push(event)),
    output("orchestrator"),
  );
  assert.equal(recovered.length, 0);
  for (const suffix of ["}", "}}", "  }\n", "]", " } ] "]) {
    assert.deepEqual(
      parseText("orchestrator", valid + suffix, (event) =>
        recovered.push(event),
      ),
      output("orchestrator"),
    );
    assert.deepEqual(recovered.at(-1), {
      reason: "trailing_closing_delimiter",
      discardedLength: suffix.trimEnd().length,
      discardedPreview: suffix.trimEnd(),
    });
  }
  assert.deepEqual(
    parseText("orchestrator", `\`\`\`json\n${valid}}\n\`\`\``),
    output("orchestrator"),
  );
});
test("structured output scanner handles nesting and escaped string content", () => {
  const critic = {
    ...output("critic"),
    proposalCritiques: [
      {
        solverId: "solver1",
        weaknesses: [
          "literal } and { inside string",
          'value with "quoted } text"',
          "backslash \\ and ]",
        ],
        tradeoffs: [],
      },
    ],
  };
  assert.deepEqual(parseText("critic", JSON.stringify(critic) + "}"), critic);
});
test("structured output rejects other malformed content with typed failures", () => {
  const valid = JSON.stringify(output("orchestrator"));
  for (const raw of [
    valid + valid,
    valid + " explanation",
    valid.slice(0, -1),
    '{"requirements":["x"] "summary":"y"}',
    "Here is the JSON:\n" + valid,
  ]) {
    assert.throws(
      () => parseText("orchestrator", raw),
      (error: unknown) =>
        error instanceof AgentOutputError &&
        error.kind === "parse" &&
        !/Unexpected token/.test(error.message),
    );
  }
  let recovered = false;
  assert.throws(() =>
    parseText("orchestrator", '{"wrong":"shape"}}', () => {
      recovered = true;
    }),
  );
  assert.equal(recovered, false);
});
test("schema correction keeps the agent session and disables actions", async () => {
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
test("persistent malformed output fails after configured corrections", async () => {
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
  await assert.rejects(
    () => runner.run("orchestrator", s),
    (error: unknown) =>
      error instanceof AgentOutputError && error.kind === "parse",
  );
  assert.equal(prompts, 3);
});
test("malformed final output is counted once and logged with a redacted preview", async () => {
  const cwd = await repository();
  const runner = new PiRunner();
  let prompts = 0;
  runner.createSession = async () =>
    ({
      messages: [],
      prompt: async () => {
        prompts++;
      },
      getLastAssistantText: () =>
        "<tool_call>--token=private-value</tool_call>",
      setActiveToolsByName: () => {},
      extensionRunner: { emit: async () => {} },
      dispose: () => {},
      abort: async () => {},
    }) as any;
  const engine = new WorkflowEngine(cwd, runner, {
    progress() {},
    async ask() {
      return undefined;
    },
  });
  const state = await engine.start("Fix", config());
  await assert.rejects(
    engine.invoke("researcher", state),
    (error: unknown) =>
      error instanceof AgentOutputError &&
      (error as AgentOutputError & { failures: number }).failures === 1 &&
      !/Unexpected token/.test(error.message),
  );
  assert.equal(prompts, 3);
  const events = await new AgentLogStore(cwd).read(state.id, "researcher", 1);
  const failure = events.find((event) => event.type === "provider_error")!;
  assert.equal(failure.category, "agent_output");
  assert.match(String(failure.rawFinalResponsePreview), /\[REDACTED\]/);
  assert.doesNotMatch(JSON.stringify(events), /private-value/);
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
