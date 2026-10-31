import test from "node:test";
import assert from "node:assert/strict";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { config, contract, repository } from "./helpers.ts";
import { baseline } from "../src/workflow/git.ts";
import { newState } from "../src/workflow/state.ts";
import { discoverCommands } from "../src/agents/discovery.ts";
import { execute } from "../src/agents/commands.ts";
import {
  recordVerifiedCommandResult,
  repositoryEvidenceState,
  currentVerifiedCommandResults,
} from "../src/workflow/verified-commands.ts";
import {
  executeRequiredValidationStage,
  requiredValidationBlockReason,
} from "../src/workflow/required-validation-execution.ts";
import { PiRunner } from "../src/agents/runner.ts";

async function angularFixture() {
  const cwd = await repository();
  await writeFile(
    join(cwd, "package.json"),
    JSON.stringify({
      type: "module",
      scripts: {
        build: "node synthetic-build.js",
        test: "node synthetic-test.js",
      },
    }),
  );
  await writeFile(join(cwd, "angular.json"), "{}\n");
  await writeFile(
    join(cwd, "synthetic-build.js"),
    "console.log('synthetic angular build passed');\n",
  );
  await writeFile(
    join(cwd, "synthetic-test.js"),
    "console.log('10 test files passed'); console.log('158 tests passed');\n",
  );
  const cfg = config();
  cfg.commands = [];
  const state = newState(
    cwd,
    "Change the Angular frontend",
    cfg,
    await baseline(cwd),
  );
  state.results.reviewer = {
    ...contract,
    filesToModify: ["src/app.component.ts"],
    requiredTests: [
      {
        description: "Angular regression suite passes",
        action: "existing",
        file: "src/app.component.spec.ts",
        scope: "unit",
      },
    ],
  };
  state.results.implementor = {
    status: "IMPLEMENTED",
    summary: "Changed the Angular frontend",
    changedFiles: ["src/app.component.ts"],
    checks: [],
  };
  state.discoveredCommands = await discoverCommands(cwd);
  return { cwd, state };
}

async function addImplementorEvidence(
  state: Awaited<ReturnType<typeof angularFixture>>["state"],
) {
  for (const candidate of state.discoveredCommands) {
    const evidence = await execute(candidate.command, state.cwd);
    const verified = await recordVerifiedCommandResult(
      state,
      candidate.command,
      evidence,
      "implementor",
      1,
    );
    assert.ok(verified);
    state.verifiedCommandResults.push(verified);
  }
}

test("host executes the exact Angular incident obligations without a Tester tool call", async (t) => {
  const { cwd, state } = await angularFixture();
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await addImplementorEvidence(state);
  const priorIds = state.verifiedCommandResults.map((item) => item.executionId);
  const approvals: string[] = [];
  const observed: string[] = [];

  const first = await executeRequiredValidationStage({
    state,
    attempt: 1,
    runtimeApproval: async (command, request, _signal, _wait, context) => {
      approvals.push(command.id);
      assert.match(request.purpose, new RegExp(command.id));
      assert.equal(context?.requiresExplicitMutationApproval, true);
      return "allow";
    },
    onResult: async (command, evidence) => {
      observed.push(command.id);
      const verified = await recordVerifiedCommandResult(
        state,
        command,
        evidence,
        "tester",
        1,
      );
      assert.ok(verified);
      state.verifiedCommandResults.push(verified);
    },
  });

  assert.equal(first.blocked, undefined);
  assert.deepEqual(first.required.map((command) => command.id).sort(), [
    "detected-063ff8887a48",
    "detected-8c6935abb5ae",
  ]);
  assert.deepEqual(first.executed.sort(), [
    "detected-063ff8887a48",
    "detected-8c6935abb5ae",
  ]);
  assert.deepEqual(observed.sort(), first.executed.sort());
  assert.equal(approvals.length, 2);
  assert.equal(first.matches.length, 2);
  assert.ok(first.matches.every((match) => match.matchType === "EXACT"));
  assert.ok(
    priorIds.every((executionId) =>
      state.verifiedCommandResults.some(
        (item) =>
          item.executionId === executionId && item.agent === "implementor",
      ),
    ),
    "Implementor audit evidence must remain intact",
  );

  const testerEvidence = currentVerifiedCommandResults(
    state,
    await repositoryEvidenceState(state),
  ).filter((item) => item.agent === "tester");
  assert.equal(testerEvidence.length, 2);

  const second = await executeRequiredValidationStage({
    state,
    attempt: 2,
    runtimeApproval: async () => {
      throw new Error("current persisted Tester evidence should be reused");
    },
    onResult: async () => {
      throw new Error("no duplicate execution should occur on retry");
    },
  });
  assert.deepEqual(second.executed, []);
  assert.equal(second.matches.length, 2);
  assert.equal(state.verifiedCommandResults.length, 4);
});

test("PiRunner resolves required validations before accepting an empty-command Tester PASS", async (t) => {
  const { cwd, state } = await angularFixture();
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await addImplementorEvidence(state);
  let promptInput: any;
  let testerEvidenceAtPrompt = 0;
  const runner = new PiRunner();
  runner.createSession = async () =>
    ({
      messages: [],
      prompt: async (input: string) => {
        promptInput = JSON.parse(input);
        testerEvidenceAtPrompt = state.verifiedCommandResults.filter(
          (item) => item.agent === "tester",
        ).length;
      },
      getLastAssistantText: () =>
        JSON.stringify({ status: "PASS", commands: [], failedAreas: [] }),
      extensionRunner: { emit: async () => {} },
      dispose: () => {},
      abort: async () => {},
    }) as any;

  const result = (await runner.run(
    "tester",
    state,
    undefined,
    undefined,
    2,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    async () => "allow",
  )) as any;

  assert.equal(testerEvidenceAtPrompt, 2);
  assert.equal(promptInput.requiredValidationExecution.owner, "host");
  assert.deepEqual(
    promptInput.requiredValidationExecution.executedObligationIds.sort(),
    ["detected-063ff8887a48", "detected-8c6935abb5ae"],
  );
  assert.equal(result.status, "PASS", result.reason);
  assert.equal(result.commands.length, 2);
  assert.ok(result.commands.every((item: any) => item.exitCode === 0));
  assert.equal(result.validationOutcomes.length, 2);
});

test("historical Implementor evidence is audit-only and cannot satisfy TEST obligations", async (t) => {
  const { cwd, state } = await angularFixture();
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await addImplementorEvidence(state);
  let executions = 0;
  const stage = await executeRequiredValidationStage({
    state,
    attempt: 3,
    runtimeApproval: async () => "allow",
    onResult: async (command, evidence) => {
      executions++;
      const verified = await recordVerifiedCommandResult(
        state,
        command,
        evidence,
        "tester",
        3,
      );
      assert.ok(verified);
      state.verifiedCommandResults.push(verified);
    },
  });
  assert.equal(executions, 2);
  assert.equal(stage.matches.length, 2);
  assert.ok(stage.matches.every((match) => match.executionId));
});

test("a JavaScript lockfile change invalidates persisted host validation evidence", async (t) => {
  const { cwd, state } = await angularFixture();
  t.after(() => rm(cwd, { recursive: true, force: true }));
  let executions = 0;
  const run = (attempt: number) =>
    executeRequiredValidationStage({
      state,
      attempt,
      runtimeApproval: async () => "allow",
      onResult: async (command, evidence) => {
        executions++;
        const verified = await recordVerifiedCommandResult(
          state,
          command,
          evidence,
          "tester",
          attempt,
        );
        assert.ok(verified);
        state.verifiedCommandResults.push(verified);
      },
    });

  assert.equal((await run(1)).executed.length, 2);
  await writeFile(join(cwd, "package-lock.json"), '{"lockfileVersion":3}\n');
  const retried = await run(2);
  assert.equal(retried.executed.length, 2);
  assert.equal(executions, 4);
  assert.ok(
    state.verifiedCommandResults
      .filter((item) => item.attempt === 2)
      .every(
        (item) => item.repoState.validationConfigHashes?.["package-lock.json"],
      ),
  );
});

test("repository drift during the validation batch blocks a mixed-state verdict", async (t) => {
  const { cwd, state } = await angularFixture();
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await writeFile(
    join(cwd, "synthetic-test.js"),
    "import { mkdirSync, writeFileSync } from 'node:fs'; mkdirSync('src', { recursive: true }); writeFileSync('src/app.component.ts', 'changed during validation\\n'); console.log('158 tests passed');\n",
  );
  const stage = await executeRequiredValidationStage({
    state,
    attempt: 1,
    runtimeApproval: async () => "allow",
    onResult: async (command, evidence) => {
      const verified = await recordVerifiedCommandResult(
        state,
        command,
        evidence,
        "tester",
        1,
      );
      assert.ok(verified);
      state.verifiedCommandResults.push(verified);
    },
  });
  assert.equal(stage.blocked?.code, "REPOSITORY_CHANGED_DURING_VALIDATION");
  assert.equal(stage.matches.length, 1);
  assert.match(
    requiredValidationBlockReason(stage.blocked!),
    /one current state/,
  );
});

test("authorization denial blocks the exact obligation without starting a process", async (t) => {
  const { cwd, state } = await angularFixture();
  t.after(() => rm(cwd, { recursive: true, force: true }));
  let observed = false;
  const stage = await executeRequiredValidationStage({
    state,
    attempt: 1,
    runtimeApproval: async () => "deny",
    onResult: async () => {
      observed = true;
    },
  });
  assert.equal(observed, false);
  assert.ok(stage.blocked);
  assert.match(stage.blocked.code, /DENIED/);
  assert.match(
    requiredValidationBlockReason(stage.blocked),
    /Required obligation:\ndetected-/,
  );
  assert.equal(state.verifiedCommandResults.length, 0);
});

test("a missing executable produces an actionable host blocker and no PASS evidence", async (t) => {
  const cwd = await repository();
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const cfg = config();
  cfg.commands = [
    {
      id: "required-missing-tool",
      executable: "pi-team-definitely-missing-executable",
      args: ["--check"],
      purpose: "static",
      timeoutMs: 1_000,
    },
  ];
  const state = newState(cwd, "Validate the project", cfg, await baseline(cwd));
  const stage = await executeRequiredValidationStage({
    state,
    attempt: 1,
    onResult: async () => {
      throw new Error("a process that never starts must not create evidence");
    },
  });
  assert.equal(stage.blocked?.code, "EXECUTABLE_NOT_FOUND");
  assert.match(requiredValidationBlockReason(stage.blocked!), /Executable/);
  assert.equal(state.verifiedCommandResults.length, 0);
});
