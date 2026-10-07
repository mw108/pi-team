import { test } from "node:test";
import assert from "node:assert/strict";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { parseTextualToolCall } from "../src/agents/textual-tool-call.ts";
import { recoverTextualToolCallMessage } from "../src/agents/runner.ts";
import { normalizedResponseForLog } from "../src/agents/normalized-response.ts";
import {
  ToolUseGuard,
  resolveDoomLoop,
  toolSignature,
} from "../src/agents/doom-loop.ts";
import { config, output } from "./helpers.ts";
import { repository } from "./helpers.ts";
import { commandTool, type CommandEvidence } from "../src/agents/commands.ts";
import { recordVerifiedCommandResult } from "../src/workflow/verified-commands.ts";
import { newState } from "../src/workflow/state.ts";
import { baseline } from "../src/workflow/git.ts";

const incident = `<tool_call>
<function=team_command>
<parameter=executable>
ng
</parameter>
<parameter=args>
["test", "--include=**/register-verify.component.spec.ts"]
</parameter>
<parameter=purpose>
Run the register-verify component unit tests using Angular CLI
</parameter>
</function>
</tool_call>`;

function assistant(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: "fixture",
    model: "fixture",
    stopReason: "stop",
    timestamp: 0,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}

test("real incident becomes a typed native tool call", () => {
  const call = parseTextualToolCall(incident);
  assert.deepEqual(call, {
    name: "team_command",
    arguments: {
      executable: "ng",
      args: ["test", "--include=**/register-verify.component.spec.ts"],
      purpose: "Run the register-verify component unit tests using Angular CLI",
    },
  });
  const recovered = recoverTextualToolCallMessage(
    "implementor",
    assistant(incident),
  );
  assert.equal(recovered?.tool, "team_command");
  assert.deepEqual(recovered?.message.content.at(-1), {
    type: "toolCall",
    id: (recovered?.message.content.at(-1) as { id: string }).id,
    name: "team_command",
    arguments: call?.arguments,
  });
  assert.deepEqual(recovered?.message.content[0], {
    type: "text",
    text: incident,
  });
});

test("parameter JSON values retain types and multiline plain text", () => {
  const call = parseTextualToolCall(
    `<tool_call>\r\n<function=tool.test>\r\n<parameter=args>["a\\\"b"]</parameter>\r\n<parameter=flag>true</parameter>\r\n<parameter=count>12</parameter>\r\n<parameter=data>{"bar":1}</parameter>\r\n<parameter=content>\r\nline one\r\nline two\r\n</parameter>\r\n<parameter=empty></parameter>\r\n</function>\r\n</tool_call>`,
  );
  assert.deepEqual(call, {
    name: "tool.test",
    arguments: {
      args: ['a"b'],
      flag: true,
      count: 12,
      data: { bar: 1 },
      content: "line one\r\nline two",
      empty: "",
    },
  });
  assert.deepEqual(
    parseTextualToolCall(`\n\n  ${incident}  \n`),
    parseTextualToolCall(incident),
  );
});

test("malformed, mixed, duplicate, nested, and multiple calls stay invalid", () => {
  const invalid = [
    `I'll run this.\n${incident}`,
    `${incident}\nDone.`,
    `foo ${incident} bar`,
    `${incident}\n${incident}`,
    incident.slice(0, -"</tool_call>".length),
    `<tool_call><function=team_command><parameter=purpose>a</parameter><parameter=purpose>b</parameter></function></tool_call>`,
    `<tool_call><function=team_command><parameter=purpose>a</function></tool_call>`,
    `<tool_call><function=team_command><parameter=x><parameter=y>v</parameter></parameter></function></tool_call>`,
    `<tool_call><function=team_command></function><function=team_command></function></tool_call>`,
    `<tool_call>outside<function=team_command></function></tool_call>`,
    `<tool_call><function=bad!></function></tool_call>`,
    `<tool_call><function=team_command><unknown/></function></tool_call>`,
    `<tool_call><function=team_command><parameter=content><unknown</parameter></function></tool_call>`,
  ];
  for (const text of invalid) {
    assert.equal(parseTextualToolCall(text), null, text);
    assert.equal(
      recoverTextualToolCallMessage("implementor", assistant(text)),
      null,
    );
  }
});

test("valid JSON, schema-invalid JSON, and native calls take precedence", () => {
  assert.equal(
    recoverTextualToolCallMessage(
      "implementor",
      assistant(JSON.stringify(output("implementor"))),
    ),
    null,
  );
  assert.equal(
    recoverTextualToolCallMessage(
      "implementor",
      assistant(JSON.stringify({ wrong: incident })),
    ),
    null,
  );
  const native = assistant(incident);
  native.content.push({
    type: "toolCall",
    id: "native",
    name: "read",
    arguments: { path: "a" },
  });
  assert.equal(recoverTextualToolCallMessage("implementor", native), null);
  assert.equal(
    recoverTextualToolCallMessage("implementor", assistant("not json")),
    null,
  );
});

test("textual parameters with sensitive names are redacted in response logs", () => {
  const text = `<tool_call><function=team_command><parameter=token>private-value</parameter></function></tool_call>`;
  const logged = normalizedResponseForLog(assistant(text), 3);
  assert.doesNotMatch(JSON.stringify(logged), /private-value/);
  assert.match(JSON.stringify(logged), /\[REDACTED\]/);
});

test("recovered calls use the ordinary tool budget and Doom Loop signature", async () => {
  const messages: string[] = [];
  const guard = new ToolUseGuard(
    resolveDoomLoop(config(), "implementor"),
    1,
    () => ({
      async steer(text: string) {
        messages.push(text);
      },
      setActiveToolsByName() {},
    }),
  );
  const first = recoverTextualToolCallMessage(
    "implementor",
    assistant(incident),
  )!.message.content.at(-1)!;
  const second = recoverTextualToolCallMessage(
    "implementor",
    assistant(incident),
  )!.message.content.at(-1)!;
  assert.equal(first.type, "toolCall");
  assert.equal(second.type, "toolCall");
  if (first.type !== "toolCall" || second.type !== "toolCall") return;
  assert.equal(
    toolSignature(first.name, first.arguments),
    toolSignature(second.name, second.arguments),
  );
  await guard.start(first.id, first.name, first.arguments);
  assert.equal(
    await guard.call(first.name, first.arguments, false, first.id),
    undefined,
  );
  await guard.complete(first.id, true);
  await guard.start(second.id, second.name, second.arguments);
  assert.equal(
    (await guard.call(second.name, second.arguments, false, second.id))?.block,
    true,
  );
  assert.equal(guard.toolCalls, 2);
  assert.equal(guard.toolsDisabledForFinalization, true);
  assert.equal(messages.length, 1);
});

test("recovered arguments use existing command approval, pending, and denial rules", async () => {
  const cwd = await repository();
  const cfg = config();
  const state = newState(cwd, "task", cfg, await baseline(cwd));
  const evidence: CommandEvidence[] = [];
  const approved = parseTextualToolCall(
    `<tool_call><function=team_command><parameter=executable>${process.execPath}</parameter><parameter=args>["--test","tests/math.test.mjs"]</parameter><parameter=purpose>Run tests</parameter></function></tool_call>`,
  )!;
  let approvalRequests = 0;
  const tool = commandTool(
    "implementor",
    cfg,
    cwd,
    evidence,
    async () => {
      approvalRequests++;
      return "pending";
    },
    undefined,
    async (command, result) => {
      const verified = await recordVerifiedCommandResult(
        state,
        command,
        result,
        "implementor",
        1,
      );
      if (verified) state.verifiedCommandResults.push(verified);
    },
  );
  const completed = await tool.execute(
    "approved",
    approved.arguments,
    undefined,
    undefined,
    {} as any,
  );
  assert.equal(approvalRequests, 0);
  assert.equal(
    (completed.details as { exitCode: number }).exitCode,
    evidence[0].exitCode,
  );
  assert.equal(evidence.length, 1);
  assert.equal(state.verifiedCommandResults.length, 1);
  const unapproved = parseTextualToolCall(
    `<tool_call><function=team_command><parameter=executable>${process.execPath}</parameter><parameter=args>["--version"]</parameter><parameter=purpose>Check Node version</parameter></function></tool_call>`,
  )!;
  const pending = await tool.execute(
    "pending",
    unapproved.arguments,
    undefined,
    undefined,
    {} as any,
  );
  assert.equal(approvalRequests, 1);
  assert.equal((pending.details as { status: string }).status, "pending");
  assert.equal(evidence.length, 1);
  const deniedTool = commandTool(
    "implementor",
    cfg,
    cwd,
    evidence,
    async () => "deny",
  );
  const denied = await deniedTool.execute(
    "denied",
    unapproved.arguments,
    undefined,
    undefined,
    {} as any,
  );
  assert.equal((denied.details as { status: string }).status, "denied");
  assert.equal(evidence.length, 1);
});
