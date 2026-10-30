import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { classifyCommandMutation } from "../src/agents/command-mutation-policy.ts";
import { commandTool } from "../src/agents/commands.ts";
import {
  compareRepositorySnapshots,
  git,
  repositorySnapshot,
} from "../src/workflow/git.ts";
import { config, repository } from "./helpers.ts";

test("Tester host policy separates dependency mutations from package inspection", async (t) => {
  const cwd = await repository();
  t.after(() => rm(cwd, { recursive: true, force: true }));
  for (const [executable, args] of [
    ["npm", ["install", "--ignore-scripts"]],
    ["npm.cmd", ["ci"]],
    ["npm", ["update"]],
    ["pnpm", ["add", "left-pad"]],
    ["yarn", ["upgrade"]],
    ["bun", ["install"]],
    ["composer.bat", ["install", "--no-scripts"]],
    ["composer", ["update"]],
    ["npx", ["vite", "build"]],
  ] as const) {
    const result = await classifyCommandMutation(
      { executable, args: [...args] },
      cwd,
    );
    assert.equal(result.risk, "DEPENDENCY_MUTATION", `${executable} ${args}`);
  }
  assert.equal(
    (await classifyCommandMutation({ executable: "npm", args: ["list"] }, cwd))
      .risk,
    "READ_ONLY",
  );
  assert.equal(
    (
      await classifyCommandMutation(
        { executable: "composer", args: ["validate"] },
        cwd,
      )
    ).risk,
    "READ_ONLY",
  );
});

test("package scripts are inspected transitively and are not trusted by name", async (t) => {
  const cwd = await repository();
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await writeFile(
    join(cwd, "package.json"),
    JSON.stringify({
      scripts: {
        test: "npm run prepare-test && node --test",
        "prepare-test": "npm install --ignore-scripts",
        safe: "node --test",
        opaque: "node tools/custom-validator.js",
      },
    }),
  );
  assert.equal(
    (
      await classifyCommandMutation(
        { executable: "npm", args: ["run", "test"] },
        cwd,
      )
    ).risk,
    "DEPENDENCY_MUTATION",
  );
  assert.equal(
    (
      await classifyCommandMutation(
        { executable: "npm", args: ["run", "safe"] },
        cwd,
      )
    ).risk,
    "GENERATED_OUTPUT",
  );
  assert.equal(
    (
      await classifyCommandMutation(
        { executable: "npm", args: ["run", "opaque"] },
        cwd,
      )
    ).risk,
    "UNKNOWN",
  );
});

test("generic configured approval cannot authorize Tester dependency mutation", async (t) => {
  const cwd = await repository();
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const install = {
    id: "install",
    executable: "npm",
    args: ["install", "--ignore-scripts"],
    purpose: "test" as const,
    timeoutMs: 1_000,
  };
  const cfg = { ...config(), commands: [install] };
  const evidence: any[] = [];
  const approvals: any[] = [];
  const tool = commandTool(
    "tester",
    cfg,
    cwd,
    evidence,
    async (command, request, _signal, _wait, context) => {
      approvals.push({ command, request, context });
      return "deny";
    },
  );
  const result = await tool.execute(
    "install-call",
    { id: "install" },
    undefined,
    undefined,
    {} as any,
  );
  assert.equal((result.details as any).code, "DEPENDENCY_MUTATION_DENIED");
  assert.equal(evidence.length, 0);
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].context.requiresDependencyMutationApproval, true);
  assert.deepEqual(approvals[0].command.args, install.args);
});

test("explicit one-time authorization records synthetic install mutation provenance", async (t) => {
  const cwd = await repository();
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const bin = join(cwd, "synthetic-bin");
  await mkdir(bin);
  const executable = join(
    bin,
    process.platform === "win32" ? "npm.cmd" : "npm",
  );
  if (process.platform === "win32")
    await writeFile(
      executable,
      `@echo off\r\n"${process.execPath}" -e "require('fs').writeFileSync('package-lock.json','{\\\"lockfileVersion\\\":3}\\n')"\r\n`,
    );
  else {
    await writeFile(
      executable,
      '#!/usr/bin/env node\nrequire("fs").writeFileSync("package-lock.json", "{\\"lockfileVersion\\":3}\\n");\n',
    );
    await chmod(executable, 0o755);
  }
  const install = {
    id: "synthetic-install",
    executable,
    args: ["install", "--ignore-scripts"],
    purpose: "test" as const,
    timeoutMs: 5_000,
  };
  const evidence: any[] = [];
  let approval: any;
  const tool = commandTool(
    "tester",
    { ...config(), commands: [install] },
    cwd,
    evidence,
    async (command, request, _signal, _wait, context) => {
      approval = { command, request, context };
      return "allow";
    },
  );
  const result = await tool.execute(
    "synthetic-install-call",
    { id: install.id },
    undefined,
    undefined,
    {} as any,
  );
  assert.equal((result.details as any).exitCode, 0);
  assert.deepEqual(approval.command.args, install.args);
  assert.equal(approval.context.requiresDependencyMutationApproval, true);
  assert.equal(evidence[0].mutation.risk, "DEPENDENCY_MUTATION");
  assert.equal(evidence[0].mutation.attribution, "OBSERVED");
  assert.deepEqual(evidence[0].mutation.drift.added, ["package-lock.json"]);
});

test("repository snapshots isolate newly introduced lockfile drift", async (t) => {
  const cwd = await repository();
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await writeFile(
    join(cwd, "math.js"),
    "export const add = (a, b) => a + b;\n",
  );
  await writeFile(
    join(cwd, "tests/new.test.mjs"),
    "// pre-existing implementation test\n",
  );
  const before = await repositorySnapshot(cwd);
  await writeFile(join(cwd, "package-lock.json"), '{"lockfileVersion":3}\n');
  const after = await repositorySnapshot(cwd);
  const report = compareRepositorySnapshots(before, after);
  assert.deepEqual(report.added, ["package-lock.json"]);
  assert.deepEqual(report.modified, []);
  assert.deepEqual(report.unstaged, []);
  assert.deepEqual(report.untracked, ["package-lock.json"]);
  assert.ok(!report.added.includes("math.js"));
  assert.ok(!report.added.includes("tests/new.test.mjs"));

  await git(cwd, ["add", "package-lock.json"]);
  const staged = compareRepositorySnapshots(
    after,
    await repositorySnapshot(cwd),
  );
  assert.ok(staged.modified.includes("package-lock.json"));
  assert.ok(staged.staged.includes("package-lock.json"));
});
