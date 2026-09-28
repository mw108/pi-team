import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { contractSchema, parseResult } from "../src/agents/schemas.ts";
import { checkTool, validateContractPaths } from "../src/agents/permissions.ts";
import { config, contract, repository } from "./helpers.ts";

const requirement = (action: string, file?: string, extra = {}) => ({
  description: "Failure is covered",
  action,
  ...(file ? { file } : {}),
  ...extra,
});
const parse = (
  tests: unknown[],
  modify: string[] = [],
  create: string[] = [],
) =>
  contractSchema.parse({
    ...contract,
    filesToModify: modify,
    filesToCreate: create,
    requiredTests: tests,
  });

test("required test schema accepts existing coverage with or without a file", () => {
  assert.equal(
    parse([requirement("existing")]).requiredTests[0].file,
    undefined,
  );
  assert.equal(
    parse([requirement("existing", "tests/login.spec.ts")]).requiredTests[0]
      .file,
    "tests/login.spec.ts",
  );
  assert.ok(
    parse([
      requirement("existing", undefined, {
        acceptanceCriteria: ["login succeeds"],
      }),
    ]),
  );
});
test("required test schema rejects missing files, actions, scopes and blank descriptions", () => {
  for (const value of [
    requirement("modify"),
    requirement("create"),
    requirement("invented", "tests/a.ts"),
    requirement("existing", undefined, { scope: "browser" }),
    { description: "  ", action: "existing" },
  ])
    assert.throws(() => parse([value]));
});
test("modify/create paths must match contract lists and cannot conflict", () => {
  const file = "tests/login.spec.ts";
  assert.ok(parse([requirement("modify", file)], [file]));
  assert.ok(parse([requirement("create", file)], [], [file]));
  assert.throws(() => parse([requirement("modify", file)]), /filesToModify/);
  assert.throws(() => parse([requirement("create", file)]), /filesToCreate/);
  assert.ok(
    parse([requirement("modify", file), requirement("modify", file)], [file]),
  );
  assert.throws(
    () =>
      parse(
        [requirement("create", file), requirement("modify", file)],
        [file],
        [file],
      ),
    /Conflicting test actions/,
  );
});
test("test paths reject escapes and absolute paths and accept safe relative paths", () => {
  assert.ok(parse([requirement("existing", "tests/login.spec.ts")]));
  for (const path of [
    "../outside.ts",
    "/tmp/outside.ts",
    "tests/../../outside.ts",
    "tests\\login.ts",
  ])
    assert.throws(
      () => parse([requirement("existing", path)]),
      /repository-relative/,
    );
});
test("test paths use the repository symlink-escape guard", async () => {
  const cwd = await repository();
  const outside = await mkdtemp(join(tmpdir(), "outside-tests-"));
  await symlink(outside, join(cwd, "escape"));
  const value = parse([requirement("existing", "escape/test.ts")]);
  await assert.rejects(
    () => validateContractPaths(cwd, value),
    /Symlink escapes repository/,
  );
});
test("Implementor may create a listed test file; default Tester remains read-only", async () => {
  const cwd = await repository();
  const cfg = config();
  const value = parse(
    [requirement("create", "tests/new-login.test.mjs")],
    ["math.js"],
    ["tests/new-login.test.mjs"],
  );
  assert.equal(cfg.tester.mayModifyTests, false);
  await assert.doesNotReject(() =>
    checkTool(
      "implementor",
      "write",
      { path: "tests/new-login.test.mjs" },
      cwd,
      cfg,
      value,
    ),
  );
  await assert.rejects(
    () =>
      checkTool(
        "tester",
        "write",
        { path: "tests/new-login.test.mjs" },
        cwd,
        cfg,
        value,
      ),
    /denied/,
  );
});
test("Reviewer parse accepts a structured test contract and rejects inconsistent output", () => {
  const file = "tests/login.spec.ts";
  const valid = {
    ...contract,
    filesToModify: ["math.js", file],
    requiredTests: [requirement("modify", file)],
  };
  assert.equal(
    parseResult("reviewer", valid).requiredTests[0].action,
    "modify",
  );
  assert.throws(
    () => parseResult("reviewer", { ...valid, filesToModify: ["math.js"] }),
    /filesToModify/,
  );
});
