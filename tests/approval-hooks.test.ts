import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile, readFile, chmod } from "node:fs/promises";
import { join } from "node:path";
import { WorkflowEngine } from "../src/workflow/engine.ts";
import {
  createCommit,
  prepareCommit,
  head,
  git,
  hashes,
  dirtyPaths,
} from "../src/workflow/git.ts";
import { checkTool } from "../src/agents/permissions.ts";
import { validateState } from "../src/workflow/state.ts";
import {
  config,
  contract,
  repository,
  FixtureRunner,
  output,
} from "./helpers.ts";
const ui = { progress: () => {}, ask: async () => undefined };
for (const enabled of [false, true])
  test(`Git hooks ${enabled ? "enabled only by explicit configuration" : "disabled by default"}`, async () => {
    const cwd = await repository(),
      cfg = config();
    cfg.commit.runHooks = enabled;
    await writeFile(
      join(cwd, ".git/hooks/pre-commit"),
      "#!/bin/sh\nprintf hook > .git/hook-ran\n",
    );
    await chmod(join(cwd, ".git/hooks/pre-commit"), 0o700);
    const engine = new WorkflowEngine(cwd, new FixtureRunner(), ui),
      s = await engine.start("Fix", cfg);
    await engine.run(s);
    assert.equal(s.phase, "DONE", s.blocker);
    if (enabled)
      assert.equal(await readFile(join(cwd, ".git/hook-ran"), "utf8"), "hook");
    else await assert.rejects(() => readFile(join(cwd, ".git/hook-ran")));
  });
test("quality gates are rechecked before hook-enabled commit", async () => {
  const cwd = await repository(),
    cfg = config();
  cfg.commit.runHooks = true;
  cfg.qualityGates.commit.enabled = false;
  const engine = new WorkflowEngine(cwd, new FixtureRunner(), ui),
    s = await engine.start("Fix", cfg);
  await engine.run(s);
  await writeFile(
    join(cwd, ".git/hooks/pre-commit"),
    "#!/bin/sh\nprintf hook > .git/hook-ran\n",
  );
  await chmod(join(cwd, ".git/hooks/pre-commit"), 0o700);
  s.gateHashes = await hashes(cwd, await dirtyPaths(cwd));
  s.commitIntent = await prepareCommit(s, ["math.js"], "fix: addition");
  (s.results.tester as any).status = "FAIL";
  await assert.rejects(() => createCommit(s), /Testing has not passed/);
  await assert.rejects(() => readFile(join(cwd, ".git/hook-ran")));
  assert.equal(
    (await git(cwd, ["diff", "--cached", "--name-only"])).trim(),
    "",
  );
});
test("dirty-file denial blocks implementation and preserves working content", async () => {
  const cwd = await repository();
  await writeFile(
    join(cwd, "math.js"),
    "// user edit\nexport const add=(a,b)=>a-b;\n",
  );
  const runner = new FixtureRunner(),
    engine = new WorkflowEngine(cwd, runner, {
      ...ui,
      approve: async () => [],
    }),
    s = await engine.start("Fix", config());
  await engine.run(s);
  assert.equal(s.phase, "BLOCKED");
  assert.match(s.blocker ?? "", /approval denied/);
  assert.equal(runner.counts.implementor, undefined);
  assert.match(await readFile(join(cwd, "math.js"), "utf8"), /user edit/);
});
test("exact dirty-path approval allows edits after resume but requires manual commit", async () => {
  const cwd = await repository();
  const before = await head(cwd);
  await writeFile(
    join(cwd, "math.js"),
    "// user edit\nexport const add = (a, b) => a - b;\n",
  );
  const runner = new FixtureRunner(async (role, s) => {
    if (role === "implementor") {
      const text = await readFile(join(s.cwd, "math.js"), "utf8");
      await writeFile(join(s.cwd, "math.js"), text.replace("a - b", "a + b"));
      return output(role);
    }
  });
  let engine = new WorkflowEngine(cwd, runner, ui);
  const s = await engine.start("Fix", config());
  await engine.run(s);
  assert.equal(s.phase, "WAITING_USER");
  assert.equal(s.pendingApproval?.kind, "dirtyPaths");
  engine = new WorkflowEngine(cwd, runner, {
    ...ui,
    approve: async (request) =>
      request.kind === "dirtyPaths" ? ["math.js"] : ["acknowledge"],
  });
  const loaded = await engine.store.load(s.id);
  await engine.run(loaded);
  assert.equal(loaded.phase, "BLOCKED");
  assert.match(loaded.blocker ?? "", /Manual commit required/);
  assert.deepEqual(loaded.approvedDirtyPaths, ["math.js"]);
  assert.match(await readFile(join(cwd, "math.js"), "utf8"), /user edit/);
  assert.match(await readFile(join(cwd, "math.js"), "utf8"), /a \+ b/);
  assert.equal(await head(cwd), before);
  assert.equal(
    (await git(cwd, ["diff", "--cached", "--name-only"])).trim(),
    "",
  );
  assert.equal((loaded.results.tester as any).status, "PASS");
  await assert.rejects(
    () => prepareCommit(loaded, ["math.js"], "fix"),
    /Cannot safely attribute/,
  );
});
test("dirty-file approvals reject wildcards, normalized aliases and unlisted selections", async () => {
  const cwd = await repository(),
    cfg = config();
  await writeFile(join(cwd, "math.js"), "user edit");
  const runner = new FixtureRunner(),
    engine = new WorkflowEngine(cwd, runner, {
      ...ui,
      approve: async () => ["*"],
    }),
    s = await engine.start("Fix", cfg);
  await engine.run(s);
  assert.equal(s.phase, "BLOCKED");
  assert.match(s.blocker ?? "", /unknown/);
  for (const path of [
    "*",
    "src/*",
    ".",
    "./math.js",
    "src/../math.js",
    "math.js/",
  ])
    assert.throws(
      () => validateState({ ...s, approvedDirtyPaths: [path] }),
      /exact normalized/,
    );
  await assert.rejects(
    () =>
      checkTool(
        "implementor",
        "write",
        { path: "math.js" },
        cwd,
        cfg,
        contract,
        { dirtyPaths: ["math.js"], approvedDirtyPaths: ["other.js"] },
      ),
    /requires explicit approval/,
  );
  await checkTool(
    "implementor",
    "write",
    { path: "math.js" },
    cwd,
    cfg,
    contract,
    { dirtyPaths: ["math.js"], approvedDirtyPaths: ["math.js"] },
  );
});
