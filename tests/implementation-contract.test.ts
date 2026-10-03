import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { contractSchema, parseResult } from "../src/agents/schemas.ts";
import { checkTool, validateContractPaths } from "../src/agents/permissions.ts";
import { classifyPath, policyPath } from "../src/agents/path-policy.ts";
import {
  config,
  contract,
  repository,
  FixtureRunner,
  output,
} from "./helpers.ts";
import { WorkflowEngine } from "../src/workflow/engine.ts";

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

test("policy identity is case-insensitive, Unicode-normalized and rejects traversal", () => {
  for (const path of [
    ".git/config",
    ".Git/config",
    ".GIT/config",
    ".git\\config",
    ".pi/team/x",
    ".PI/team/x",
    ".SeReNa/x",
  ])
    assert.equal(classifyPath(path), "forbidden");
  for (const path of [
    "foo/../.git/config",
    "../package.json",
    "/tmp/a",
    "C:\\outside",
  ])
    assert.throws(() => policyPath(path));
  assert.equal(policyPath("src/e\u0301.ts"), policyPath("src/\u00e9.ts"));
  assert.equal(classifyPath("./PACKAGE.JSON"), "requires_user_approval");
  for (const path of [
    ".GITHUB/WORKFLOWS/test.yml",
    ".HUSKY/pre-commit",
    ".VSCODE/TASKS.JSON",
    ".ENV.LOCAL",
    "packages/app/Package-Lock.JSON",
    "src/Makefile",
  ])
    assert.equal(classifyPath(path), "requires_user_approval");
  assert.equal(classifyPath("src/index.ts"), "normal");
});

test("forbidden contracts fail before implementation; sensitive edits need exact approval", async () => {
  const cwd = await repository();
  for (const path of [".Git/config", ".PI/team/team.yaml", ".SeReNa/state"])
    assert.throws(() => parse([], [path]), /repository-relative/);
  const sensitive = parse([], ["package.json", ".github/workflows/test.yml"]);
  await validateContractPaths(cwd, sensitive);
  await assert.rejects(
    () =>
      checkTool(
        "implementor",
        "edit",
        { path: "package.json" },
        cwd,
        config(),
        sensitive,
      ),
    /Sensitive path/,
  );
  await checkTool(
    "implementor",
    "edit",
    { path: "package.json" },
    cwd,
    config(),
    sensitive,
    {
      dirtyPaths: [],
      approvedDirtyPaths: [],
      approvedSensitivePaths: [policyPath("package.json")],
    },
  );
  await assert.rejects(
    () =>
      checkTool(
        "implementor",
        "write",
        { path: ".github/workflows/test.yml" },
        cwd,
        config(),
        sensitive,
        {
          dirtyPaths: [],
          approvedDirtyPaths: [],
          approvedSensitivePaths: [policyPath("package.json")],
        },
      ),
    /Sensitive path/,
  );
  await checkTool(
    "implementor",
    "edit",
    { path: "math.js" },
    cwd,
    config(),
    contract,
  );
});

test("contract cannot disguise a protected file through an in-repository symlink", async () => {
  const cwd = await repository();
  await symlink("package.json", join(cwd, "alias.json"));
  await assert.rejects(
    () => validateContractPaths(cwd, parse([], ["alias.json"])),
    /aliases another repository path/,
  );
  await assert.rejects(
    () =>
      checkTool(
        "implementor",
        "edit",
        { path: "alias.json" },
        cwd,
        config(),
        parse([], ["alias.json"]),
      ),
    /alias denied/,
  );
  await symlink(".pi/team/missing.json", join(cwd, "missing-alias.json"));
  await assert.rejects(
    () => validateContractPaths(cwd, parse([], ["missing-alias.json"])),
    /Unresolved repository symlink denied/,
  );
});

test("sensitive contract pauses before Implementor and records exact approval", async () => {
  const cwd = await repository();
  let implementations = 0;
  const runner = new FixtureRunner(async (role) => {
    if (role === "reviewer")
      return { ...contract, filesToModify: ["package.json"] };
    if (role === "implementor") implementations++;
    return output(role);
  });
  const engine = new WorkflowEngine(cwd, runner, {
    progress: () => {},
    ask: async () => undefined,
    approve: async () => undefined,
  });
  const state = await engine.start("Change package metadata", config());
  await engine.run(state);
  assert.equal(state.phase, "WAITING_USER");
  assert.equal(state.pendingApproval?.kind, "sensitivePaths");
  assert.match(state.pendingApproval.prompt, /package\.json/);
  assert.equal(implementations, 0);
  (engine.ui as any).approve = async () => ["allow"];
  await engine.run(state);
  assert.deepEqual(state.approvedSensitivePaths, ["package.json"]);
  assert.equal(implementations, 1);
  assert.ok(
    state.history.some((event) => event.event === "sensitive_paths_approved"),
  );
});

test("denying a sensitive contract blocks before Implementor", async () => {
  const cwd = await repository();
  const runner = new FixtureRunner(async (role) =>
    role === "reviewer"
      ? { ...contract, filesToModify: ["package.json"] }
      : undefined,
  );
  const engine = new WorkflowEngine(cwd, runner, {
    progress: () => {},
    ask: async () => undefined,
    approve: async (request) =>
      request.kind === "sensitivePaths" ? ["deny"] : undefined,
  });
  const state = await engine.start("Change package metadata", config());
  await engine.run(state);
  assert.equal(state.phase, "BLOCKED");
  assert.match(state.blocker ?? "", /Sensitive path approval denied/);
  assert.equal(runner.counts.implementor, undefined);
});
