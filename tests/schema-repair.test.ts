import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PiRunner } from "../src/agents/runner.ts";
import {
  AgentDoomLoopError,
  AgentOutputError,
  AgentTimeoutError,
} from "../src/agents/errors.ts";
import { configSchema } from "../src/config/schema.ts";
import { analyzeConfigDrift, semanticConfigHash } from "../src/config/drift.ts";
import { baseline } from "../src/workflow/git.ts";
import { newState } from "../src/workflow/state.ts";
import { WorkflowEngine } from "../src/workflow/engine.ts";
import { AgentLogStore } from "../src/workflow/agent-logs.ts";
import {
  config,
  contract,
  FixtureRunner,
  output,
  repository,
} from "./helpers.ts";
import type { Role } from "../src/agents/schemas.ts";
import type { WorkflowState } from "../src/workflow/state.ts";

function fixture(role: Role, responses: string[]) {
  let prompts = 0;
  let disabled = 0;
  const instructions: string[] = [];
  const session = {
    messages: [],
    prompt: async (text: string) => {
      instructions.push(text);
      prompts++;
    },
    getLastAssistantText: () =>
      responses[Math.min(prompts - 1, responses.length - 1)],
    setActiveToolsByName: (tools: string[]) => {
      assert.deepEqual(tools, []);
      disabled++;
    },
    extensionRunner: { emit: async () => {} },
    dispose: () => {},
    abort: async () => {},
  };
  const runner = new PiRunner();
  let created = 0;
  runner.createSession = async () => {
    created++;
    return session as any;
  };
  return {
    role,
    runner,
    instructions,
    get prompts() {
      return prompts;
    },
    get disabled() {
      return disabled;
    },
    get created() {
      return created;
    },
  };
}

test("schema repair config defaults, accepts zero, and rejects invalid values", () => {
  const base = config();
  assert.equal(base.workflow.maxSchemaRepairAttempts, 2);
  for (const value of [0, 1, 3])
    assert.equal(
      configSchema.parse({
        ...base,
        workflow: { ...base.workflow, maxSchemaRepairAttempts: value },
      }).workflow.maxSchemaRepairAttempts,
      value,
    );
  for (const value of [-1, 1.5, "unlimited", true, null])
    assert.equal(
      configSchema.safeParse({
        ...base,
        workflow: { ...base.workflow, maxSchemaRepairAttempts: value },
      }).success,
      false,
    );
});

test("schema repair limit is runtime configuration drift", async () => {
  const cwd = await repository();
  const base = config();
  const state = newState(cwd, "task", base, await baseline(cwd));
  state.teamConfigPath = `${cwd}/.pi/team/team.yaml`;
  state.teamConfigHash = "before";
  state.driftConfigSnapshot = structuredClone(base);
  state.semanticConfigHash = semanticConfigHash(base);
  const changed = structuredClone(base);
  changed.workflow.maxSchemaRepairAttempts = 0;
  const drift = analyzeConfigDrift(state, {
    path: state.teamConfigPath,
    config: changed,
    configHash: "after",
    semanticConfigHash: semanticConfigHash(changed),
    agentPromptHashes: state.agentPromptHashes ?? {},
  });
  assert.deepEqual(drift.runtimeChanges, ["workflow.maxSchemaRepairAttempts"]);
  assert.equal(drift.blocking, false);
  assert.equal(semanticConfigHash(changed), semanticConfigHash(base));
});

test("default permits two corrections in the original session", async () => {
  const cwd = await repository();
  const state = newState(cwd, "task", config(), await baseline(cwd));
  const fake = fixture("orchestrator", [
    "{bad",
    "{still bad",
    JSON.stringify(output("orchestrator")),
  ]);
  const result = await fake.runner.run("orchestrator", state);
  assert.equal(result.summary, "Fix arithmetic");
  assert.equal(fake.prompts, 3);
  assert.equal(fake.created, 1);
  assert.equal(fake.disabled, 2);
  assert.match(fake.instructions[1], /JSON_PARSE_ERROR/);
  assert.match(fake.instructions[1], /SyntaxError/);
});

test("finite repair limits count additional requests exactly", async () => {
  const cwd = await repository();
  for (const limit of [1, 2]) {
    const cfg = config();
    cfg.workflow.maxSchemaRepairAttempts = limit;
    const state = newState(cwd, "task", cfg, await baseline(cwd));
    const fake = fixture("orchestrator", Array(limit + 1).fill("{bad"));
    await assert.rejects(
      () => fake.runner.run("orchestrator", state),
      AgentOutputError,
    );
    assert.equal(fake.prompts, limit + 1);
  }
});

test("zero allows repairs beyond the default with no numeric cap", async () => {
  const cwd = await repository();
  const cfg = config();
  cfg.workflow.maxSchemaRepairAttempts = 0;
  cfg.workflow.doomLoop.maxIdenticalCalls = 10;
  const state = newState(cwd, "task", cfg, await baseline(cwd));
  const fake = fixture("orchestrator", [
    "{one",
    "{two",
    "{three",
    "{four",
    JSON.stringify(output("orchestrator")),
  ]);
  assert.equal(
    (await fake.runner.run("orchestrator", state)).summary,
    "Fix arithmetic",
  );
  assert.equal(fake.prompts, 5);
});

test("unlimited repeated identical invalid output is stopped by Doom Loop guard", async () => {
  const cwd = await repository();
  const cfg = config();
  cfg.workflow.maxSchemaRepairAttempts = 0;
  const state = newState(cwd, "task", cfg, await baseline(cwd));
  const fake = fixture("orchestrator", ["{bad"]);
  await assert.rejects(
    () => fake.runner.run("orchestrator", state),
    AgentDoomLoopError,
  );
  assert.equal(fake.prompts, cfg.workflow.doomLoop.maxIdenticalCalls);
});

test("Reviewer receives precise contract inconsistency and corrects full output", async () => {
  const cwd = await repository();
  const state = newState(cwd, "task", config(), await baseline(cwd));
  const file = "tests/new.test.mjs";
  const invalid = {
    ...contract,
    filesToCreate: [],
    requiredTests: [
      {
        description: "new integration coverage",
        action: "create",
        file,
        scope: "integration",
      },
    ],
  };
  const valid = { ...invalid, filesToCreate: [file] };
  const fake = fixture("reviewer", [
    JSON.stringify(invalid),
    JSON.stringify(valid),
  ]);
  const result = await fake.runner.run("reviewer", state);
  assert.deepEqual(result.filesToCreate, [file]);
  assert.match(
    fake.instructions[1],
    /requiredTests\[0\]\.file: create test file must appear in filesToCreate: tests\/new\.test\.mjs/,
  );
  assert.equal(fake.created, 1);
});

test("repaired Reviewer gate advances the workflow to IMPLEMENT", async () => {
  const cwd = await repository();
  const file = "tests/new.test.mjs";
  const invalid = {
    ...contract,
    filesToCreate: [],
    requiredTests: [{ description: "new coverage", action: "create", file }],
  };
  const reviewer = fixture("reviewer", [
    JSON.stringify(invalid),
    JSON.stringify({ ...invalid, filesToCreate: [file] }),
  ]);
  class HybridRunner extends FixtureRunner {
    override async run(role: Role, state: WorkflowState, ...extras: any[]) {
      if (role === "reviewer")
        return (reviewer.runner.run as any)(role, state, ...extras);
      return super.run(role, state, ...extras);
    }
  }
  const runner = new HybridRunner(async (role) => {
    if (role === "implementor")
      await writeFile(
        join(cwd, file),
        "import assert from 'node:assert/strict';\nassert.ok(true);\n",
      );
  });
  const cfg = config();
  cfg.qualityGates.commit.enabled = false;
  const engine = new WorkflowEngine(cwd, runner, {
    progress() {},
    async ask() {
      return undefined;
    },
  });
  const state = await engine.start("Fix arithmetic", cfg);
  await engine.run(state);
  assert.ok(
    state.history.some(
      (entry) => entry.event === "phase_started" && entry.phase === "IMPLEMENT",
    ),
  );
  assert.equal(state.agentFailures, 0);
  assert.equal(reviewer.prompts, 2);
  assert.equal(reviewer.created, 1);
});

test("shared repair handles Solver, Tester, Implementor, and Code Reviewer schemas", async () => {
  const cwd = await repository();
  for (const role of [
    "solver1",
    "tester",
    "implementor",
    "codeReviewer",
  ] as const) {
    const state = newState(cwd, "task", config(), await baseline(cwd));
    const fake = fixture(role, ["{}", JSON.stringify(output(role))]);
    await fake.runner.run(role, state);
    assert.equal(fake.prompts, 2, role);
    assert.equal(fake.created, 1, role);
    assert.match(fake.instructions[1], /SCHEMA_VALIDATION_ERROR/);
  }
});

test("Tester follow-up final output uses the same repair loop", async () => {
  const cwd = await repository();
  const state = newState(cwd, "task", config(), await baseline(cwd));
  const question = {
    type: "QUESTION_REQUEST",
    blocking: true,
    question: "Can you approve a command?",
    reason: "Need command approval",
  };
  const blocked = {
    status: "BLOCKED",
    reason: "Required validation could not run",
    commands: [],
    failedAreas: [],
  };
  const fake = fixture("tester", [
    JSON.stringify(question),
    "{}",
    JSON.stringify(blocked),
  ]);
  const result = await fake.runner.run("tester", state);
  assert.equal(result.status, "BLOCKED");
  assert.equal(fake.prompts, 3);
  assert.equal(fake.created, 1);
  assert.match(fake.instructions[2], /SCHEMA_VALIDATION_ERROR/);
});

test("provider failure during correction propagates without another repair request", async () => {
  const cwd = await repository();
  const state = newState(cwd, "task", config(), await baseline(cwd));
  const fake = fixture("orchestrator", ["{bad"]);
  const original = fake.runner.createSession;
  fake.runner.createSession = async (...args: any[]) => {
    const session = await original.apply(fake.runner, args as any);
    let calls = 0;
    session.prompt = async () => {
      if (++calls === 2) throw new Error("provider unavailable");
    };
    return session;
  };
  await assert.rejects(
    () => fake.runner.run("orchestrator", state),
    /provider unavailable/,
  );
  assert.equal(fake.created, 1);
});

test("cancellation interrupts the correction in the current session", async () => {
  const cwd = await repository();
  const state = newState(cwd, "task", config(), await baseline(cwd));
  const controller = new AbortController();
  const runner = new PiRunner();
  let prompts = 0;
  let aborted = 0;
  runner.createSession = async () =>
    ({
      messages: [],
      prompt: async () => {
        if (++prompts === 2) controller.abort();
      },
      getLastAssistantText: () => "{bad",
      setActiveToolsByName: () => {},
      extensionRunner: { emit: async () => {} },
      dispose: () => {},
      abort: async () => {
        aborted++;
      },
    }) as any;
  await assert.rejects(
    () => runner.run("orchestrator", state, controller.signal),
    /interrupted/,
  );
  assert.equal(prompts, 2);
  assert.equal(aborted, 1);
});

test("the original agent timeout also covers repair turns", async () => {
  const cwd = await repository();
  const cfg = config();
  cfg.agents.orchestrator.timeoutMs = 1000;
  const state = newState(cwd, "task", cfg, await baseline(cwd));
  const runner = new PiRunner();
  let prompts = 0;
  runner.createSession = async () =>
    ({
      messages: [],
      prompt: async () => {
        if (++prompts === 2)
          await new Promise((resolve) => setTimeout(resolve, 1100));
      },
      getLastAssistantText: () => "{bad",
      setActiveToolsByName: () => {},
      extensionRunner: { emit: async () => {} },
      dispose: () => {},
      abort: async () => {},
    }) as any;
  await assert.rejects(
    () => runner.run("orchestrator", state),
    AgentTimeoutError,
  );
  assert.equal(prompts, 2);
});

test("successful repair records progress without charging an agent failure", async () => {
  const cwd = await repository();
  const fake = fixture("researcher", [
    "{bad",
    JSON.stringify(output("researcher")),
  ]);
  const engine = new WorkflowEngine(cwd, fake.runner, {
    progress() {},
    async ask() {
      return undefined;
    },
  });
  const state = await engine.start("Fix arithmetic", config());
  const result = await engine.invoke("researcher", state);
  assert.notEqual(result.result.type, "QUESTION_REQUEST");
  if (result.result.type === "QUESTION_REQUEST")
    throw new Error("Unexpected question");
  assert.equal(result.result.architectureSummary, "Small ESM fixture");
  assert.equal(result.failures, 0);
  assert.equal(state.agentFailures, 0);
  assert.deepEqual(
    state.history
      .filter((entry) => entry.event.startsWith("schema_repair_"))
      .map((entry) => entry.event),
    ["schema_repair_started", "schema_repair_succeeded"],
  );
  const logs = await new AgentLogStore(cwd).read(state.id, "researcher", 1);
  assert.ok(logs.some((event) => event.type === "schema_repair_succeeded"));
});
