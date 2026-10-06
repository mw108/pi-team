import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { configSchema } from "../src/config/schema.ts";
import { WorkflowEngine } from "../src/workflow/engine.ts";
import {
  classifyCommitPaths,
  nonCommittablePaths,
} from "../src/workflow/commit-paths.ts";
import { contextFor } from "../src/agents/context.ts";
import { git, head, prepareCommit } from "../src/workflow/git.ts";
import { renderReport } from "../src/workflow/report.ts";
import { config, FixtureRunner, output, repository } from "./helpers.ts";

const ui = { progress: () => {}, ask: async () => undefined };
const incidentFiles = [
  ".env",
  ".env.testing",
  "config/app.php",
  "app/Providers/AppServiceProvider.php",
  "phpunit.xml",
  "tests/Unit/ConfigTest.php",
  "tests/Feature/API/V1/VerificationUrlTest.php",
];

async function workflow(
  proposed: string[],
  contractFiles = proposed.map((path) => path.replace(/^\.\//, "")),
  options: {
    tracked?: string[];
    baselineDirty?: string[];
    excludePaths?: string[];
    retryProposed?: string[];
    ignored?: string[];
  } = {},
) {
  const cwd = await repository();
  if (options.ignored?.length) {
    await writeFile(join(cwd, ".gitignore"), `${options.ignored.join("\n")}\n`);
    await git(cwd, ["add", ".gitignore"]);
    await git(cwd, [
      "-c",
      "core.hooksPath=/dev/null",
      "commit",
      "-m",
      "fixture ignore",
    ]);
  }
  const tracked = new Set(options.tracked ?? []);
  for (const path of tracked) {
    await mkdir(dirname(join(cwd, path)), { recursive: true });
    await writeFile(join(cwd, path), "before\n");
    await git(cwd, ["add", "-f", "--", path]);
  }
  if (tracked.size)
    await git(cwd, [
      "-c",
      "core.hooksPath=/dev/null",
      "commit",
      "-m",
      "fixture",
    ]);
  for (const path of options.baselineDirty ?? [])
    await writeFile(join(cwd, path), "user edit\n");
  const cfg = config();
  cfg.commit.excludePaths = options.excludePaths ?? [];
  cfg.permissions.files.allowWrite = contractFiles.filter((path) =>
    path.startsWith(".env"),
  );
  const reporterInputs: any[] = [];
  const commitInputs: any[] = [];
  const runner = new FixtureRunner(async (role, state, count) => {
    if (role === "reviewer")
      return {
        ...output(role),
        filesToModify: contractFiles.filter((path) => tracked.has(path)),
        filesToCreate: contractFiles.filter((path) => !tracked.has(path)),
      };
    if (role === "implementor") {
      for (const path of contractFiles) {
        await mkdir(dirname(join(cwd, path)), { recursive: true });
        await writeFile(join(cwd, path), `workflow change in ${path}\n`);
      }
      return { ...output(role), changedFiles: contractFiles };
    }
    if (role === "tester") return output(role);
    if (role === "commitAgent") {
      commitInputs.push(await contextFor(role, state));
      return {
        message: "feat: fixture",
        files: count > 1 ? (options.retryProposed ?? proposed) : proposed,
      };
    }
    if (role === "reporter") {
      reporterInputs.push(await contextFor(role, state));
      return output(role);
    }
  });
  const engine = new WorkflowEngine(cwd, runner, {
    ...ui,
    approve: async (request) =>
      request.kind === "dirtyPaths" ? (options.baselineDirty ?? []) : [],
  });
  const state = await engine.start("Commit exclusions", cfg);
  const before = await head(cwd);
  await engine.run(state);
  return { cwd, state, engine, runner, reporterInputs, commitInputs, before };
}

test("default policy is exact, normalized, additive, and rejects traversal", () => {
  const legacy = configSchema.parse({
    ...config(),
    commit: { runHooks: false },
  });
  assert.deepEqual(nonCommittablePaths(legacy), [".env", ".env.testing"]);
  assert.deepEqual(
    classifyCommitPaths(legacy, ["./.env", ".env.testing", ".env.example"]),
    {
      requestedPaths: ["./.env", ".env.testing", ".env.example"],
      excludedPaths: [".env", ".env.testing"],
      commitFiles: [".env.example"],
    },
  );
  const extended = config();
  extended.commit.excludePaths = ["some/local/file"];
  assert.deepEqual(nonCommittablePaths(extended), [
    ".env",
    ".env.testing",
    "some/local/file",
  ]);
  assert.throws(() => classifyCommitPaths(legacy, ["../.env"]), /traversal/);
  assert.equal(
    configSchema.safeParse({
      ...config(),
      commit: { excludePaths: ["../.env"] },
    }).success,
    false,
  );
});

test("incident paths exclude local files before attribution and stage only five normal files", async () => {
  const { cwd, state, engine, reporterInputs, commitInputs } = await workflow(
    incidentFiles,
    incidentFiles,
    {
      ignored: [".env", ".env.testing"],
    },
  );
  assert.equal(state.phase, "DONE", state.blocker);
  assert.deepEqual(state.commitSelection, {
    requestedPaths: incidentFiles,
    excludedPaths: [".env", ".env.testing"],
    commitFiles: incidentFiles.slice(2),
    completed: true,
  });
  assert.deepEqual(state.commit?.files, incidentFiles.slice(2));
  assert.deepEqual(commitInputs[0].nonCommittablePaths, [
    ".env",
    ".env.testing",
  ]);
  assert.match(commitInputs[0].commitPathInstruction, /Never include them/);
  assert.deepEqual(
    (await git(cwd, ["show", "--format=", "--name-only", "HEAD"]))
      .trim()
      .split("\n")
      .sort(),
    incidentFiles.slice(2).sort(),
  );
  assert.match(await readFile(join(cwd, ".env"), "utf8"), /workflow change/);
  assert.doesNotMatch(await git(cwd, ["status", "--short"]), /\.env/);
  assert.deepEqual(reporterInputs.at(-1)?.excludedCommitPaths, [
    { path: ".env", reason: "non-committable" },
    { path: ".env.testing", reason: "non-committable" },
  ]);
  assert.match(
    renderReport(state.results.reporter!),
    /Modified locally but intentionally not committed/,
  );
  const event = state.history.find(
    (entry) => entry.event === "commit_paths_excluded",
  );
  assert.deepEqual(event?.meta?.paths, [".env", ".env.testing"]);
  assert.equal(event?.meta?.reason, "non_committable");
  assert.deepEqual(
    (await engine.store.load(state.id)).commitSelection,
    state.commitSelection,
  );
});

test("only excluded tracked files complete without creating a commit", async () => {
  const { cwd, state, before, reporterInputs } = await workflow(
    [".env", ".env.testing"],
    [".env", ".env.testing"],
    { tracked: [".env", ".env.testing"] },
  );
  assert.equal(state.phase, "DONE", state.blocker);
  assert.equal(state.commit, undefined);
  assert.equal(await head(cwd), before);
  assert.deepEqual(state.commitSelection?.commitFiles, []);
  assert.equal(state.commitSelection?.completed, true);
  assert.match(
    (state.reportInput as any)?.commit?.detail ?? "",
    /Nothing committable/,
  );
  assert.deepEqual(
    reporterInputs
      .at(-1)
      ?.excludedCommitPaths.map((entry: { path: string }) => entry.path),
    [".env", ".env.testing"],
  );
  assert.match(await git(cwd, ["status", "--short"]), /\.env/);
});

test("pre-existing dirty excluded path remains untouched while normal file commits", async () => {
  const { cwd, state } = await workflow(
    [".env", ".env.example"],
    [".env", ".env.example"],
    { tracked: [".env"], baselineDirty: [".env"] },
  );
  assert.equal(state.phase, "DONE", state.blocker);
  assert.deepEqual(state.commit?.files, [".env.example"]);
  assert.match(await git(cwd, ["status", "--short"]), /\.env/);
  assert.match(await readFile(join(cwd, ".env"), "utf8"), /workflow change/);
});

test("normal unattributable path still blocks", async () => {
  const { state, engine } = await workflow(["src/UnknownFile.php"], [".env"]);
  assert.equal(state.phase, "BLOCKED");
  assert.match(
    state.blocker ?? "",
    /Cannot safely attribute commit path: src\/UnknownFile.php/,
  );
  assert.doesNotMatch(state.blocker ?? "", /\.env/);
  assert.deepEqual(
    (await engine.store.load(state.id)).commitSelection,
    state.commitSelection,
  );
});

test("a legacy .env attribution blocker can retry COMMIT without rerunning gates", async () => {
  const { cwd, state, engine, runner } = await workflow(
    ["src/UnknownFile.php"],
    [".env", "config/app.php"],
    { retryProposed: [".env", "config/app.php"] },
  );
  assert.equal(state.phase, "BLOCKED");
  state.blocker = "Cannot safely attribute commit path: .env";
  state.results.commitAgent = {
    message: "feat: fixture",
    files: [".env", "config/app.php"],
  };
  await engine.store.save(state);
  const restarted = new WorkflowEngine(cwd, runner, ui);
  const loaded = await restarted.store.load(state.id);
  assert.deepEqual(loaded.commitSelection, state.commitSelection);
  assert.equal(
    await restarted.retryAgent(loaded, "commitAgent", true),
    "prepared",
  );
  await restarted.run(loaded);
  assert.equal(loaded.phase, "DONE", loaded.blocker);
  assert.deepEqual(loaded.commit?.files, ["config/app.php"]);
  assert.equal(runner.counts.tester, 1);
  assert.equal(runner.counts.commitAgent, 2);
});

test("host refuses non-committable path even when prepareCommit is called directly", async () => {
  const { state } = await workflow([".env"], [".env"]);
  await assert.rejects(
    () => prepareCommit(state, [".env"], "bad"),
    /Non-committable path cannot be staged/,
  );
});
