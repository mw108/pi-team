import test from "node:test";
import assert from "node:assert/strict";
import { commandTool, type CommandEvidence } from "../src/agents/commands.ts";
import { commandOutcomeForLog } from "../src/agents/command-observability.ts";
import { providerRequestContext } from "../src/agents/request-context.ts";
import { contextFor } from "../src/agents/context.ts";
import { normalizedRuntimeCommand } from "../src/agents/runtime-commands.ts";
import { baseline } from "../src/workflow/git.ts";
import { newState } from "../src/workflow/state.ts";
import { config, repository } from "./helpers.ts";

const structured = {
  executable: process.execPath,
  args: ["-e", "process.exit(1)"],
  purpose: "Run required unit test",
};

test("effective team_command schema and provider request context stay flat", () => {
  const tool = commandTool("tester", config(), "/unused", []);
  const schema = JSON.parse(JSON.stringify(tool.parameters));
  assert.equal(schema.type, "object");
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(Object.keys(schema.properties).sort(), [
    "args",
    "category",
    "executable",
    "id",
    "purpose",
  ]);
  assert.equal(schema.properties.id.type, "string");
  assert.equal(schema.properties.executable.type, "string");
  assert.equal(schema.properties.args.type, "array");
  assert.equal(schema.properties.args.items.type, "string");
  assert.equal(schema.properties.purpose.type, "string");
  assert.deepEqual(schema.properties.category.enum, [
    "development",
    "test",
    "static",
    "pentest",
  ]);
  assert.equal(schema.required, undefined);
  for (const keyword of [
    "anyOf",
    "oneOf",
    "allOf",
    "dependentRequired",
    "if",
    "then",
    "else",
  ])
    assert.equal(JSON.stringify(schema).includes(`"${keyword}"`), false);
  assert.match(tool.description, /do not provide both forms/);
  assert.match(tool.description, /does not list or discover commands/);

  const projected = providerRequestContext(
    {
      systemPrompt: "Tester",
      messages: [],
      tools: [
        {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        },
      ],
    },
    "summary",
  );
  assert.deepEqual(projected.tools[0].parameters, schema);
});

test("ID and structured calls retain lookup, static authorization, and result evidence", async () => {
  const cwd = await repository();
  const cfg = config();
  const approved = {
    id: "detected-test",
    executable: process.execPath,
    args: ["-e", "process.stdout.write('id')"],
    purpose: "test" as const,
    timeoutMs: 30000,
  };
  cfg.commands = [];
  cfg.permissions.commands.allow = [
    {
      executable: process.execPath,
      argsPrefix: ["-e"],
      allowRemainingArgs: true,
    },
  ];
  const evidence: CommandEvidence[] = [];
  const observed: CommandEvidence[] = [];
  let approvals = 0;
  const tool = commandTool(
    "tester",
    cfg,
    cwd,
    evidence,
    async () => {
      approvals++;
      return "deny";
    },
    () => [approved],
    async (_command, result) => {
      observed.push(result);
    },
  );
  const byId = await tool.execute(
    "id",
    { id: "detected-test" },
    undefined,
    undefined,
    {} as any,
  );
  assert.equal((byId.details as CommandEvidence).id, "detected-test");
  assert.equal((byId.details as CommandEvidence).exitCode, 0);
  const byStructure = await tool.execute(
    "structured",
    structured,
    undefined,
    undefined,
    {} as any,
  );
  assert.equal((byStructure.details as CommandEvidence).exitCode, 1);
  assert.deepEqual((byStructure.details as any).authorization, {
    decision: "approved",
    source: "static",
  });
  assert.equal(approvals, 0);
  assert.deepEqual(observed, evidence);
  assert.deepEqual(
    evidence.map((result) => result.exitCode),
    [0, 1],
  );
});

test("empty, partial, blank, and mixed calls fail validation before approval or execution", async () => {
  const cfg = config();
  cfg.commands = [];
  const evidence: CommandEvidence[] = [];
  let approvals = 0;
  const tool = commandTool("tester", cfg, "/unused", evidence, async () => {
    approvals++;
    return "allow";
  });
  for (const [input, expected] of [
    [{}, /requires either id or executable \+ args \+ purpose/],
    [{ executable: "php" }, /Missing or invalid: args, purpose/],
    [{ args: ["artisan", "test"] }, /Missing or invalid: executable, purpose/],
    [{ purpose: "run tests" }, /Missing or invalid: executable, args/],
    [{ executable: "php", args: [] }, /Missing or invalid: purpose/],
    [{ id: "" }, /id must be a non-empty string/],
    [{ executable: "", args: [], purpose: "" }, /executable, purpose/],
    [{ id: "detected-test", ...structured }, /Do not provide both forms/],
  ] as const) {
    await assert.rejects(
      () => tool.execute("invalid", input, undefined, undefined, {} as any),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, expected);
        const logged = commandOutcomeForLog(
          { content: [{ type: "text", text: error.message }] },
          true,
        );
        assert.equal(logged.error?.category, "validation");
        assert.equal(logged.processStarted, false);
        return true;
      },
    );
  }
  assert.equal(approvals, 0);
  assert.deepEqual(evidence, []);
});

test("structured calls still require runtime approval and enforce hard-deny rules", async () => {
  const cfg = config();
  cfg.commands = [];
  const evidence: CommandEvidence[] = [];
  let approvals = 0;
  const tool = commandTool("tester", cfg, "/unused", evidence, async () => {
    approvals++;
    return "deny";
  });
  const denied = await tool.execute(
    "runtime",
    structured,
    undefined,
    undefined,
    {} as any,
  );
  assert.equal((denied.details as any).code, "COMMAND_APPROVAL_DENIED");
  assert.equal(approvals, 1);
  await assert.rejects(
    () =>
      tool.execute(
        "hard-deny",
        { ...structured, executable: "bash" },
        undefined,
        undefined,
        {} as any,
      ),
    /Invalid team_command arguments/,
  );
  assert.equal(approvals, 1);
  assert.deepEqual(evidence, []);
});

test("Tester candidate becomes a structured tool call with exact executable and args", async () => {
  const cwd = await repository();
  const cfg = config();
  cfg.commands = [];
  cfg.permissions.commands.allow = [
    {
      executable: "php",
      argsPrefix: ["artisan", "test"],
      allowRemainingArgs: true,
    },
  ];
  const state = newState(cwd, "check", cfg, await baseline(cwd));
  state.results.implementor = {
    status: "IMPLEMENTED",
    summary: "Ready for validation",
    changedFiles: [],
    checks: ["php artisan test tests/Unit/ConfigTest.php"],
  };
  const context = await contextFor("tester", state);
  const candidate = context.candidateValidationCommands[0];
  assert.deepEqual(candidate.args, [
    "artisan",
    "test",
    "tests/Unit/ConfigTest.php",
  ]);
  assert.deepEqual(context.commandAuthorizationHints[0].argsPrefix, [
    "artisan",
    "test",
  ]);
  const mockAssistantResponse = {
    name: "team_command",
    arguments: {
      executable: candidate.executable,
      args: candidate.args,
      purpose: "Run required unit test",
    },
  };
  let requested: { executable: string; args: string[] } | undefined;
  const tool = commandTool(
    "tester",
    {
      ...cfg,
      permissions: {
        ...cfg.permissions,
        commands: { allow: [] },
      },
    },
    cwd,
    [],
    async (command) => {
      requested = command;
      return "deny";
    },
  );
  const result = await tool.execute(
    "candidate",
    mockAssistantResponse.arguments,
    undefined,
    undefined,
    {} as any,
  );
  assert.equal((result.details as any).code, "COMMAND_APPROVAL_DENIED");
  assert.deepEqual(
    requested,
    normalizedRuntimeCommand(mockAssistantResponse.arguments, "tester").command,
  );
});
