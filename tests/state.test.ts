import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { newState, validateState } from "../src/workflow/state.ts";
import { transition } from "../src/workflow/router.ts";
import { StateStore } from "../src/workflow/persistence.ts";
import { config } from "./helpers.ts";
test("legacy contradictory Tester state loads but cannot advance the gate", () => {
  const raw = newState("/tmp", "task", config(), {
    head: null,
    dirtyPaths: [],
    status: "",
    diff: "",
    cachedDiff: "",
  });
  raw.phase = "TEST";
  raw.results.tester = {
    status: "PASS",
    commands: [{ id: "test", exitCode: 0, output: "passed" }],
    failedAreas: [],
    classification: "FIX_LOCAL",
  };
  const loaded = validateState(raw);
  transition(loaded);
  assert.equal(loaded.phase, "BLOCKED");
});
test("version 1 state without additive approval/config fields migrates conservatively", () => {
  const raw: any = newState("/tmp", "task", config(), {
    head: null,
    dirtyPaths: [],
    status: "",
    diff: "",
    cachedDiff: "",
  });
  raw.version = 1;
  for (const key of [
    "approvedCommands",
    "discoveredCommands",
    "approvedDirtyPaths",
    "commandApprovalComplete",
  ])
    delete raw[key];
  delete raw.config.commit;
  delete raw.config.pentest.localHttp;
  const loaded = validateState(raw);
  assert.deepEqual(loaded.approvedCommands, []);
  assert.deepEqual(loaded.approvedDirtyPaths, []);
  assert.deepEqual(loaded.discoveredCommands, []);
  assert.equal(loaded.commandApprovalComplete, false);
  assert.equal(loaded.config.commit.runHooks, false);
  assert.deepEqual(loaded.config.pentest.localHttp.allowedMethods, ["GET"]);
  assert.equal(loaded.version, 3);
});
test("version 2 state loads without inventing semantic drift metadata", () => {
  const raw: any = newState("/tmp", "task", config(), {
    head: null,
    dirtyPaths: [],
    status: "",
    diff: "",
    cachedDiff: "",
  });
  raw.version = 2;
  const loaded = validateState(raw);
  assert.equal(loaded.version, 3);
  assert.equal(loaded.semanticConfigHash, undefined);
  assert.equal(loaded.driftConfigSnapshot, undefined);
  assert.equal(loaded.config.workflow.requestTimeoutMs, undefined);
});
test("older version 3 states default the dedicated Researcher count to zero", () => {
  const raw: any = newState("/tmp", "task", config(), {
    head: null,
    dirtyPaths: [],
    status: "",
    diff: "",
    cachedDiff: "",
  });
  delete raw.researchClarificationCount;
  delete raw.config.workflow.maxResearchClarifications;
  assert.equal(validateState(raw).researchClarificationCount, 0);
  assert.equal(validateState(raw).config.workflow.maxResearchClarifications, 5);
});
test("version 1 string test requirements migrate without inventing paths", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-state-"));
  const raw: any = newState(cwd, "task", config(), {
    head: null,
    dirtyPaths: [],
    status: "",
    diff: "",
    cachedDiff: "",
  });
  raw.version = 1;
  const legacy = {
    goal: "Login",
    filesToModify: [],
    filesToCreate: [],
    filesToDelete: [],
    requiredChanges: [],
    technicalDecisions: [],
    constraints: [],
    requiredTests: ["successful login", "failed login"],
    acceptanceCriteria: [],
    knownRisks: [],
  };
  raw.results = { reviewer: legacy, previous_reviewer: legacy };
  const store = new StateStore(cwd);
  await mkdir(store.dir, { recursive: true });
  await writeFile(store.path(raw.id), JSON.stringify(raw));
  const loaded = await store.load(raw.id);
  assert.equal(loaded.version, 3);
  const migrated = [
    loaded.results.reviewer?.requiredTests,
    loaded.results.previous_reviewer?.requiredTests,
  ];
  for (const tests of migrated)
    assert.deepEqual(tests, [
      { description: "successful login", action: "existing" },
      { description: "failed login", action: "existing" },
    ]);
  await store.save(loaded);
  assert.equal((await store.load(raw.id)).version, 3);
  assert.throws(() => validateState({ ...raw, version: 2 }), /requiredTests/);
});
test("approval state and pending selection survive serialization without global config changes", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-state-")),
    s = newState(cwd, "task", config(), {
      head: null,
      dirtyPaths: ["math.js"],
      status: "",
      diff: "",
      cachedDiff: "",
    });
  const command = {
    id: "detected-test",
    executable: "npm",
    args: ["test"],
    purpose: "test" as const,
    timeoutMs: 1000,
  };
  s.discoveredCommands = [
    { command, source: "package.json", confidence: "high", category: "test" },
  ];
  s.approvedCommands = [command];
  s.approvedDirtyPaths = ["math.js"];
  s.commandApprovalComplete = true;
  s.phase = "WAITING_USER";
  s.resumePhase = "IMPLEMENT";
  s.pendingApproval = {
    kind: "dirtyPaths",
    title: "Approve",
    prompt: "Edit?",
    options: [
      { value: "math.js", label: "math.js", description: "exact file" },
    ],
  };
  const store = new StateStore(cwd);
  await store.save(s);
  assert.deepEqual(await store.load(s.id), s);
});
test("state roundtrip preserves configuration, counters, answers and evidence", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-state-"));
  const s = newState(cwd, "task", config(), {
    head: null,
    dirtyPaths: ["user.txt"],
    status: " M user.txt",
    diff: "user edit",
    cachedDiff: "",
  });
  s.phase = "WAITING_USER";
  s.pendingQuestion = {
    type: "QUESTION_REQUEST",
    blocking: true,
    question: "Which DB?",
    reason: "Contract",
  };
  s.resumePhase = "RESEARCH";
  s.answers.push({ question: "Language?", answer: "TypeScript" });
  const store = new StateStore(cwd);
  await store.save(s);
  assert.deepEqual(await store.load(s.id), s);
});
test("corrupt state fails closed and is not overwritten", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-state-"));
  const s = newState(cwd, "task", config(), {
    head: null,
    dirtyPaths: [],
    status: "",
    diff: "",
    cachedDiff: "",
  });
  const store = new StateStore(cwd);
  await store.save(s);
  await writeFile(store.path(s.id), "{broken");
  await assert.rejects(() => store.load(s.id), /original state preserved/);
  assert.equal(await readFile(store.path(s.id), "utf8"), "{broken");
});
test("repository lock prevents a second live workflow", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-lock-"));
  const store = new StateStore(cwd);
  const unlock = await store.lock();
  await assert.rejects(() => store.lock(), /already running/);
  await unlock();
  await (
    await store.lock()
  )();
});
test("latest skips corrupt newest and multiple corrupt candidates", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-state-"));
  const store = new StateStore(cwd);
  const valid = newState(cwd, "valid", config(), {
    head: null,
    dirtyPaths: [],
    status: "",
    diff: "",
    cachedDiff: "",
  });
  await store.save(valid);
  let corruptId = "";
  for (let i = 0; i < 2; i++) {
    const corrupt = newState(cwd, `corrupt ${i}`, config(), valid.baseline);
    corruptId = corrupt.id;
    await writeFile(store.path(corrupt.id), "{broken");
  }
  assert.equal((await store.latest())?.id, valid.id);
  await assert.rejects(() => store.load(corruptId), /original state preserved/);
  await unlink(store.path(valid.id));
  assert.equal(await store.latest(), undefined);
});
test("legacy valid candidate remains discoverable", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-state-"));
  const store = new StateStore(cwd);
  const old: any = newState(cwd, "old", config(), {
    head: null,
    dirtyPaths: [],
    status: "",
    diff: "",
    cachedDiff: "",
  });
  old.version = 2;
  await mkdir(store.dir, { recursive: true });
  await writeFile(store.path(old.id), JSON.stringify(old));
  assert.equal((await store.latest())?.version, 3);
});
test("lock metadata is complete, exclusive, and protected by owner token", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-lock-"));
  const store = new StateStore(cwd);
  const [first, second] = await Promise.allSettled([
    store.lock(),
    store.lock(),
  ]);
  assert.equal(
    [first, second].filter((r) => r.status === "fulfilled").length,
    1,
  );
  const lockPath = join(store.dir, "active.lock");
  const held = JSON.parse(await readFile(lockPath, "utf8"));
  assert.equal(typeof held.token, "string");
  const winner = first.status === "fulfilled" ? first : second;
  if (winner.status !== "fulfilled") throw new Error("No lock winner");
  const unlock = winner.value;
  await unlink(lockPath);
  await writeFile(
    lockPath,
    JSON.stringify({
      pid: process.pid,
      token: "replacement",
      at: new Date().toISOString(),
    }),
  );
  await unlock();
  assert.equal(
    JSON.parse(await readFile(lockPath, "utf8")).token,
    "replacement",
  );
  await unlink(lockPath);
});
test("dead owner and reused PID locks can be recovered; active age alone is ignored", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-lock-"));
  const store = new StateStore(cwd);
  await mkdir(store.dir, { recursive: true });
  const lockPath = join(store.dir, "active.lock");
  await writeFile(
    lockPath,
    JSON.stringify({ pid: 99999999, at: "2000-01-01T00:00:00Z" }),
  );
  await (
    await store.lock()
  )();
  await writeFile(
    lockPath,
    JSON.stringify({
      pid: process.pid,
      processIdentity: "another process",
      at: "2000-01-01T00:00:00Z",
    }),
  );
  await (
    await store.lock()
  )();
  await writeFile(
    lockPath,
    JSON.stringify({ pid: process.pid, at: "2000-01-01T00:00:00Z" }),
  );
  await assert.rejects(() => store.lock(), /already running/);
  await unlink(lockPath);
  await writeFile(lockPath, "");
  await assert.rejects(() => store.lock(), /incomplete or invalid metadata/);
});
test("concurrent stale-lock recovery leaves one complete owner", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-lock-"));
  const store = new StateStore(cwd);
  await mkdir(store.dir, { recursive: true });
  const lockPath = join(store.dir, "active.lock");
  await writeFile(
    lockPath,
    JSON.stringify({ pid: 99999999, at: "2000-01-01T00:00:00Z" }),
  );
  const outcomes = await Promise.allSettled([store.lock(), store.lock()]);
  const winners = outcomes.filter((result) => result.status === "fulfilled");
  assert.equal(winners.length, 1);
  const owner = JSON.parse(await readFile(lockPath, "utf8"));
  assert.equal(owner.pid, process.pid);
  assert.equal(typeof owner.token, "string");
  await winners[0].value();
});
