import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  FileMutationTracker,
  type MutationObserver,
} from "../src/agents/mutation-attribution.ts";
import {
  baseline,
  classifyOrphanedImplementation,
  git,
  hashes,
} from "../src/workflow/git.ts";
import { newState, validateState } from "../src/workflow/state.ts";
import { WorkflowEngine } from "../src/workflow/engine.ts";
import {
  config,
  contract,
  finding,
  FixtureRunner,
  output,
  repository,
} from "./helpers.ts";

async function observed(
  cwd: string,
  observer: MutationObserver | undefined,
  path: string,
  tool: string,
  failed = false,
) {
  if (!observer) throw new Error("Missing mutation observer");
  const tracker = new FileMutationTracker(cwd, observer);
  tracker.start("call", tool, { path });
  await tracker.end("call", failed);
}

test("only successful file tool completions record normalized mutations", async () => {
  const cwd = await repository();
  const mutations: unknown[] = [];
  const observer: MutationObserver = async (mutation) => {
    mutations.push(mutation);
  };
  await observed(cwd, observer, "./math.js", "edit");
  await observed(cwd, observer, "math.js", "edit", true);
  await observed(cwd, observer, "generated.json", "team_command");
  await observed(cwd, observer, "../escape", "write");
  assert.deepEqual(mutations, [
    { path: "math.js", identity: "math.js", kind: "edit" },
  ]);
});

test("declared changes and successful commands do not establish discard ownership", async () => {
  const cwd = await repository();
  const state = newState(cwd, "task", config(), await baseline(cwd));
  await writeFile(join(cwd, "generated.json"), "from command\n");
  state.results.reviewer = contract;
  state.results.implementor = {
    ...output("implementor"),
    changedFiles: ["generated.json"],
  };
  state.priorImplementation = {
    attempt: 1,
    hashes: await hashes(cwd, ["generated.json"]),
    createdPaths: ["generated.json"],
    discardablePaths: [],
  };
  assert.deepEqual(await classifyOrphanedImplementation(state), {
    discardable: [],
    ambiguous: ["generated.json"],
  });
});

test("a failed edit cannot make a dirty orphan discardable", async () => {
  const cwd = await repository();
  await writeFile(join(cwd, "old.js"), "old baseline\n");
  await git(cwd, ["add", "old.js"]);
  await git(cwd, [
    "-c",
    "core.hooksPath=/dev/null",
    "commit",
    "-m",
    "old baseline",
  ]);
  const state = newState(cwd, "task", config(), await baseline(cwd));
  const mutations: unknown[] = [];
  await writeFile(join(cwd, "old.js"), "unattributed edit\n");
  await observed(
    cwd,
    async (mutation) => {
      mutations.push(mutation);
    },
    "old.js",
    "edit",
    true,
  );
  state.results.reviewer = contract;
  state.priorImplementation = {
    attempt: 1,
    hashes: await hashes(cwd, ["old.js"]),
    createdPaths: [],
    discardablePaths: [],
  };
  assert.deepEqual(mutations, []);
  assert.deepEqual(await classifyOrphanedImplementation(state), {
    discardable: [],
    ambiguous: ["old.js"],
  });
});

test("legacy M4 state loads without inventing file tool evidence", async () => {
  const cwd = await repository();
  const raw: any = newState(cwd, "task", config(), await baseline(cwd));
  await writeFile(join(cwd, "old.js"), "old legacy change\n");
  delete raw.observedImplementorMutations;
  raw.priorImplementation = {
    hashes: await hashes(cwd, ["old.js"]),
    createdPaths: ["old.js"],
  };
  raw.results.previous_implementor = {
    ...output("implementor"),
    changedFiles: ["old.js"],
  };
  raw.results.reviewer = contract;
  const loaded = validateState(raw);
  assert.deepEqual(loaded.observedImplementorMutations, []);
  assert.deepEqual(loaded.priorImplementation?.discardablePaths, []);
  assert.deepEqual(await classifyOrphanedImplementation(loaded), {
    discardable: [],
    ambiguous: ["old.js"],
  });
});

test("staged orphan stays ambiguous even with positive mutation evidence", async () => {
  const cwd = await repository();
  await writeFile(join(cwd, "old.js"), "old baseline\n");
  await git(cwd, ["add", "old.js"]);
  await git(cwd, [
    "-c",
    "core.hooksPath=/dev/null",
    "commit",
    "-m",
    "old baseline",
  ]);
  const state = newState(cwd, "task", config(), await baseline(cwd));
  await writeFile(join(cwd, "old.js"), "workflow edit\n");
  state.results.reviewer = contract;
  state.priorImplementation = {
    attempt: 1,
    hashes: await hashes(cwd, ["old.js"]),
    createdPaths: [],
    discardablePaths: ["old.js"],
  };
  state.observedImplementorMutations.push({
    attempt: 1,
    path: "old.js",
    identity: "old.js",
    kind: "edit",
  });
  await git(cwd, ["add", "old.js"]);
  assert.deepEqual(await classifyOrphanedImplementation(state), {
    discardable: [],
    ambiguous: ["old.js"],
  });
});

test("observed delete can restore a clean tracked orphan", async () => {
  const cwd = await repository();
  await writeFile(join(cwd, "old.js"), "old baseline\n");
  await git(cwd, ["add", "old.js"]);
  await git(cwd, [
    "-c",
    "core.hooksPath=/dev/null",
    "commit",
    "-m",
    "old baseline",
  ]);
  const cfg = config();
  cfg.qualityGates.commit.enabled = false;
  let reviews = 0;
  let implementations = 0;
  const runner = new FixtureRunner(async (role, _state, _count, observer) => {
    if (role === "reviewer")
      return ++reviews === 1
        ? { ...contract, filesToDelete: ["old.js"] }
        : contract;
    if (role === "implementor") {
      implementations++;
      await writeFile(
        join(cwd, "math.js"),
        "export const add = (a,b) => a+b;\n",
      );
      if (implementations === 1) {
        await unlink(join(cwd, "old.js"));
        await observed(cwd, observer, "old.js", "team_delete");
        return {
          status: "IMPLEMENTATION_BLOCKED",
          reason: "redesign",
          suggestedRoute: "FIX_DESIGN",
          evidence: ["obsolete deletion"],
        };
      }
      return output(role);
    }
  });
  const engine = new WorkflowEngine(cwd, runner, {
    progress: () => {},
    ask: async () => undefined,
    approve: async (request) =>
      request.kind === "orphanedImplementation" ? ["discard"] : undefined,
  });
  const state = await engine.start("Fix", cfg);
  await engine.run(state);
  assert.equal(state.phase, "DONE", state.blocker);
  assert.equal(await readFile(join(cwd, "old.js"), "utf8"), "old baseline\n");
  assert.ok(
    state.observedImplementorMutations.some(
      (item) => item.kind === "delete" && item.path === "old.js",
    ),
  );
});

test("an edit after the Implementor attempt prevents discard", async () => {
  const cwd = await repository();
  await writeFile(join(cwd, "old.js"), "old baseline\n");
  await git(cwd, ["add", "old.js"]);
  await git(cwd, [
    "-c",
    "core.hooksPath=/dev/null",
    "commit",
    "-m",
    "old baseline",
  ]);
  const cfg = config();
  cfg.qualityGates.commit.enabled = false;
  let reviews = 0;
  const runner = new FixtureRunner(async (role, _state, _count, observer) => {
    if (role === "reviewer")
      return ++reviews === 1
        ? { ...contract, filesToModify: ["math.js", "old.js"] }
        : contract;
    if (role === "implementor") {
      await writeFile(
        join(cwd, "math.js"),
        "export const add = (a,b) => a+b;\n",
      );
      await writeFile(join(cwd, "old.js"), "workflow edit\n");
      await observed(cwd, observer, "old.js", "edit");
      return {
        status: "IMPLEMENTATION_BLOCKED",
        reason: "redesign",
        suggestedRoute: "FIX_DESIGN",
        evidence: ["obsolete file"],
      };
    }
  });
  const waiting = new WorkflowEngine(cwd, runner, {
    progress: () => {},
    ask: async () => undefined,
  });
  const state = await waiting.start("Fix", cfg);
  await waiting.run(state);
  assert.equal(state.phase, "WAITING_USER");
  assert.equal(state.pendingApproval?.kind, "orphanedImplementation");
  await writeFile(
    join(cwd, "old.js"),
    "workflow edit\nuser edit after attempt\n",
  );
  const resumed = new WorkflowEngine(cwd, runner, {
    progress: () => {},
    ask: async () => undefined,
    approve: async () => ["discard"],
  });
  const loaded = await resumed.store.load(state.id);
  await resumed.run(loaded);
  assert.equal(loaded.phase, "BLOCKED");
  assert.match(loaded.blocker ?? "", /Ambiguous orphaned changes/);
  assert.match(
    await readFile(join(cwd, "old.js"), "utf8"),
    /user edit after attempt/,
  );
});

test("mutation evidence from attempt one cannot authorize attempt two discard", async () => {
  const cwd = await repository();
  await writeFile(join(cwd, "old.js"), "old baseline\n");
  await git(cwd, ["add", "old.js"]);
  await git(cwd, [
    "-c",
    "core.hooksPath=/dev/null",
    "commit",
    "-m",
    "old baseline",
  ]);
  const cfg = config();
  cfg.qualityGates.commit.enabled = false;
  let reviews = 0;
  let implementations = 0;
  let codeReviews = 0;
  const runner = new FixtureRunner(async (role, _state, _count, observer) => {
    if (role === "reviewer")
      return ++reviews === 1
        ? { ...contract, filesToModify: ["math.js", "old.js"] }
        : contract;
    if (role === "implementor") {
      implementations++;
      await writeFile(
        join(cwd, "math.js"),
        "export const add = (a,b) => a+b;\n",
      );
      await writeFile(join(cwd, "old.js"), `attempt ${implementations}\n`);
      if (implementations === 1) {
        await observed(cwd, observer, "old.js", "edit");
        return { ...output(role), changedFiles: ["math.js", "old.js"] };
      }
      return {
        status: "IMPLEMENTATION_BLOCKED",
        reason: "redesign",
        suggestedRoute: "FIX_DESIGN",
        evidence: ["obsolete file"],
      };
    }
    if (role === "codeReviewer" && ++codeReviews === 1)
      return { status: "FIX_LOCAL", findings: [finding] };
  });
  const engine = new WorkflowEngine(cwd, runner, {
    progress: () => {},
    ask: async () => undefined,
    approve: async (request) =>
      request.kind === "orphanedImplementation" ? ["discard"] : undefined,
  });
  const state = await engine.start("Fix", cfg);
  await engine.run(state);
  assert.equal(state.phase, "BLOCKED", state.blocker);
  assert.match(state.blocker ?? "", /Ambiguous orphaned changes/);
  assert.equal(state.priorImplementation?.attempt, 2);
  assert.deepEqual(state.priorImplementation?.discardablePaths, []);
  assert.deepEqual(
    state.observedImplementorMutations.map((item) => item.attempt),
    [1],
  );
  assert.equal(await readFile(join(cwd, "old.js"), "utf8"), "attempt 2\n");
});

test("discard restores only observed files and blocks on command-created orphans", async () => {
  const cwd = await repository();
  await writeFile(join(cwd, "safe.js"), "safe baseline\n");
  await git(cwd, ["add", "safe.js"]);
  await git(cwd, [
    "-c",
    "core.hooksPath=/dev/null",
    "commit",
    "-m",
    "safe baseline",
  ]);
  const cfg = config();
  cfg.qualityGates.commit.enabled = false;
  let reviews = 0;
  const runner = new FixtureRunner(async (role, _state, _count, observer) => {
    if (role === "reviewer")
      return ++reviews === 1
        ? {
            ...contract,
            filesToModify: ["math.js", "safe.js"],
            filesToCreate: ["generated.json"],
          }
        : contract;
    if (role === "implementor") {
      await writeFile(
        join(cwd, "math.js"),
        "export const add = (a,b) => a+b;\n",
      );
      await writeFile(join(cwd, "safe.js"), "observed edit\n");
      await observed(cwd, observer, "safe.js", "edit");
      await writeFile(join(cwd, "generated.json"), "command side effect\n");
      await observed(cwd, observer, "generated.json", "team_command");
      return {
        status: "IMPLEMENTATION_BLOCKED",
        reason: "redesign",
        suggestedRoute: "FIX_DESIGN",
        evidence: ["old files"],
      };
    }
  });
  const engine = new WorkflowEngine(cwd, runner, {
    progress: () => {},
    ask: async () => undefined,
    approve: async (request) =>
      request.kind === "orphanedImplementation" ? ["discard"] : undefined,
  });
  const state = await engine.start("Fix", cfg);
  await engine.run(state);
  assert.equal(state.phase, "BLOCKED");
  assert.match(state.blocker ?? "", /generated\.json/);
  assert.equal(await readFile(join(cwd, "safe.js"), "utf8"), "safe baseline\n");
  assert.equal(
    await readFile(join(cwd, "generated.json"), "utf8"),
    "command side effect\n",
  );
});
