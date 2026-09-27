import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { newState, validateState } from "../src/workflow/state.ts";
import { StateStore } from "../src/workflow/persistence.ts";
import { config } from "./helpers.ts";
test("version 1 state without additive approval/config fields migrates conservatively", () => {
  const raw: any = newState("/tmp", "task", config(), {
    head: null,
    dirtyPaths: [],
    status: "",
    diff: "",
    cachedDiff: "",
  });
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
  assert.equal(loaded.version, 1);
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
