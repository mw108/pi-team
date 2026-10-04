import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { WorkflowEngine } from "../src/workflow/engine.ts";
import { dirtyPaths, git } from "../src/workflow/git.ts";
import { getWorkflowRecoveryPlan } from "../src/workflow/recovery.ts";
import teamExtension from "../src/index.ts";
import {
  contract,
  config,
  FixtureRunner,
  output,
  repository,
} from "./helpers.ts";

const ui = {
  progress() {},
  async ask() {
    return undefined;
  },
};
async function interrupted(
  options: { baselineDirty?: boolean; commandOutput?: boolean } = {},
) {
  const cwd = await repository();
  if (options.baselineDirty)
    await writeFile(join(cwd, "user.txt"), "user changes\n");
  const cfg = config();
  cfg.qualityGates.commit.enabled = false;
  cfg.logging.agentLogs.level = "off";
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let release!: (error: Error) => void;
  const held = new Promise<never>((_resolve, reject) => {
    release = reject;
  });
  const runner = new FixtureRunner(async (role, state, _count, observe) => {
    if (role === "reviewer") return { ...contract, filesToCreate: ["new.js"] };
    if (role !== "implementor") return undefined;
    await writeFile(join(cwd, "math.js"), "export const add = (a,b) => a+b;\n");
    await writeFile(join(cwd, "new.js"), "export const newValue = 1;\n");
    await observe?.({ path: "math.js", identity: "math.js", kind: "edit" });
    await observe?.({ path: "new.js", identity: "new.js", kind: "write" });
    if (options.commandOutput)
      await writeFile(join(cwd, "generated.txt"), "command output\n");
    entered();
    return held;
  });
  const engine = new WorkflowEngine(cwd, runner, ui);
  const state = await engine.start("Fix addition", cfg);
  const controller = new AbortController();
  const running = engine.run(state, controller.signal);
  await ready;
  controller.abort();
  release(new Error("interrupted"));
  await running;
  assert.equal(state.phase, "BLOCKED");
  assert.equal(state.interruptedMutationRecovery?.attempt, 1);
  state.manualRetry = { agent: "implementor", phase: "IMPLEMENT" };
  await engine.store.save(state);
  const restarted = new WorkflowEngine(cwd, new FixtureRunner(), ui);
  return {
    cwd,
    state: await restarted.store.load(state.id),
    engine: restarted,
  };
}

test("real stopped Implementor with stale retry survives restart and discards attributed paths", async () => {
  const { cwd, state, engine } = await interrupted();
  const plan = await getWorkflowRecoveryPlan(state, cwd);
  assert.equal(plan.kind, "interrupted-mutation");
  assert.match(plan.reason, /\/team-retry implementor keep/);
  assert.match(plan.reason, /Recommended: \/team-retry implementor discard/);
  await assert.rejects(
    engine.retryAgent(state, "implementor"),
    /explicit recovery choice/,
  );
  await assert.rejects(
    engine.continueBlocked(state),
    /inspect repository changes/,
  );
  const failures = state.agentFailures;
  assert.equal(
    await engine.retryAgent(state, "implementor", false, "discard"),
    "prepared",
  );
  assert.deepEqual(await dirtyPaths(cwd), []);
  assert.equal(
    await readFile(join(cwd, "math.js"), "utf8"),
    "export const add = (a, b) => a - b;\n",
  );
  assert.equal(state.phase, "IMPLEMENT");
  assert.equal(state.manualRetry?.agent, "implementor");
  assert.equal(state.interruptedMutationRecovery, undefined);
  assert.equal(state.agentFailures, failures);
  assert.equal(
    state.history.filter(
      (event) =>
        event.event === "agent_attempt_started" &&
        event.meta?.agent === "implementor",
    ).length,
    1,
  );
  await engine.run(state);
  const runs = state.history.filter(
    (event) =>
      event.event === "agent_attempt_started" &&
      event.meta?.agent === "implementor",
  );
  assert.deepEqual(
    runs.map((event) => event.meta?.attempt),
    [1, 2],
  );
  assert.equal(runs[1].meta?.trigger, "manual_retry");
  assert.equal(runs[1].meta?.retryNumber, 1);
});

test("keep after restart preserves dirty files and replaces stale manual retry", async () => {
  const { cwd, state, engine } = await interrupted();
  const before = await readFile(join(cwd, "math.js"), "utf8");
  const dirty = await dirtyPaths(cwd);
  assert.equal(
    await engine.retryAgent(state, "implementor", false, "keep"),
    "prepared",
  );
  assert.deepEqual(await dirtyPaths(cwd), dirty);
  assert.equal(await readFile(join(cwd, "math.js"), "utf8"), before);
  assert.equal(state.phase, "IMPLEMENT");
  assert.equal(state.manualRetry?.agent, "implementor");
  assert.ok(
    state.history.some((event) => event.event === "manual_retry_recovery_keep"),
  );
  await engine.run(state);
  assert.equal(
    state.history.findLast(
      (event) =>
        event.event === "agent_attempt_started" &&
        event.meta?.agent === "implementor",
    )?.meta?.attempt,
    2,
  );
});

test("discard refuses command output, staging, and post-attempt edits without deleting files", async () => {
  for (const kind of ["command", "staged", "changed"] as const) {
    const { cwd, state, engine } = await interrupted({
      commandOutput: kind === "command",
    });
    if (kind === "staged") await git(cwd, ["add", "math.js"]);
    if (kind === "changed")
      await writeFile(join(cwd, "math.js"), "user edit after interruption\n");
    const before = await dirtyPaths(cwd);
    await assert.rejects(
      engine.retryAgent(state, "implementor", false, "discard"),
      /ambiguous paths/,
    );
    assert.equal(state.phase, "BLOCKED");
    assert.deepEqual(await dirtyPaths(cwd), before);
    if (kind === "command")
      assert.equal(
        await readFile(join(cwd, "generated.txt"), "utf8"),
        "command output\n",
      );
    if (kind === "changed")
      assert.equal(
        await readFile(join(cwd, "math.js"), "utf8"),
        "user edit after interruption\n",
      );
  }
});

test("discard preserves baseline user changes and rejects wrong agent", async () => {
  const { cwd, state, engine } = await interrupted({ baselineDirty: true });
  await assert.rejects(
    engine.retryAgent(state, "tester", false, "discard"),
    /No interrupted mutating attempt/,
  );
  const plan = await getWorkflowRecoveryPlan(state, cwd);
  assert.doesNotMatch(plan.reason, /Recommended:/);
  await engine.retryAgent(state, "implementor", false, "discard");
  assert.deepEqual(await dirtyPaths(cwd), ["user.txt"]);
  assert.equal(await readFile(join(cwd, "user.txt"), "utf8"), "user changes\n");
});

test("legacy interruption without a marker permits keep but cannot invent discard evidence", async () => {
  const { cwd, state, engine } = await interrupted();
  delete state.interruptedMutationRecovery;
  await engine.store.save(state);
  const legacy = await engine.store.load(state.id);
  const plan = await getWorkflowRecoveryPlan(legacy, cwd);
  assert.equal(plan.kind, "interrupted-mutation");
  assert.doesNotMatch(plan.reason, /Recommended:/);
  await assert.rejects(
    engine.retryAgent(legacy, "implementor", false, "discard"),
    /ambiguous paths/,
  );
  assert.equal(
    await engine.retryAgent(legacy, "implementor", false, "keep"),
    "prepared",
  );
});

test("recovery refuses a live owner and invalidates only downstream results", async () => {
  const { state, engine } = await interrupted();
  const live = {
    workflowId: state.id,
    agentId: "implementor" as const,
    attempt: 1,
    session: {} as any,
    startedAt: Date.now(),
    state: "running" as const,
  };
  engine.sessions.register(live);
  await assert.rejects(
    engine.retryAgent(state, "implementor", false, "keep"),
    /currently active/,
  );
  engine.sessions.remove(live);
  for (const role of [
    "codeReviewer",
    "pentester",
    "securityReviewer",
    "tester",
    "commitAgent",
    "reporter",
  ] as const)
    (state.results as Record<string, unknown>)[role] = output(role);
  state.reportInput = { old: true };
  await engine.store.save(state);
  const reviewer = structuredClone(state.results.reviewer);
  const failures = state.agentFailures;
  await engine.retryAgent(state, "implementor", false, "keep");
  assert.deepEqual(state.results.reviewer, reviewer);
  for (const role of [
    "codeReviewer",
    "pentester",
    "securityReviewer",
    "tester",
    "commitAgent",
    "reporter",
  ] as const)
    assert.equal(state.results[role], undefined);
  assert.equal(state.reportInput, undefined);
  assert.equal(state.agentFailures, failures);
});

test("retry command rejects unsupported recovery modes", async () => {
  const cwd = await repository();
  const commands = new Map<string, any>();
  const notices: string[] = [];
  teamExtension({
    on() {},
    registerCommand(name: string, command: any) {
      commands.set(name, command);
    },
  } as any);
  for (const args of [
    "implementor force",
    "implementor reset",
    "implementor yes",
    "implementor keep extra",
  ])
    await commands.get("team-retry").handler(args, {
      cwd,
      ui: { notify: (message: string) => notices.push(message) },
    });
  assert.equal(notices.length, 4);
  for (const notice of notices)
    assert.match(notice, /Usage: \/team-retry <agent-id> \[keep\|discard\]/);
});

test("team-status offers concrete recovery actions with stale inFlight state", async () => {
  const { cwd, state, engine } = await interrupted();
  state.inFlight = { phase: "IMPLEMENT", roles: ["implementor"] };
  await engine.store.save(state);
  const plan = await getWorkflowRecoveryPlan(state, cwd);
  assert.equal(plan.kind, "interrupted-mutation");
  const commands = new Map<string, any>();
  const notices: string[] = [];
  teamExtension({
    on() {},
    registerCommand(name: string, command: any) {
      commands.set(name, command);
    },
  } as any);
  await commands.get("team-status").handler("", {
    cwd,
    ui: { notify: (message: string) => notices.push(message) },
  });
  const status = notices.at(-1) ?? "";
  assert.match(status, /Repository: 2 safe to discard; 0 ambiguous/);
  assert.match(status, /\/team-retry implementor keep/);
  assert.match(status, /\/team-retry implementor discard/);
  assert.match(status, /\/team-abort implementor/);
  assert.equal(
    await engine.retryAgent(state, "implementor", false, "keep"),
    "prepared",
  );
  assert.equal(state.inFlight, undefined);
});

test("advertised abort action ends interrupted recovery and preserves changes", async () => {
  const { cwd, state, engine } = await interrupted();
  const before = await dirtyPaths(cwd);
  const commands = new Map<string, any>();
  const notices: string[] = [];
  teamExtension({
    on() {},
    registerCommand(name: string, command: any) {
      commands.set(name, command);
    },
  } as any);
  await commands.get("team-abort").handler("implementor", {
    cwd,
    ui: { notify: (message: string) => notices.push(message) },
  });
  assert.match(notices.at(-1) ?? "", /recovery aborted/);
  const saved = await engine.store.load(state.id);
  assert.equal(saved.phase, "BLOCKED");
  assert.equal(saved.interruptedMutationRecovery, undefined);
  assert.equal(saved.manualRetry, undefined);
  assert.deepEqual(await dirtyPaths(cwd), before);
});
