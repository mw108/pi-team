import { test } from "node:test";
import assert from "node:assert/strict";
import { symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { allowedTools, checkTool } from "../src/agents/permissions.ts";
import { config, contract, repository } from "./helpers.ts";
import { configSchema } from "../src/config/schema.ts";
test("read-only roles have no source mutation or shell tools", () => {
  const cfg = config();
  cfg.integrations.serena.enabled = true;
  for (const role of [
    "researcher",
    "solver1",
    "solver2",
    "solver3",
    "critic",
    "reviewer",
    "codeReviewer",
    "pentester",
    "securityReviewer",
    "commitAgent",
  ] as const) {
    const tools = allowedTools(role, cfg);
    assert.ok(!tools.includes("bash"));
    assert.ok(!tools.includes("write"));
    assert.ok(!tools.includes("edit"));
    assert.ok(!tools.includes("serena_replace_symbol_body"));
  }
});
test("implementor cannot escape contract through paths or symlinks", async () => {
  const cwd = await repository(),
    cfg = config();
  await assert.rejects(() =>
    checkTool(
      "implementor",
      "write",
      { path: "../escape" },
      cwd,
      cfg,
      contract,
    ),
  );
  await assert.rejects(() =>
    checkTool("implementor", "write", { path: "other.js" }, cwd, cfg, contract),
  );
  await symlink("/tmp", join(cwd, "escape"));
  await assert.rejects(() =>
    checkTool("implementor", "write", { path: "escape/file" }, cwd, cfg, {
      ...contract,
      filesToCreate: ["escape/file"],
    }),
  );
  await checkTool(
    "implementor",
    "write",
    { path: "math.js" },
    cwd,
    cfg,
    contract,
  );
});
test("tester source edits are disabled unless explicitly configured", async () => {
  const cwd = await repository(),
    cfg = config();
  await assert.rejects(() =>
    checkTool(
      "tester",
      "edit",
      { path: "tests/math.test.mjs" },
      cwd,
      cfg,
      contract,
    ),
  );
  cfg.tester.mayModifyTests = true;
  const testContract = {
    ...contract,
    filesToModify: [...contract.filesToModify, "tests/math.test.mjs"],
  };
  await checkTool(
    "tester",
    "edit",
    { path: "tests/math.test.mjs" },
    cwd,
    cfg,
    testContract,
  );
  await assert.rejects(() =>
    checkTool("tester", "edit", { path: "math.js" }, cwd, cfg, contract),
  );
  await assert.rejects(() =>
    checkTool(
      "tester",
      "edit",
      { path: "tests-evil/math.test.mjs" },
      cwd,
      cfg,
      {
        ...contract,
        filesToModify: [...contract.filesToModify, "tests-evil/math.test.mjs"],
      },
    ),
  );
});
test("configuration cannot grant direct Git mutation or raw shell wrappers to roles", () => {
  for (const executable of ["git", "/usr/bin/git", "bash", "/bin/zsh"]) {
    const cfg = config();
    cfg.commands.push({
      id: "escape",
      executable,
      args: ["commit"],
      purpose: "development",
      timeoutMs: 1000,
    });
    assert.throws(
      () => configSchema.parse(cfg),
      /Direct Git and shell-wrapper commands/,
    );
  }
});
