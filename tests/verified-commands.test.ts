import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  commandTool,
  execute,
  type CommandEvidence,
} from "../src/agents/commands.ts";
import { PiRunner } from "../src/agents/runner.ts";
import { normalizedRuntimeCommand } from "../src/agents/runtime-commands.ts";
import { commandKey } from "../src/agents/discovery.ts";
import { baseline } from "../src/workflow/git.ts";
import { newState, validateState } from "../src/workflow/state.ts";
import { StateStore } from "../src/workflow/persistence.ts";
import { transition } from "../src/workflow/router.ts";
import {
  classifyVerifiedCommand,
  currentVerifiedCommandResults,
  isVerifiedCommandResultCurrent,
  recordVerifiedCommandResult,
  repositoryEvidenceState,
  supersedingInvocation,
} from "../src/workflow/verified-commands.ts";
import { config, contract, repository } from "./helpers.ts";

const sandbox = {
  mode: "none" as const,
  network: "host" as const,
  temporaryHome: true,
  filesystemIsolation: false,
};

test("verified results persist, redact output, select latest and expire on relevant edits", async () => {
  const cwd = await repository();
  const cfg = config();
  const state = newState(cwd, "check", cfg, await baseline(cwd));
  state.results.reviewer = contract;
  const command = normalizedRuntimeCommand(
    {
      executable: process.execPath,
      args: ["--test", "tests/math.test.mjs"],
      purpose: "Run arithmetic tests",
      category: "test",
    },
    "implementor",
  ).command;
  const evidence: CommandEvidence = {
    id: command.id,
    exitCode: 1,
    output: "TOKEN=secret-value\nfailed",
    sandbox,
  };
  const first = await recordVerifiedCommandResult(
    state,
    command,
    evidence,
    "implementor",
    1,
  );
  assert.ok(first);
  assert.equal(first.commandIdentity, commandKey(command));
  assert.equal(first.exitCode, 1);
  const matching = await repositoryEvidenceState(state);
  assert.equal(isVerifiedCommandResultCurrent(first, matching), true);
  assert.equal(
    isVerifiedCommandResultCurrent(first, {
      ...matching,
      head: "different-head",
    }),
    false,
  );
  assert.equal(
    isVerifiedCommandResultCurrent(first, { ...matching, gateHashes: {} }),
    false,
  );
  assert.equal(
    isVerifiedCommandResultCurrent(
      { ...first, repoState: { ...first.repoState, gateHashes: {} } },
      matching,
    ),
    false,
  );
  assert.doesNotMatch(first.output, /secret-value/);
  state.verifiedCommandResults.push(first);
  const second = await recordVerifiedCommandResult(
    state,
    command,
    { ...evidence, exitCode: 0, output: "passed" },
    "tester",
    2,
  );
  assert.ok(second);
  state.verifiedCommandResults.push(second);
  const store = new StateStore(cwd);
  await store.save(state);
  const loaded = await store.load(state.id);
  assert.deepEqual(
    validateState({ ...loaded, verifiedCommandResults: undefined })
      .verifiedCommandResults,
    [],
  );
  assert.equal(
    currentVerifiedCommandResults(
      loaded,
      await repositoryEvidenceState(loaded),
    )[0].exitCode,
    0,
  );
  loaded.config.workflow.requestTimeoutMs = 130000;
  assert.equal(
    currentVerifiedCommandResults(loaded, await repositoryEvidenceState(loaded))
      .length,
    1,
  );
  await writeFile(join(cwd, "tests/math.test.mjs"), "// changed test\n");
  assert.deepEqual(
    currentVerifiedCommandResults(
      loaded,
      await repositoryEvidenceState(loaded),
    ),
    [],
  );
  await writeFile(
    join(cwd, "tests/math.test.mjs"),
    "import assert from 'node:assert/strict';import {test} from 'node:test';import {add} from '../math.js';test('addition',()=>assert.equal(add(2,3),5));\n",
  );
  await writeFile(
    join(cwd, "math.js"),
    "export const add = (a, b) => a + b;\n",
  );
  assert.deepEqual(
    currentVerifiedCommandResults(
      loaded,
      await repositoryEvidenceState(loaded),
    ),
    [],
  );
  const other = normalizedRuntimeCommand(
    {
      executable: process.execPath,
      args: ["--test", "tests/other.test.mjs"],
      purpose: "Other tests",
      category: "test",
    },
    "tester",
  ).command;
  assert.notEqual(first.commandIdentity, commandKey(other));
  assert.equal(
    await recordVerifiedCommandResult(
      state,
      command,
      { ...evidence, timedOut: true },
      "implementor",
      3,
    ),
    undefined,
  );
  assert.equal(
    await recordVerifiedCommandResult(
      state,
      command,
      { ...evidence, aborted: true },
      "implementor",
      3,
    ),
    undefined,
  );
});

test("Tester requests role approval for missing evidence and records the executed command", async () => {
  const cwd = await repository();
  const cfg = config();
  cfg.commands = [];
  const state = newState(cwd, "check", cfg, await baseline(cwd));
  state.results.reviewer = contract;
  const request = {
    executable: process.execPath,
    args: ["-e", "process.stdout.write('verified')"],
    purpose: "Run required test",
    category: "test" as const,
  };
  state.runtimeCommandApprovals.push({
    role: "implementor",
    command: normalizedRuntimeCommand(request, "implementor").command,
  });
  let approvals = 0;
  let supplied: any;
  const runner = new PiRunner();
  runner.createSession = async (
    role,
    s,
    evidence,
    _activity,
    _network,
    _signal,
    _guard,
    _provider,
    _progress,
    runtimeApproval,
    _fileApproval,
    _mutations,
    onResult,
    onDenial,
  ) =>
    ({
      messages: [],
      prompt: async (input: string) => {
        supplied = JSON.parse(input);
        const tool = commandTool(
          role,
          cfg,
          cwd,
          evidence!,
          runtimeApproval,
          () => [],
          onResult,
          onDenial,
        );
        await tool.execute("run", request, undefined, undefined, {} as any);
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
    1,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    async () => {
      approvals++;
      return "allow";
    },
  )) as any;
  assert.deepEqual(supplied.verifiedCommandResults, []);
  assert.equal(approvals, 1);
  assert.equal(result.status, "PASS");
  assert.equal(result.commands[0].exitCode, 0);
  assert.equal(state.verifiedCommandResults[0].agent, "tester");
});

test("real incident: Implementor PHP approval does not bypass Tester approval or become a question", async () => {
  const cwd = await repository();
  const cfg = config();
  cfg.commands = [];
  const state = newState(cwd, "check", cfg, await baseline(cwd));
  const request = {
    executable: "php",
    args: ["artisan", "test", "tests/Unit/ConfigTest.php"],
    purpose: "Run required test",
    category: "test" as const,
  };
  state.runtimeCommandApprovals.push({
    role: "implementor",
    command: normalizedRuntimeCommand(
      {
        ...request,
        args: [
          "artisan",
          "test",
          "tests/Unit/ConfigTest.php",
          "tests/Feature/API/V1/VerificationUrlTest.php",
          "tests/Feature/API/V1/AuthControllerTest.php",
        ],
      },
      "implementor",
    ).command,
  });
  let approvals = 0;
  const runner = new PiRunner();
  runner.createSession = async (
    role,
    _state,
    evidence,
    _activity,
    _network,
    _signal,
    _guard,
    _provider,
    _progress,
    runtimeApproval,
    _fileApproval,
    _mutations,
    onResult,
    onDenial,
  ) =>
    ({
      messages: [],
      prompt: async () => {
        const tool = commandTool(
          role,
          cfg,
          cwd,
          evidence!,
          runtimeApproval,
          () => [],
          onResult,
          onDenial,
        );
        await tool.execute("run", request, undefined, undefined, {} as any);
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
    1,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    async () => {
      approvals++;
      return "deny";
    },
  )) as any;
  assert.equal(approvals, 1);
  assert.equal(result.status, "BLOCKED");
  assert.match(result.reason, /denied by the user/);
  assert.deepEqual(state.verifiedCommandResults, []);
  state.phase = "TEST";
  state.results.tester = result;
  transition(state);
  assert.equal(state.phase, "BLOCKED");
  assert.equal(state.agentFailures, 0);
});

test("Tester reuses Implementor evidence after restart and reruns after source mutation", async () => {
  const cwd = await repository();
  const cfg = config();
  const countPath = join(cwd, ".run-count");
  cfg.commands = [
    {
      id: "count-test",
      executable: process.execPath,
      args: [
        "-e",
        `require('fs').appendFileSync(${JSON.stringify(countPath)}, 'x')`,
      ],
      purpose: "test",
      timeoutMs: 30000,
    },
  ];
  const state = newState(cwd, "check", cfg, await baseline(cwd));
  state.results.reviewer = contract;
  const first = await execute(
    cfg.commands[0],
    cwd,
    undefined,
    cfg.execution.sandbox,
  );
  assert.equal(first.exitCode, 0);
  const implementorCommand = normalizedRuntimeCommand(
    {
      executable: cfg.commands[0].executable,
      args: cfg.commands[0].args,
      purpose: "Run configured test",
      category: "test",
    },
    "implementor",
  ).command;
  const verified = await recordVerifiedCommandResult(
    state,
    implementorCommand,
    first,
    "implementor",
    1,
  );
  assert.ok(verified);
  state.verifiedCommandResults.push(verified);
  const store = new StateStore(cwd);
  await store.save(state);
  const loaded = await store.load(state.id);
  let input: any;
  const runner = new PiRunner();
  runner.createSession = async () =>
    ({
      messages: [],
      prompt: async (text: string) => {
        input = JSON.parse(text);
      },
      getLastAssistantText: () =>
        JSON.stringify({ status: "PASS", commands: [], failedAreas: [] }),
      extensionRunner: { emit: async () => {} },
      dispose: () => {},
      abort: async () => {},
    }) as any;
  const reused = (await runner.run("tester", loaded)) as any;
  assert.equal(reused.status, "PASS");
  assert.equal(reused.commands[0].id, "count-test");
  assert.equal(input.verifiedCommandResults[0].agent, "implementor");
  assert.equal(await readFile(countPath, "utf8"), "x");
  await writeFile(
    join(cwd, "math.js"),
    "export const add = (a, b) => a + b;\n",
  );
  const rerun = (await runner.run("tester", loaded)) as any;
  assert.equal(rerun.status, "PASS");
  assert.equal(await readFile(countPath, "utf8"), "xx");
  assert.equal(input.verifiedCommandResults[0].agent, "tester");
});

test("static Tester permission executes a nonzero result without prompting", async () => {
  const cwd = await repository();
  const cfg = config();
  cfg.commands = [];
  cfg.permissions.commands.allow = [
    {
      executable: process.execPath,
      argsPrefix: ["-e"],
      allowRemainingArgs: true,
    },
  ];
  const state = newState(cwd, "check", cfg, await baseline(cwd));
  let prompted = false;
  const evidence: CommandEvidence[] = [];
  const tool = commandTool(
    "tester",
    cfg,
    cwd,
    evidence,
    async () => {
      prompted = true;
      return "deny";
    },
    () => [],
    async (command, result) => {
      const verified = await recordVerifiedCommandResult(
        state,
        command,
        result,
        "tester",
        1,
      );
      if (verified) state.verifiedCommandResults.push(verified);
    },
  );
  const result = await tool.execute(
    "run",
    {
      executable: process.execPath,
      args: ["-e", "process.exit(1)"],
      purpose: "Run test",
      category: "test",
    },
    undefined,
    undefined,
    {} as any,
  );
  assert.equal((result.details as CommandEvidence).exitCode, 1);
  assert.equal(prompted, false);
  assert.equal(
    currentVerifiedCommandResults(
      state,
      await repositoryEvidenceState(state),
    )[0].exitCode,
    1,
  );
});

test("authorization QUESTION_REQUEST is repaired through team_command", async () => {
  const cwd = await repository();
  const cfg = config();
  cfg.commands = [];
  const state = newState(cwd, "check", cfg, await baseline(cwd));
  const request = {
    executable: process.execPath,
    args: ["-e", "process.stdout.write('pass')"],
    purpose: "Run required check",
    category: "test" as const,
  };
  let prompts = 0;
  let approvals = 0;
  const runner = new PiRunner();
  runner.createSession = async (
    role,
    _state,
    evidence,
    _activity,
    _network,
    _signal,
    _guard,
    _provider,
    _progress,
    runtimeApproval,
    _fileApproval,
    _mutations,
    onResult,
    onDenial,
  ) =>
    ({
      messages: [],
      prompt: async () => {
        prompts++;
        if (prompts === 2) {
          const tool = commandTool(
            role,
            cfg,
            cwd,
            evidence!,
            runtimeApproval,
            () => [],
            onResult,
            onDenial,
          );
          await tool.execute("run", request, undefined, undefined, {} as any);
        }
      },
      getLastAssistantText: () =>
        prompts === 1
          ? JSON.stringify({
              type: "QUESTION_REQUEST",
              blocking: true,
              question: "Which command ID is approved?",
              reason: "No command approval or verifiedCommandResults",
            })
          : JSON.stringify({ status: "PASS", commands: [], failedAreas: [] }),
      extensionRunner: { emit: async () => {} },
      dispose: () => {},
      abort: async () => {},
    }) as any;
  const result = (await runner.run(
    "tester",
    state,
    undefined,
    undefined,
    1,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    async () => {
      approvals++;
      return "allow";
    },
  )) as any;
  assert.equal(prompts, 2);
  assert.equal(approvals, 1);
  assert.equal(result.status, "PASS");
  assert.equal(result.commands[0].exitCode, 0);
});

test("Implementor checks claims cannot produce Tester PASS", async () => {
  const cwd = await repository();
  const cfg = config();
  cfg.commands = [];
  const state = newState(cwd, "check", cfg, await baseline(cwd));
  state.results.implementor = {
    status: "IMPLEMENTED",
    summary: "Claimed completion",
    changedFiles: [],
    checks: ["php artisan test tests/Unit/ConfigTest.php"],
  };
  const runner = new PiRunner();
  runner.createSession = async () =>
    ({
      messages: [],
      prompt: async () => {},
      getLastAssistantText: () =>
        JSON.stringify({ status: "PASS", commands: [], failedAreas: [] }),
      extensionRunner: { emit: async () => {} },
      dispose: () => {},
      abort: async () => {},
    }) as any;
  const result = await runner.run("tester", state);
  assert.equal(result.status, "BLOCKED");
  assert.match(result.reason ?? "", /no verified commands/);
});

test("HAPAK invocation from Code Reviewer does not contaminate repaired Tester PASS", async () => {
  const cwd = await repository();
  const cfg = config();
  cfg.commands = [];
  cfg.qualityGates.commit.enabled = false;
  const state = newState(cwd, "routing", cfg, await baseline(cwd));
  state.results.reviewer = contract;
  state.phase = "TEST";
  const commands = [
    normalizedRuntimeCommand(
      {
        executable: "npx",
        args: [
          "ng",
          "test",
          "--watch=false",
          "--include=projects/hapak/src/app/app.routes.spec.ts,projects/hapak/src/app/register-verify/register-verify.component.spec.ts",
        ],
        purpose: "Focused routing tests",
        category: "static",
      },
      "codeReviewer",
    ).command,
    normalizedRuntimeCommand(
      {
        executable: "npm",
        args: ["test"],
        purpose: "Full test suite",
        category: "test",
      },
      "tester",
    ).command,
    normalizedRuntimeCommand(
      {
        executable: "npx",
        args: ["tsc", "-p", "projects/hapak/tsconfig.spec.json", "--noEmit"],
        purpose: "Compile specs",
        category: "static",
      },
      "tester",
    ).command,
  ];
  for (const [index, output] of [
    "Error: No tests found matching the following patterns: Included: projects/hapak/src/app/app.routes.spec.ts,projects/hapak/src/app/register-verify/register-verify.component.spec.ts",
    "Test Files  4 passed (4)\nTests  47 passed (47)",
    "Compilation complete",
  ].entries()) {
    const verified = await recordVerifiedCommandResult(
      state,
      commands[index],
      {
        id: commands[index].id,
        exitCode: index === 0 ? 1 : 0,
        output,
        completedAt: `2026-01-01T00:00:0${index}Z`,
        sandbox,
      },
      index === 0 ? "codeReviewer" : "tester",
      1,
    );
    assert.ok(verified);
    state.verifiedCommandResults.push(verified);
  }
  assert.equal(
    classifyVerifiedCommand(state.verifiedCommandResults[0]).category,
    "INVOCATION_ERROR",
  );
  let prompts = 0;
  const repairs: string[] = [];
  const runner = new PiRunner();
  runner.createSession = async () =>
    ({
      messages: [],
      prompt: async () => {
        prompts++;
      },
      getLastAssistantText: () =>
        JSON.stringify(
          prompts === 1
            ? {
                status: "PASS",
                classification: "FIX_LOCAL",
                commands: [
                  { id: commands[0].id, exitCode: 1, output: "failed" },
                ],
                failedAreas: [],
              }
            : { status: "PASS", commands: [], failedAreas: [] },
        ),
      setActiveToolsByName: () => {},
      extensionRunner: { emit: async () => {} },
      dispose: () => {},
      abort: async () => {},
    }) as any;
  const result = await runner.run(
    "tester",
    state,
    undefined,
    undefined,
    1,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    (event) => repairs.push(event.type),
  );
  assert.equal(prompts, 2);
  assert.deepEqual(repairs, [
    "schema_repair_started",
    "schema_repair_succeeded",
  ]);
  assert.equal(result.status, "PASS");
  assert.equal(result.commands.length, 2);
  assert.equal(
    result.commands.some(
      (command: { id: string }) => command.id === commands[0].id,
    ),
    false,
  );
  state.results.tester = result;
  transition(state);
  assert.equal(state.phase, "REPORT");
  assert.equal(state.localFixCycle, 0);
});

test("unresolved invocation blocks while a genuine failure routes only with evidence", async () => {
  for (const [output, category, expected] of [
    [
      "No tests found matching the following patterns",
      "INVOCATION_ERROR",
      "BLOCKED",
    ],
    ["Tests: 2 failed, 45 passed", "TEST_FAILURE", "IMPLEMENT"],
  ] as const) {
    const cwd = await repository();
    const cfg = config();
    cfg.commands = [];
    cfg.qualityGates.commit.enabled = false;
    const state = newState(cwd, "routing", cfg, await baseline(cwd));
    state.results.reviewer = contract;
    state.phase = "TEST";
    const failing = normalizedRuntimeCommand(
      { executable: "npm", args: ["test"], purpose: "Tests", category: "test" },
      "tester",
    ).command;
    const unrelated = normalizedRuntimeCommand(
      {
        executable: "npx",
        args: ["tsc", "--noEmit"],
        purpose: "Types",
        category: "static",
      },
      "tester",
    ).command;
    for (const [command, exitCode, text] of [
      [failing, 1, output],
      [unrelated, 0, "Types passed"],
    ] as const) {
      const verified = await recordVerifiedCommandResult(
        state,
        command,
        { id: command.id, exitCode, output: text, sandbox },
        "tester",
        1,
      );
      assert.ok(verified);
      state.verifiedCommandResults.push(verified);
    }
    assert.equal(
      classifyVerifiedCommand(state.verifiedCommandResults[0]).category,
      category,
    );
    const runner = new PiRunner();
    runner.createSession = async () =>
      ({
        messages: [],
        prompt: async () => {},
        getLastAssistantText: () =>
          JSON.stringify({ status: "PASS", commands: [], failedAreas: [] }),
        extensionRunner: { emit: async () => {} },
        dispose: () => {},
        abort: async () => {},
      }) as any;
    const result = await runner.run("tester", state);
    assert.equal(
      result.status,
      category === "INVOCATION_ERROR" ? "BLOCKED" : "FAIL",
    );
    if (category === "TEST_FAILURE") {
      assert.deepEqual(result.failedAreas, [failing.id]);
      assert.match(result.reason ?? "", /Host-verified validation failed/);
    }
    state.results.tester = result;
    transition(state);
    assert.equal(state.phase, expected);
    assert.equal(state.localFixCycle, category === "TEST_FAILURE" ? 1 : 0);
  }
});

test("only a current full-suite run can supersede an Angular include invocation", async () => {
  const cwd = await repository();
  await writeFile(
    join(cwd, "package.json"),
    JSON.stringify({ scripts: { test: "ng test --watch=false" } }),
  );
  const state = newState(cwd, "routing", config(), await baseline(cwd));
  state.results.reviewer = contract;
  const command = normalizedRuntimeCommand(
    {
      executable: "npx",
      args: ["ng", "test", "--include=src/app/app.routes.spec.ts"],
      purpose: "Focused tests",
      category: "test",
    },
    "tester",
  ).command;
  const full = normalizedRuntimeCommand(
    {
      executable: "npm",
      args: ["test"],
      purpose: "All tests",
      category: "test",
    },
    "tester",
  ).command;
  const failed = await recordVerifiedCommandResult(
    state,
    command,
    {
      id: command.id,
      exitCode: 1,
      output: "No tests found matching the following patterns",
      completedAt: "2026-01-01T00:00:00Z",
      sandbox,
    },
    "tester",
    1,
  );
  const passed = await recordVerifiedCommandResult(
    state,
    full,
    {
      id: full.id,
      exitCode: 0,
      output: "Tests 47 passed",
      completedAt: "2026-01-01T00:00:01Z",
      sandbox,
    },
    "tester",
    1,
  );
  assert.ok(failed);
  assert.ok(passed);
  assert.equal(
    (await supersedingInvocation(failed, [passed], cwd))?.executionId,
    passed.executionId,
  );
  await writeFile(
    join(cwd, "package.json"),
    JSON.stringify({ scripts: { test: "ng test --include=other.spec.ts" } }),
  );
  assert.equal(await supersedingInvocation(failed, [passed], cwd), undefined);
  await writeFile(
    join(cwd, "package.json"),
    JSON.stringify({ scripts: { test: "ng test --watch=false" } }),
  );
  const unrelated = {
    ...passed,
    command: { ...passed.command, args: ["test", "--", "other.spec.ts"] },
  };
  assert.equal(
    await supersedingInvocation(failed, [unrelated], cwd),
    undefined,
  );
  state.verifiedCommandResults.push(failed, passed);
  await writeFile(
    join(cwd, "math.js"),
    "export const add = (a, b) => a + b;\n",
  );
  assert.deepEqual(
    currentVerifiedCommandResults(state, await repositoryEvidenceState(state)),
    [],
  );
});

test("a later exact rerun clears a genuine failure without deleting its record", async () => {
  const cwd = await repository();
  const cfg = config();
  cfg.commands = [];
  cfg.qualityGates.commit.enabled = false;
  const state = newState(cwd, "routing", cfg, await baseline(cwd));
  state.results.reviewer = contract;
  state.phase = "TEST";
  const command = normalizedRuntimeCommand(
    {
      executable: "npm",
      args: ["test"],
      purpose: "All tests",
      category: "test",
    },
    "tester",
  ).command;
  for (const [exitCode, output, completedAt] of [
    [1, "Tests: 2 failed, 45 passed", "2026-01-01T00:00:00Z"],
    [0, "Tests: 47 passed", "2026-01-01T00:00:01Z"],
  ] as const) {
    const result = await recordVerifiedCommandResult(
      state,
      command,
      { id: command.id, exitCode, output, completedAt, sandbox },
      "tester",
      1,
    );
    assert.ok(result);
    state.verifiedCommandResults.push(result);
  }
  assert.equal(state.verifiedCommandResults.length, 2);
  assert.equal(
    currentVerifiedCommandResults(
      state,
      await repositoryEvidenceState(state),
    )[0].exitCode,
    0,
  );
  const runner = new PiRunner();
  runner.createSession = async () =>
    ({
      messages: [],
      prompt: async () => {},
      getLastAssistantText: () =>
        JSON.stringify({ status: "PASS", commands: [], failedAreas: [] }),
      extensionRunner: { emit: async () => {} },
      dispose: () => {},
      abort: async () => {},
    }) as any;
  const result = await runner.run("tester", state);
  assert.equal(result.status, "PASS");
  state.results.tester = result;
  transition(state);
  assert.equal(state.phase, "REPORT");
  assert.equal(state.localFixCycle, 0);
});
