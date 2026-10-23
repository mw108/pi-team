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
  directStaticValidatorIdentity,
  directTestRunnerIdentity,
  isVerifiedCommandResultCurrent,
  recordVerifiedCommandResult,
  repositoryEvidenceState,
  resolveEffectiveValidationIdentity,
  resolveStaticValidatorIdentity,
  supersedingInvocation,
  validationFailureFingerprint,
  type ValidatorIdentity,
  type VerifiedCommandResult,
} from "../src/workflow/verified-commands.ts";
import { recordCommandPurposeMismatch } from "../src/workflow/command-purpose-mismatch.ts";
import { config, contract, repository } from "./helpers.ts";

const sandbox = {
  mode: "none" as const,
  network: "host" as const,
  temporaryHome: true,
  filesystemIsolation: false,
};

function classifiedResult(
  executable: string,
  args: string[],
  purpose: "test" | "static",
  exitCode: number,
  output: string,
  validatorIdentity?: ValidatorIdentity,
): VerifiedCommandResult {
  return {
    executionId: "00000000-0000-4000-8000-000000000001",
    command: { id: "classified", executable, args, purpose },
    commandIdentity: commandKey({ executable, args }),
    ...(validatorIdentity ? { validatorIdentity } : {}),
    agent: "tester",
    attempt: 1,
    exitCode,
    output,
    completedAt: "2026-10-23T00:00:00.000Z",
    repoState: { head: "head", gateHashes: {} },
  };
}

test("Laravel Pint check results are classified as static formatting outcomes", () => {
  for (const [executable, args] of [
    ["vendor/bin/pint", ["--test"]],
    ["php", ["vendor/bin/pint", "--test", "app/Models/User.php"]],
    ["php", ["vendor\\bin\\pint", "--test"]],
  ] as const) {
    const failed = classifyVerifiedCommand(
      classifiedResult(
        executable,
        [...args],
        "static",
        1,
        "\u001b[31mFAIL\u001b[39m — 66 files, 24 style issues\napp\\Models\\User.php ordered_traits ordered_imports single_blank_line_at_eof",
      ),
    );
    assert.equal(failed.category, "STATIC_FORMAT_FAILURE");
    assert.equal(failed.validationType, "STATIC");
    assert.equal(failed.validatorIdentity.tool, "LARAVEL_PINT");
    assert.equal(failed.recoverable, true);
  }
  assert.deepEqual(
    classifyVerifiedCommand(
      classifiedResult(
        "php",
        ["vendor/bin/pint", "--test"],
        "static",
        0,
        "PASS — 4 files",
      ),
    ),
    {
      category: "PASS",
      validationType: "STATIC",
      validatorIdentity: {
        tool: "LARAVEL_PINT",
        source: "interpreter",
      },
      reason: "Command completed successfully",
      recoverable: false,
    },
  );
});

test("verified tool identity overrides contradictory declared purpose", () => {
  const pint = classifyVerifiedCommand(
    classifiedResult(
      "php",
      [
        "vendor/bin/pint",
        "--test",
        "bootstrap/app.php",
        "routes/api.php",
        "app/Http/Requests/API/V1/LoginRequest.php",
        "app/Models/Client.php",
      ],
      "test",
      1,
      "FAIL — 4 files, 3 style issues\n\napp\\Http\\Requests\\API\\V1\\LoginRequest.php\n    single_blank_line_at_eof\n\nbootstrap\\app.php\n    ordered_imports\n\nroutes\\api.php\n    ordered_imports",
    ),
  );
  assert.equal(pint.validationType, "STATIC");
  assert.equal(pint.validatorIdentity.tool, "LARAVEL_PINT");
  assert.equal(pint.category, "STATIC_FORMAT_FAILURE");
  assert.equal(pint.recoverable, true);
  assert.deepEqual(pint.purposeMismatch, {
    declaredPurpose: "test",
    effectiveValidationType: "STATIC",
    detectedTool: "LARAVEL_PINT",
    source: "interpreter",
  });

  for (const command of [
    classifiedResult(
      "php",
      ["artisan", "test", "--no-coverage"],
      "static",
      0,
      "Tests: 61 passed (334 assertions)",
    ),
    classifiedResult(
      "php",
      ["vendor\\bin\\phpunit"],
      "static",
      0,
      "OK (61 tests, 334 assertions)",
    ),
  ]) {
    const phpunit = classifyVerifiedCommand(command);
    assert.equal(phpunit.validationType, "TEST");
    assert.equal(phpunit.category, "PASS");
    assert.deepEqual(phpunit.purposeMismatch, {
      declaredPurpose: "static",
      effectiveValidationType: "TEST",
      detectedTool: "PHPUNIT",
      source: "interpreter",
    });
  }
});

test("purpose mismatch diagnostic is structured, deduplicated, and failure-neutral", async () => {
  const cwd = await repository();
  const state = newState(
    cwd,
    "purpose mismatch",
    config(),
    await baseline(cwd),
  );
  const result = classifiedResult(
    "php",
    ["vendor/bin/pint", "--test"],
    "test",
    1,
    "FAIL — 4 files, 3 style issues",
  );
  const outcome = classifyVerifiedCommand(result);
  const restoredLegacy = validateState({
    ...state,
    verifiedCommandResults: [result],
  });
  assert.equal(
    classifyVerifiedCommand(restoredLegacy.verifiedCommandResults[0]).category,
    "STATIC_FORMAT_FAILURE",
  );
  const failures = state.agentFailures;
  assert.equal(recordCommandPurposeMismatch(state, result, outcome), true);
  assert.equal(recordCommandPurposeMismatch(state, result, outcome), false);
  assert.equal(state.agentFailures, failures);
  const events = state.history.filter(
    (entry) => entry.event === "command_purpose_mismatch",
  );
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].meta, {
    agent: "tester",
    attempt: 1,
    commandId: "classified",
    executionId: result.executionId,
    declaredPurpose: "test",
    effectiveValidationType: "STATIC",
    detectedTool: "LARAVEL_PINT",
    validatorSource: "interpreter",
    resolution: "verified_command_identity",
  });
  assert.equal(
    state.history.some((entry) => entry.event === "agent_attempt_failed"),
    false,
  );
});

test("Pint startup failures and incomplete reports remain indeterminate", () => {
  for (const output of [
    "PHP Fatal error: bootstrap crashed",
    "app/Models/User.php ordered_imports\n[output truncated]",
  ])
    assert.equal(
      classifyVerifiedCommand(
        classifiedResult(
          "php",
          ["vendor/bin/pint", "--test"],
          "static",
          1,
          output,
        ),
      ).category,
      "INDETERMINATE",
    );
  assert.equal(
    classifyVerifiedCommand(
      classifiedResult(
        "php",
        ["vendor/bin/pint", "--bad-option"],
        "static",
        1,
        "The option --bad-option does not exist",
      ),
    ).category,
    "INVOCATION_ERROR",
  );
});

test("recognized static analyzers are failures, while unknown nonzero static output is indeterminate", () => {
  for (const [executable, args, output, expected] of [
    [
      "npx",
      ["prettier", "--check", "."],
      "[warn] Code style issues found in 2 files.",
      "STATIC_FORMAT_FAILURE",
    ],
    [
      "vendor/bin/php-cs-fixer",
      ["fix", "--dry-run"],
      "Found 2 of 20 files that can be fixed in 0.1 seconds",
      "STATIC_FORMAT_FAILURE",
    ],
    [
      "npx",
      ["eslint", "."],
      "✖ 5 problems (3 errors, 2 warnings)",
      "STATIC_ANALYSIS_FAILURE",
    ],
    [
      "npx",
      ["tsc", "--noEmit"],
      "src/a.ts(1,1): error TS2322: bad",
      "STATIC_ANALYSIS_FAILURE",
    ],
    [
      "vendor/bin/phpstan",
      ["analyse"],
      "PHPStan\n[ERROR] Found 3 errors",
      "STATIC_ANALYSIS_FAILURE",
    ],
    [
      "vendor/bin/psalm",
      [],
      "Psalm\nERRORS! 2 errors found",
      "STATIC_ANALYSIS_FAILURE",
    ],
  ] as const)
    assert.equal(
      classifyVerifiedCommand(
        classifiedResult(executable, [...args], "static", 1, output),
      ).category,
      expected,
    );
  assert.equal(
    classifyVerifiedCommand(
      classifiedResult("custom-lint", [], "static", 2, "validation stopped"),
    ).category,
    "INDETERMINATE",
  );
});

test("static validator identity comes from argv, including trusted interpreter targets", () => {
  for (const [executable, args, tool, source] of [
    ["vendor/bin/pint", ["--test"], "LARAVEL_PINT", "direct"],
    [
      "php",
      ["vendor/bin/php-cs-fixer", "fix", "--dry-run"],
      "PHP_CS_FIXER",
      "interpreter",
    ],
    ["php", ["vendor\\bin\\phpstan", "analyse"], "PHPSTAN", "interpreter"],
    ["php", ["vendor/bin/psalm"], "PSALM", "interpreter"],
    ["npx.cmd", ["eslint", "src"], "ESLINT", "interpreter"],
    ["npx", ["prettier", "--check", "."], "PRETTIER", "interpreter"],
    ["tsc.cmd", ["--noEmit"], "TYPESCRIPT", "direct"],
    [
      "node.exe",
      ["node_modules\\typescript\\bin\\tsc", "--noEmit"],
      "TYPESCRIPT",
      "interpreter",
    ],
  ] as const) {
    assert.deepEqual(
      directStaticValidatorIdentity({ executable, args: [...args] }),
      {
        tool,
        source,
      },
    );
  }
  assert.equal(
    directStaticValidatorIdentity({
      executable: "php",
      args: ["tools/pint", "--test"],
    }),
    undefined,
  );
  assert.deepEqual(
    directTestRunnerIdentity({
      executable: "php",
      args: ["artisan", "test"],
    }),
    { validationType: "TEST", tool: "PHPUNIT", source: "interpreter" },
  );
});

test("diagnostic-looking output cannot establish or override validator identity", () => {
  for (const [executable, args, output] of [
    ["echo", ["error TS2339"], "error TS2339: fixture"],
    ["php", ["artisan", "route:list"], "error TS2339: fixture"],
    ["node", ["print-log.js"], "PHPStan\n[ERROR] Found 3 errors"],
    ["node", ["print-log.js"], "FAIL — 2 files, 2 style issues"],
    ["node", ["print-log.js"], "✖ 5 problems (3 errors, 2 warnings)"],
  ] as const) {
    const outcome = classifyVerifiedCommand(
      classifiedResult(executable, [...args], "static", 1, output),
    );
    assert.equal(outcome.validatorIdentity.tool, "UNKNOWN");
    assert.equal(outcome.category, "INDETERMINATE");
  }
  const conflicting = classifyVerifiedCommand(
    classifiedResult(
      "npx",
      ["eslint", "src"],
      "static",
      1,
      "FAIL — 2 files, 2 style issues",
    ),
  );
  assert.equal(conflicting.validatorIdentity.tool, "ESLINT");
  assert.equal(conflicting.category, "INDETERMINATE");
});

test("package-manager validator identity uses project script definitions and preserves ambiguity", async () => {
  const cwd = await repository();
  await writeFile(
    join(cwd, "package.json"),
    JSON.stringify({
      type: "module",
      scripts: {
        lint: "eslint src",
        typecheck: "tsc --noEmit",
        "format-check": "prettier --check .",
        logs: "node print-log.js",
        composite: "tsc --noEmit && eslint src",
      },
    }),
  );
  await writeFile(
    join(cwd, "composer.json"),
    JSON.stringify({
      scripts: {
        analyse: "@php vendor/bin/phpstan analyse",
        "format-check": "@php vendor/bin/pint --test",
        test: "@php artisan test",
      },
    }),
  );
  for (const [executable, args, tool] of [
    ["npm", ["run", "lint"], "ESLINT"],
    ["npm", ["run", "typecheck"], "TYPESCRIPT"],
    ["npm", ["run", "format-check"], "PRETTIER"],
    ["composer", ["run", "analyse"], "PHPSTAN"],
    ["composer", ["run", "format-check"], "LARAVEL_PINT"],
  ] as const) {
    assert.deepEqual(
      await resolveStaticValidatorIdentity(
        { executable, args: [...args], purpose: "static" },
        cwd,
      ),
      {
        tool,
        source: "package_script",
        scriptName: args[1],
      },
    );
  }
  assert.deepEqual(
    await resolveStaticValidatorIdentity(
      { executable: "npm", args: ["run", "logs"], purpose: "static" },
      cwd,
    ),
    { tool: "UNKNOWN", source: "package_script", scriptName: "logs" },
  );
  assert.deepEqual(
    await resolveStaticValidatorIdentity(
      {
        executable: "npm",
        args: ["run", "composite"],
        purpose: "static",
      },
      cwd,
    ),
    {
      tool: "COMPOSITE",
      source: "package_script",
      scriptName: "composite",
      underlyingTools: ["TYPESCRIPT", "ESLINT"],
    },
  );
  assert.deepEqual(
    await resolveEffectiveValidationIdentity(
      { executable: "composer", args: ["run", "test"], purpose: "static" },
      cwd,
    ),
    {
      validationType: "TEST",
      tool: "PHPUNIT",
      source: "package_script",
      scriptName: "test",
    },
  );
  assert.deepEqual(
    await resolveEffectiveValidationIdentity(
      { executable: "npm", args: ["run", "lint"], purpose: "test" },
      cwd,
    ),
    {
      validationType: "STATIC",
      tool: "ESLINT",
      source: "package_script",
      scriptName: "lint",
    },
  );

  const state = newState(
    cwd,
    "wrapper classification",
    config(),
    await baseline(cwd),
  );
  const wrappedPhpunit = await recordVerifiedCommandResult(
    state,
    {
      id: "wrapped-phpunit",
      executable: "composer",
      args: ["run", "test"],
      purpose: "static",
      timeoutMs: 1000,
    },
    {
      id: "wrapped-phpunit",
      exitCode: 0,
      output: "Tests: 61 passed (334 assertions)",
      sandbox,
    },
    "tester",
    1,
  );
  assert.ok(wrappedPhpunit);
  assert.equal(
    wrappedPhpunit.effectiveValidationIdentity?.validationType,
    "TEST",
  );
  assert.equal(classifyVerifiedCommand(wrappedPhpunit).validationType, "TEST");
  assert.equal(
    classifyVerifiedCommand(wrappedPhpunit).purposeMismatch?.detectedTool,
    "PHPUNIT",
  );
  const restored = validateState({
    ...state,
    verifiedCommandResults: [wrappedPhpunit],
  });
  assert.equal(
    classifyVerifiedCommand(restored.verifiedCommandResults[0]).validationType,
    "TEST",
  );

  const wrappedEslint = await recordVerifiedCommandResult(
    state,
    {
      id: "wrapped-eslint",
      executable: "npm",
      args: ["run", "lint"],
      purpose: "test",
      timeoutMs: 1000,
    },
    {
      id: "wrapped-eslint",
      exitCode: 1,
      output: "✖ 5 problems (3 errors, 2 warnings)",
      sandbox,
    },
    "tester",
    1,
  );
  assert.ok(wrappedEslint);
  assert.equal(
    classifyVerifiedCommand(wrappedEslint).category,
    "STATIC_ANALYSIS_FAILURE",
  );
  for (const [id, executable, args, output, expectedTool, expectedOutcome] of [
    [
      "wrapped-typecheck",
      "npm",
      ["run", "typecheck"],
      "src/a.ts(1,1): error TS2339: fixture",
      "TYPESCRIPT",
      "STATIC_ANALYSIS_FAILURE",
    ],
    [
      "wrapped-pint",
      "composer",
      ["run", "format-check"],
      "FAIL — 2 files, 2 style issues",
      "LARAVEL_PINT",
      "STATIC_FORMAT_FAILURE",
    ],
  ] as const) {
    const verified = await recordVerifiedCommandResult(
      state,
      { id, executable, args: [...args], purpose: "static", timeoutMs: 1000 },
      { id, exitCode: 1, output, sandbox },
      "tester",
      1,
    );
    assert.ok(verified);
    assert.equal(verified.validatorIdentity?.tool, expectedTool);
    assert.equal(classifyVerifiedCommand(verified).category, expectedOutcome);
  }
});

test("failure fingerprints include authoritative validator identity", () => {
  const typescript = classifiedResult(
    "npm",
    ["run", "check"],
    "static",
    1,
    "error TS2339: fixture",
    { tool: "TYPESCRIPT", source: "package_script", scriptName: "check" },
  );
  const unknown = {
    ...typescript,
    validatorIdentity: {
      tool: "UNKNOWN" as const,
      source: "package_script" as const,
      scriptName: "check",
    },
  };
  const classified = classifyVerifiedCommand(typescript);
  assert.equal(classified.category, "STATIC_ANALYSIS_FAILURE");
  assert.notEqual(
    validationFailureFingerprint([{ item: typescript, outcome: classified }]),
    validationFailureFingerprint([
      { item: unknown, outcome: classifyVerifiedCommand(unknown) },
    ]),
  );
});

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

test("Tester sees Implementor evidence as context but reruns configured checks for its own gate", async () => {
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
  assert.equal(input.verifiedCommandResults[0].agent, "tester");
  assert.equal(await readFile(countPath, "utf8"), "xx");
  await writeFile(
    join(cwd, "math.js"),
    "export const add = (a, b) => a + b;\n",
  );
  const rerun = (await runner.run("tester", loaded)) as any;
  assert.equal(rerun.status, "PASS");
  assert.equal(await readFile(countPath, "utf8"), "xxx");
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
    "json_repair_started",
    "json_repair_failed",
    "ai_json_repair_started",
    "ai_json_repair_failed",
    "local_json_repair_exhausted",
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

test("PHPUnit pass plus purpose-mismatched Pint findings routes FIX_LOCAL", async () => {
  const cwd = await repository();
  const cfg = config();
  cfg.commands = [];
  cfg.qualityGates.commit.enabled = false;
  const state = newState(cwd, "routing", cfg, await baseline(cwd));
  const initialFullCycle = state.fullCycle;
  state.results.reviewer = contract;
  state.phase = "TEST";
  const phpunit = normalizedRuntimeCommand(
    {
      executable: "php",
      args: ["artisan", "test", "--no-coverage"],
      purpose: "Run Laravel tests",
      category: "test",
    },
    "tester",
  ).command;
  const pint = normalizedRuntimeCommand(
    {
      executable: "php",
      args: [
        "vendor/bin/pint",
        "--test",
        "bootstrap/app.php",
        "routes/api.php",
        "app/Http/Requests/API/V1/LoginRequest.php",
        "app/Models/Client.php",
      ],
      purpose: "Check formatting",
      category: "test",
    },
    "tester",
  ).command;
  assert.equal(pint.id, "detected-2da0f219accf");
  for (const [command, exitCode, output] of [
    [phpunit, 0, "Tests: 61 passed (334 assertions)"],
    [
      pint,
      1,
      "FAIL — 4 files, 3 style issues\n\napp\\Http\\Requests\\API\\V1\\LoginRequest.php\n    single_blank_line_at_eof\n\nbootstrap\\app.php\n    ordered_imports\n\nroutes\\api.php\n    ordered_imports",
    ],
  ] as const) {
    const verified = await recordVerifiedCommandResult(
      state,
      command,
      { id: command.id, exitCode, output, sandbox },
      "tester",
      1,
    );
    assert.ok(verified);
    state.verifiedCommandResults.push(verified);
  }
  const runner = new PiRunner();
  runner.createSession = async () =>
    ({
      messages: [],
      prompt: async () => {},
      getLastAssistantText: () =>
        JSON.stringify({
          status: "BLOCKED",
          reason: "Nonzero command",
          commands: [],
          failedAreas: [],
        }),
      extensionRunner: { emit: async () => {} },
      dispose: () => {},
      abort: async () => {},
    }) as any;
  const result = (await runner.run("tester", state)) as any;
  assert.equal(result.status, "FAIL");
  assert.equal(result.classification, "FIX_LOCAL");
  assert.deepEqual(result.failedAreas, [pint.id]);
  assert.deepEqual(
    result.validationOutcomes.map((outcome: any) => [
      outcome.validationType,
      outcome.validator,
      outcome.outcome,
    ]),
    [
      ["TEST", "UNKNOWN", "PASS"],
      ["STATIC", "LARAVEL_PINT", "STATIC_FORMAT_FAILURE"],
    ],
  );
  assert.match(result.reason, /Functional tests: PASS/);
  assert.match(result.reason, /Static validation: FAIL/);
  assert.match(result.failureFingerprint, /^[a-f0-9]{64}$/);
  assert.equal(pint.purpose, "test");
  assert.equal(
    state.history.filter(
      (entry) =>
        entry.event === "command_purpose_mismatch" &&
        entry.meta?.commandId === pint.id,
    ).length,
    1,
  );

  state.results.tester = result;
  transition(state);
  assert.equal(state.phase, "IMPLEMENT");
  assert.equal(state.localFixCycle, 1);
  assert.equal(state.fullCycle, initialFullCycle);
  assert.equal(state.results.previous_tester?.status, "FAIL");

  state.phase = "TEST";
  state.results.tester = structuredClone(result);
  transition(state);
  assert.equal(state.phase, "BLOCKED");
  assert.match(state.blocker ?? "", /same findings after a local fix attempt/);
  assert.equal(state.localFixCycle, 1);
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
