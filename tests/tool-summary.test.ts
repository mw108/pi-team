import { test } from "node:test";
import assert from "node:assert/strict";
import { toolCallSummary } from "../src/agents/tool-summary.ts";

const cwd = "/Users/example/project";

test("tool summaries allowlist path, range, pattern, and command id", () => {
  assert.deepEqual(
    toolCallSummary(
      "read",
      { path: `${cwd}/src/foo.ts`, offset: 120, limit: 80, content: "SECRET" },
      cwd,
    ),
    { path: "src/foo.ts", offset: 120, limit: 80 },
  );
  assert.deepEqual(
    toolCallSummary(
      "grep",
      { pattern: "passwordsMismatch", path: "src/register", token: "SECRET" },
      cwd,
    ),
    { path: "src/register", pattern: "passwordsMismatch" },
  );
  assert.deepEqual(
    toolCallSummary(
      "edit",
      { path: "src/foo.ts", oldText: "SECRET", newText: "SECRET" },
      cwd,
    ),
    { path: "src/foo.ts" },
  );
  assert.deepEqual(
    toolCallSummary("team_command", { id: "test", command: "cat SECRET" }, cwd),
    { command: "test" },
  );
});

test("secret-like patterns and paths never appear raw", () => {
  const secret = "sk-123456789012345678901234567890";
  const summary = toolCallSummary(
    "grep",
    { pattern: secret, path: `${cwd}/src/foo.ts`, authorization: secret },
    cwd,
  );
  assert.match(summary?.pattern as string, /^sha256:/);
  assert.doesNotMatch(
    JSON.stringify(summary),
    /sk-1234|authorization|Users\/example/,
  );
  assert.equal(
    toolCallSummary("read", { path: "/Users/other/secret.txt" }, cwd),
    undefined,
  );
  assert.equal(
    toolCallSummary(
      "edit",
      { path: `src/${secret}`, replacement: secret },
      cwd,
    ),
    undefined,
  );
});
