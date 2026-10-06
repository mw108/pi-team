import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { baseline } from "../src/workflow/git.ts";
import { newState } from "../src/workflow/state.ts";
import { contextFor } from "../src/agents/context.ts";
import {
  parseValidationHint,
  testerValidationContext,
} from "../src/agents/validation-context.ts";
import { commandTool } from "../src/agents/commands.ts";
import { testerCommandInstructions } from "../src/agents/runner.ts";
import { config, contract, repository } from "./helpers.ts";

test("incident context exposes three candidates and static policy without invented evidence", async () => {
  const cwd = await repository();
  const cfg = config();
  cfg.commands = [];
  cfg.permissions.commands.allow = [
    {
      executable: "php",
      argsPrefix: ["artisan", "test"],
      allowRemainingArgs: true,
    },
    {
      executable: "npm",
      argsPrefix: ["run", "unrelated"],
      allowRemainingArgs: false,
    },
  ];
  const state = newState(cwd, "check", cfg, await baseline(cwd));
  state.results.implementor = {
    status: "IMPLEMENTED",
    summary: "Claims",
    changedFiles: [],
    checks: [
      "php artisan test tests/Unit/ConfigTest.php",
      "php artisan test tests/Feature/API/V1/VerificationUrlTest.php",
      "php artisan test tests/Feature/API/V1/AuthControllerTest.php",
      "php artisan test Foo.php && rm -rf /",
    ],
  };
  const context = await contextFor("tester", state);
  assert.equal(context.candidateValidationCommands.length, 3);
  assert.deepEqual(context.approvedCommandIds, []);
  assert.deepEqual(context.verifiedCommandResults, undefined);
  assert.deepEqual(state.verifiedCommandResults, []);
  assert.equal(context.commandAuthorizationHints.length, 1);
  assert.equal(context.commandAuthorizationHints[0].source, "static");
  assert.deepEqual(context.commandAuthorizationHints[0].argsPrefix, [
    "artisan",
    "test",
  ]);
  assert.deepEqual(context.candidateValidationCommands[0], {
    executable: "php",
    args: ["artisan", "test", "tests/Unit/ConfigTest.php"],
    purpose: "Verify Implementor check",
    source: "implementor.checks",
  });
  assert.match(context.candidateValidationCommandList[0], /php artisan test/);
});

test("Reviewer exact command wins deduplication and unsafe hints are ignored", async () => {
  const cwd = await repository();
  const cfg = config();
  cfg.commands = [];
  const state = newState(cwd, "check", cfg, await baseline(cwd));
  state.results.reviewer = {
    ...contract,
    acceptanceCriteria: [],
    requiredTests: [
      {
        description: "php artisan test tests/Unit/ConfigTest.php",
        action: "existing",
      },
    ],
  };
  state.results.implementor = {
    status: "IMPLEMENTED",
    summary: "Claims",
    changedFiles: [],
    checks: ["php artisan test tests/Unit/ConfigTest.php"],
  };
  assert.deepEqual(
    testerValidationContext(state).candidateValidationCommands.map(
      (command) => command.source,
    ),
    ["reviewer.requiredTests"],
  );
  for (const unsafe of [
    "php artisan test Foo.php && rm -rf /",
    "php artisan test Foo.php;whoami",
    "php artisan test $(whoami)",
    "php artisan test `whoami`",
    "php artisan test Foo.php > out",
    "Run the unit tests",
    "php -r dangerousCode",
  ])
    assert.equal(parseValidationHint(unsafe), undefined);
});

test("Tester instructions and tool description rule out empty discovery", async () => {
  const prompt = await readFile(
    new URL("../templates/agents/tester.md", import.meta.url),
    "utf8",
  );
  assert.match(prompt, /checks\[\] are not proof/);
  assert.match(prompt, /may be used as candidate commands/);
  assert.match(prompt, /not command discovery/);
  assert.match(prompt, /team_command\(\{\}\) is invalid/);
  assert.match(
    testerCommandInstructions,
    /checks\[\] are not execution evidence/,
  );
  assert.match(testerCommandInstructions, /may be candidate commands/);
  assert.match(testerCommandInstructions, /does not discover or list/);
  assert.match(testerCommandInstructions, /team_command\(\{\}\) is invalid/);
  const cfg = config();
  const tool = commandTool("tester", cfg, "/tmp", []);
  assert.match(tool.description, /Execute one concrete command/);
  assert.match(tool.description, /does not list or discover commands/);
  assert.match(tool.description, /team_command\(\{\}\) is invalid/);
});
