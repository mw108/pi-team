import { test } from "node:test";
import assert from "node:assert/strict";
import {
  getErrorMessage,
  formatErrorForUser,
  formatErrorForPiNotification,
} from "../src/agents/error-message.ts";
import { AgentDoomLoopError } from "../src/agents/errors.ts";
import { repository, config, FixtureRunner } from "./helpers.ts";
import { WorkflowEngine } from "../src/workflow/engine.ts";
import teamExtension from "../src/index.ts";

test("error display uses message once and retains typed errors", () => {
  assert.equal(`Error: ${getErrorMessage(new Error("foo"))}`, "Error: foo");
  assert.equal(formatErrorForUser(new Error("Error: foo")), "Error: foo");
  const typed = new AgentDoomLoopError("researcher", 1, 2);
  assert.equal(typed.name, "AgentDoomLoopError");
  assert.equal(getErrorMessage(typed), typed.message);
  assert.equal(
    formatErrorForUser(typed),
    `AgentDoomLoopError: ${typed.message}`,
  );
});

test("Pi error notifications have exactly one prefix for workflow and retry errors", () => {
  for (const message of [
    "Workflow is already running.",
    "Agent Reporter (reporter) has no attempt to retry yet.",
  ]) {
    for (const error of [
      new Error(message),
      new Error(`Error: ${message}`),
      new Error(`Error: Error: Error: Error: ${message}`),
    ]) {
      const visible = `Error: ${formatErrorForPiNotification(error)}`;
      assert.equal(visible, `Error: ${message}`);
      assert.equal(visible.match(/Error:/g)?.length, 1);
    }
  }
  const typed = new AgentDoomLoopError("researcher", 1, 2);
  assert.equal(
    `Error: ${formatErrorForPiNotification(typed)}`,
    `Error: AgentDoomLoopError: ${typed.message}`,
  );
});

test("continue and retry handlers pass prefix-free errors to Pi", async () => {
  const cwd = await repository();
  const engine = new WorkflowEngine(cwd, new FixtureRunner(), {
    progress: () => {},
    ask: async () => undefined,
  });
  await engine.start("Fix", config());
  const commands = new Map<string, any>();
  const notices: string[] = [];
  teamExtension({
    on: () => {},
    registerCommand: (name: string, command: any) =>
      commands.set(name, command),
  } as any);
  const ctx = {
    cwd,
    ui: { notify: (message: string) => notices.push(message) },
  };
  await commands.get("team-continue").handler("", ctx);
  assert.equal(
    `Error: ${notices.at(-1)}`,
    "Error: Workflow is already running.",
  );
  await commands.get("team-retry").handler("reporter", ctx);
  assert.equal(
    `Error: ${notices.at(-1)}`,
    "Error: Agent Reporter (reporter) has no attempt to retry yet.",
  );
});
