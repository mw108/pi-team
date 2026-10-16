import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import {
  MAX_LOCAL_JSON_REPAIR_DEPTH,
  MAX_LOCAL_JSON_REPAIR_LENGTH,
  repairJsonLocally,
  type LocalJsonRepairEvent,
} from "../src/agents/local-json-repair.ts";
import { parseText, type Role } from "../src/agents/schemas.ts";
import { AgentOutputError } from "../src/agents/errors.ts";
import { PiRunner } from "../src/agents/runner.ts";
import { baseline } from "../src/workflow/git.ts";
import { newState } from "../src/workflow/state.ts";
import { config, output, repository } from "./helpers.ts";
import { WorkflowEngine } from "../src/workflow/engine.ts";
import { AgentLogStore } from "../src/workflow/agent-logs.ts";

const orchestrator = output("orchestrator");

function malformedTrailingComma(role: Role) {
  return JSON.stringify(output(role)).replace(/}$/, ",}");
}

test("valid JSON bypasses both local repair strategies", () => {
  const events: LocalJsonRepairEvent[] = [];
  assert.deepEqual(
    parseText("orchestrator", JSON.stringify(orchestrator), undefined, {
      onLocalRepair: (event) => events.push(event),
    }),
    orchestrator,
  );
  assert.deepEqual(events, []);
});

test("jsonrepair handles fences, trailing commas, missing closers, quotes, and unicode", () => {
  const cases = [
    '```json\n{"requirements":["café \\u2615"],"summary":"Fix",}\n```',
    '{"requirements":["x"],"summary":"Fix"',
    "{'requirements':['x'],'summary':'Fix'}",
    "{“requirements”:[“x”],“summary”:“Fix”}",
  ];
  for (const candidate of cases) {
    const events: LocalJsonRepairEvent[] = [];
    const result = parseText("orchestrator", candidate, undefined, {
      onLocalRepair: (event) => events.push(event),
    });
    if (result.type === "QUESTION_REQUEST")
      throw new Error("Unexpected question result");
    assert.equal(result.summary, "Fix");
    assert.equal(events[0]?.type, "json_repair_started");
    assert.equal(events[1]?.type, "json_repair_succeeded");
    assert.equal(
      events.some((event) => event.type.startsWith("ai_json_repair_")),
      false,
    );
  }
});

test("ai-json-repair receives the original after jsonrepair fails", () => {
  const events: LocalJsonRepairEvent[] = [];
  const candidate = '{"requirements":["x"],,"summary":"Fix"}';
  const result = parseText("orchestrator", candidate, undefined, {
    onLocalRepair: (event) => events.push(event),
  });
  if (result.type === "QUESTION_REQUEST")
    throw new Error("Unexpected question result");
  assert.equal(result.summary, "Fix");
  assert.deepEqual(
    events.map((event) => event.type),
    [
      "json_repair_started",
      "json_repair_failed",
      "ai_json_repair_started",
      "ai_json_repair_succeeded",
    ],
  );
});

test("strategy injection verifies ordering and original-candidate isolation", () => {
  const calls: string[] = [];
  const events: LocalJsonRepairEvent[] = [];
  const original = "{broken";
  const result = repairJsonLocally({
    candidate: original,
    originalFailureType: "parse",
    implementations: {
      jsonrepair(candidate) {
        calls.push(`first:${candidate}`);
        throw new Error("first failed");
      },
      aiJsonRepair(candidate) {
        calls.push(`second:${candidate}`);
        return JSON.stringify(orchestrator);
      },
    },
    validate: (value) =>
      z
        .object({
          requirements: z.array(z.string()).min(1),
          summary: z.string(),
        })
        .parse(value),
    onEvent: (event) => events.push(event),
  });
  assert.equal(result?.summary, orchestrator.summary);
  assert.deepEqual(calls, [`first:${original}`, `second:${original}`]);
  assert.equal(events.at(-1)?.type, "ai_json_repair_succeeded");
});

test("schema-invalid parsed JSON cannot be semantically coerced", () => {
  const events: LocalJsonRepairEvent[] = [];
  assert.throws(
    () =>
      parseText(
        "orchestrator",
        '{"requirements":[],"summary":"Fix"}',
        undefined,
        { onLocalRepair: (event) => events.push(event) },
      ),
    (error: unknown) =>
      error instanceof AgentOutputError && error.kind === "schema",
  );
  assert.deepEqual(
    events.map((event) => event.type),
    [
      "json_repair_started",
      "json_repair_failed",
      "ai_json_repair_started",
      "ai_json_repair_failed",
      "local_json_repair_exhausted",
    ],
  );
});

test("duplicate keys, multiple objects, comments, ellipsis, and trailing prose fail closed", () => {
  const candidates = [
    '{"requirements":["x"],"summary":"FAIL","summary":"PASS"}',
    `${JSON.stringify(orchestrator)}\n${JSON.stringify(orchestrator)}`,
    `${JSON.stringify(orchestrator)} explanation`,
    '{"requirements":["x", ...],"summary":"Fix"}',
    '{"requirements":["x"],/* omitted */"summary":"Fix"}',
  ];
  for (const candidate of candidates) {
    const events: LocalJsonRepairEvent[] = [];
    assert.throws(() =>
      parseText("orchestrator", candidate, undefined, {
        onLocalRepair: (event) => events.push(event),
      }),
    );
    assert.deepEqual(
      events.map((event) => event.type),
      ["local_json_repair_exhausted"],
    );
    assert.equal(events[0].skippedReason, "ambiguous");
  }
});

test("actual truncation and bounded resource limits skip synchronous repair", () => {
  const cases: {
    candidate: string;
    options?: { modelOutputTruncated?: boolean };
    reason: LocalJsonRepairEvent["skippedReason"];
  }[] = [
    {
      candidate: '{"requirements":["x"],"summary":"Fix"',
      options: { modelOutputTruncated: true },
      reason: "model_output_truncated",
    },
    {
      candidate: `{"requirements":["x"],"summary":"${"x".repeat(MAX_LOCAL_JSON_REPAIR_LENGTH)}`,
      reason: "candidate_too_large",
    },
    {
      candidate: `{"requirements":${"[".repeat(MAX_LOCAL_JSON_REPAIR_DEPTH + 1)}"x"}`,
      reason: "nesting_too_deep",
    },
  ];
  for (const item of cases) {
    const events: LocalJsonRepairEvent[] = [];
    assert.throws(() =>
      parseText("orchestrator", item.candidate, undefined, {
        ...item.options,
        onLocalRepair: (event) => events.push(event),
      }),
    );
    assert.equal(events[0]?.type, "local_json_repair_exhausted");
    assert.equal(events[0]?.skippedReason, item.reason);
  }
});

test("all structured role pipelines accept safe syntax repair without a model turn", async () => {
  const cwd = await repository();
  for (const role of [
    "researcher",
    "reviewer",
    "pentester",
    "securityReviewer",
    "commitAgent",
  ] as const) {
    const state = newState(cwd, "task", config(), await baseline(cwd));
    if (role === "commitAgent")
      state.commitSelection = {
        workflowPaths: [],
        excludedPaths: [],
        commitPaths: [],
        completed: false,
      };
    let prompts = 0;
    const runner = new PiRunner();
    runner.createSession = async () =>
      ({
        messages: [],
        prompt: async () => {
          prompts++;
        },
        getLastAssistantText: () => malformedTrailingComma(role),
        setActiveToolsByName: () => {},
        extensionRunner: { emit: async () => {} },
        dispose: () => {},
        abort: async () => {},
      }) as any;
    await runner.run(role, state);
    assert.equal(prompts, 1, role);
  }
});

test("local repair events are persisted without schema-repair events", async () => {
  const cwd = await repository();
  let prompts = 0;
  const runner = new PiRunner();
  runner.createSession = async () =>
    ({
      messages: [],
      prompt: async () => {
        prompts++;
      },
      getLastAssistantText: () => malformedTrailingComma("researcher"),
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
  const state = await engine.start("Fix arithmetic", config());
  await engine.invoke("researcher", state);
  assert.equal(prompts, 1);
  const repairHistory = state.history
    .filter((entry) => entry.event.includes("repair"))
    .map((entry) => entry.event);
  assert.deepEqual(repairHistory, [
    "json_repair_started",
    "json_repair_succeeded",
  ]);
  const logs = await new AgentLogStore(cwd).read(state.id, "researcher", 1);
  assert.deepEqual(
    logs
      .filter((event) => event.type.includes("repair"))
      .map((event) => event.type),
    ["json_repair_started", "json_repair_succeeded"],
  );
  assert.equal(
    logs.some((event) => "text" in event && event.type.includes("repair")),
    false,
  );
});

test("locally repaired Tester PASS remains subject to host evidence reconciliation", async () => {
  const cwd = await repository();
  const state = newState(cwd, "task", config(), await baseline(cwd));
  let prompts = 0;
  const runner = new PiRunner();
  runner.createSession = async () =>
    ({
      messages: [],
      prompt: async () => {
        prompts++;
      },
      getLastAssistantText: () => malformedTrailingComma("tester"),
      getActiveToolNames: () => ["read", "team_command"],
      setActiveToolsByName: () => {},
      extensionRunner: { emit: async () => {} },
      dispose: () => {},
      abort: async () => {},
    }) as any;
  const result = (await runner.run("tester", state)) as any;
  assert.equal(prompts, 1);
  assert.notEqual(result.status, "PASS");
  assert.equal(result.status, "FAIL");
  assert.ok(result.commands.length > 0);
});
