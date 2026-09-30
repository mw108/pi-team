import { test } from "node:test";
import assert from "node:assert/strict";
import {
  getErrorMessage,
  formatErrorForUser,
} from "../src/agents/error-message.ts";
import { AgentDoomLoopError } from "../src/agents/errors.ts";

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
