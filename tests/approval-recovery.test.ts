import test from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import teamExtension from "../src/index.ts";
import { PiRunner } from "../src/agents/runner.ts";
import { FixtureRunner } from "./helpers.ts";
import { WorkflowEngine } from "../src/workflow/engine.ts";
import { StatePersistenceError } from "../src/workflow/persistence.ts";
import { getWorkflowRecoveryPlan } from "../src/workflow/recovery.ts";
import { captureProcessIdentity } from "../src/workflow/execution-identity.ts";
import { effectiveConfig, commandKey } from "../src/agents/discovery.ts";
import { normalizedRuntimeCommand } from "../src/agents/runtime-commands.ts";
import { git } from "../src/workflow/git.ts";
import { approvalRecoveryFixture } from "./fixtures/approval-recovery.ts";

function handlers(cwd: string, choices: string[][] = []) {
  const commands = new Map<string, any>();
  const notices: string[] = [];
  const dialogs: any[] = [];
  teamExtension({
    on() {},
    events: { emit() {} },
    appendEntry(_type: string, data: any) {
      if (data.params) dialogs.push(data);
    },
    registerCommand(name: string, command: any) {
      commands.set(name, command);
    },
  } as any);
  const ctx = {
    cwd,
    mode: "tui",
    hasUI: true,
    waitForIdle: async () => {},
    ui: {
      notify(message: string) {
        notices.push(message);
      },
      setStatus() {},
      setWidget() {},
      setWorkingVisible() {},
      async custom() {
        return {
          mode: "submit",
          cancelled: false,
          questions: [],
          answers: { approval: { values: choices.shift() ?? [] } },
        };
      },
    },
  };
  return {
    commands,
    notices,
    dialogs,
    ctx,
    async invoke(command: string, args = "") {
      const before = notices.length;
      await commands.get(command).handler(args, ctx);
      const deadline = Date.now() + 10000;
      while (
        notices.length === before ||
        notices.at(-1)?.includes("retry prepared")
      ) {
        if (Date.now() > deadline)
          throw new Error("Command did not settle: " + notices.join("\n"));
        await new Promise((r) => setTimeout(r, 5));
      }
      // Final notification precedes the background task's ownership cleanup.
      await new Promise((r) => setImmediate(r));
    },
  };
}

test("incident /team resume reconciles the resolved legacy v3 approval; explicit /team-retry recover starts only attempt two", async () => {
  const f = await approvalRecoveryFixture();
  const upstream = structuredClone(f.state.results);
  const calls = new FixtureRunner();
  const original = PiRunner.prototype.run;
  PiRunner.prototype.run = async function (role, state, ...extras: any[]) {
    if (role === "pentester") {
      const approve = extras[9];
      const exact = normalizedRuntimeCommand(
        {
          executable: f.command.executable,
          args: f.command.args,
          purpose: "Synthetic check",
          category: "pentest",
        },
        role,
      );
      assert.equal(
        await approve(exact.command, exact.request, extras[0]),
        "allow",
      );
      const different = normalizedRuntimeCommand(
        {
          executable: f.command.executable,
          args: [...f.command.args, "different"],
          purpose: "Synthetic check",
          category: "pentest",
        },
        role,
      );
      assert.equal(
        await approve(different.command, different.request, extras[0]),
        "deny",
      );
    }
    return calls.run(role, state, ...extras);
  } as typeof PiRunner.prototype.run;
  try {
    const h = handlers(f.cwd, [["recover"], ["deny"]]);
    for (let i = 0; i < 2; i++) await h.invoke("team", `resume ${f.state.id}`);
    let saved = await f.engine.store.load(f.state.id);
    assert.match(saved.blocker!, /^Command approval resolved/);
    assert.equal(saved.phase, "BLOCKED");
    assert.deepEqual(saved.results, upstream);
    assert.equal(calls.calls.length, 0);
    assert.equal(h.dialogs.length, 0);
    assert.match(h.notices.at(-1)!, /\/team-retry pentester recover/);
    assert.doesNotMatch(h.notices.at(-1)!, /Waiting for tool approval/);
    assert.equal(
      saved.history.filter(
        (e) => e.event === "command_approval_recovery_required",
      ).length,
      1,
    );
    await h.invoke("team-continue");
    assert.match(h.notices.at(-1)!, /\/team-retry pentester recover/);
    await h.invoke("team-retry", "pentester recover");
    saved = await f.engine.store.load(f.state.id);
    assert.equal(saved.phase, "DONE", h.notices.join("\n"));
    assert.equal(calls.counts.pentester, 1);
    for (const role of Object.keys(upstream)) {
      assert.equal(calls.counts[role as keyof typeof calls.counts], undefined);
      assert.deepEqual(saved.results[role], upstream[role]);
    }
    const executions = saved.executions.filter((e) => e.agent === "pentester");
    assert.deepEqual(
      executions.map((e) => e.attempt),
      [1, 2],
    );
    assert.notEqual(executions[0].id, executions[1].id);
    assert.equal(executions[0].status, "COMPLETED");
    assert.equal(h.dialogs.length, 2); // Recovery review, then the different argv.
    assert.equal(
      saved.history.filter(
        (e) =>
          e.event === "agent_attempt_started" && e.meta?.agent === "pentester",
      ).length,
      2,
    );
  } finally {
    PiRunner.prototype.run = original;
  }
});

for (const decision of ["deny", "allow_once", "allow_workflow"])
  test(`resolved ${decision} preserves its authorization scope and does not start an agent on resume`, async () => {
    const f = await approvalRecoveryFixture(decision);
    const runner = new FixtureRunner();
    const engine = new WorkflowEngine(f.cwd, runner, {
      progress() {},
      ask: async () => undefined,
    });
    await engine.resumeReadonly(f.state);
    await engine.run(f.state);
    assert.equal(runner.calls.length, 0);
    assert.match(f.state.blocker!, /^Command approval resolved/);
    assert.equal(
      f.state.runtimeCommandApprovals.length,
      decision === "allow_workflow" ? 1 : 0,
    );
    const approved = effectiveConfig(f.state, "pentester").commands;
    assert.equal(
      approved.some((c) => commandKey(c) === commandKey(f.command)),
      decision === "allow_workflow",
    );
    assert.equal(
      approved.some(
        (c) =>
          commandKey(c) ===
          commandKey({ ...f.command, args: [...f.command.args, "different"] }),
      ),
      false,
    );
    await assert.rejects(
      engine.retryAgent(f.state, "pentester"),
      /pentester recover/,
    );
  });

test("cancelled saved review preserves unresolved permission and the ended attempt", async () => {
  const f = await approvalRecoveryFixture(null);
  const h = handlers(f.cwd, [[]]);
  await h.invoke("team", `resume ${f.state.id}`);
  const saved = await f.engine.store.load(f.state.id);
  assert.equal(saved.pendingRuntimeCommands.length, 1);
  assert.equal(saved.runtimeCommandApprovals.length, 0);
  assert.equal(saved.executions.length, 1);
  assert.match(
    h.notices.at(-1)!,
    /ended command continuation cannot be resumed/,
  );
});

test("saved workflow permission review and blocker reconciliation are durable without replay", async () => {
  const f = await approvalRecoveryFixture(null);
  const h = handlers(f.cwd, [["allow_workflow"]]);
  await h.invoke("team", `resume ${f.state.id}`);
  const saved = await f.engine.store.load(f.state.id);
  assert.equal(saved.pendingRuntimeCommands.length, 0);
  assert.equal(saved.runtimeCommandApprovals.length, 1);
  assert.match(saved.blocker!, /^Command approval resolved/);
  assert.match(h.notices.at(-1)!, /pentester recover/);
  assert.equal(saved.executions.length, 1);
});

for (const mismatch of ["attempt", "request", "execution", "unrelated-blocker"])
  test(`${mismatch} mismatch cannot reconcile a stale decision`, async () => {
    const f = await approvalRecoveryFixture();
    const requested = f.state.history.findLast(
      (e) => e.event === "command_approval_requested",
    )!;
    const decided = f.state.history.findLast(
      (e) => e.event === "command_approval_decided",
    )!;
    if (mismatch === "attempt") decided.meta!.attempt = 2;
    if (mismatch === "request") {
      requested.meta!.requestId = randomUUID();
      decided.meta!.requestId = randomUUID();
    }
    if (mismatch === "execution") {
      requested.meta!.executionId = randomUUID();
      decided.meta!.executionId = requested.meta!.executionId;
    }
    if (mismatch === "unrelated-blocker")
      f.state.blocker = "Repository HEAD changed";
    await f.engine.store.save(f.state);
    await f.engine.resumeReadonly(f.state);
    assert.equal(
      f.state.history.some(
        (e) => e.event === "command_approval_recovery_required",
      ),
      false,
    );
    assert.notEqual(
      (await getWorkflowRecoveryPlan(f.state, f.cwd)).kind,
      "interrupted-quality-gate",
    );
  });

test("a duplicated decision is idempotent; concurrent resumes cannot duplicate reconciliation", async () => {
  const f = await approvalRecoveryFixture();
  f.state.history.push(structuredClone(f.state.history.at(-1)!));
  await f.engine.store.save(f.state);
  const engines = [0, 1].map(
    () =>
      new WorkflowEngine(f.cwd, new FixtureRunner(), {
        progress() {},
        ask: async () => undefined,
      }),
  );
  const outcomes = await Promise.allSettled(
    engines.map(async (e) => e.resumeReadonly(await e.store.load(f.state.id))),
  );
  assert.ok(outcomes.some((o) => o.status === "fulfilled"));
  const saved = await f.engine.store.load(f.state.id);
  assert.equal(
    saved.history.filter(
      (e) => e.event === "command_approval_recovery_required",
    ).length,
    1,
  );
  assert.equal(saved.executions.length, 1);
});

test("failure while saving reconciliation is repeatable from the last durable decision", async () => {
  const f = await approvalRecoveryFixture();
  const engine = new WorkflowEngine(f.cwd, new FixtureRunner(), {
    progress() {},
    ask: async () => undefined,
  });
  const save = engine.store.save.bind(engine.store);
  engine.store.save = async () => {
    throw new StatePersistenceError(
      f.state.id,
      new Error("synthetic crash before atomic rename"),
    );
  };
  await assert.rejects(
    engine.resumeReadonly(await engine.store.load(f.state.id)),
    /was not saved/,
  );
  assert.equal(
    (await engine.store.load(f.state.id)).history.some(
      (e) => e.event === "command_approval_recovery_required",
    ),
    false,
  );
  engine.store.save = save;
  await engine.resumeReadonly(await engine.store.load(f.state.id));
  assert.equal(
    (await engine.store.load(f.state.id)).history.filter(
      (e) => e.event === "command_approval_recovery_required",
    ).length,
    1,
  );
});

test("managed child activity cannot be overridden by a resolved approval", async () => {
  const f = await approvalRecoveryFixture();
  f.state.executions[0].children.push({
    id: randomUUID(),
    status: "RUNNING",
    process: await captureProcessIdentity(),
  });
  await f.engine.store.save(f.state);
  await f.engine.resumeReadonly(f.state);
  const plan = await getWorkflowRecoveryPlan(f.state, f.cwd);
  assert.equal(plan.kind, "unsafe");
  assert.match(plan.reason, /ACTIVE/);
  await assert.rejects(
    f.engine.retryAgent(f.state, "pentester", false, "recover"),
    /ACTIVE/,
  );
});

test("repository changes before explicit retry keep the existing recovery guards", async () => {
  const f = await approvalRecoveryFixture();
  await f.engine.resumeReadonly(f.state);
  await writeFile(join(f.cwd, "math.js"), "// external change\n");
  await assert.rejects(
    f.engine.retryAgent(f.state, "pentester", false, "recover"),
    /Repository changed|ambiguous/,
  );
  assert.equal((await f.engine.store.load(f.state.id)).executions.length, 1);
});

test("pending decision from another attempt cannot grant workflow permission on resume", async () => {
  const f = await approvalRecoveryFixture(null);
  f.state.pendingRuntimeCommands[0].run = 2;
  await f.engine.store.save(f.state);
  const h = handlers(f.cwd, [["allow_workflow"]]);
  await h.invoke("team", `resume ${f.state.id}`);
  const saved = await f.engine.store.load(f.state.id);
  assert.equal(h.dialogs.length, 0);
  assert.equal(saved.runtimeCommandApprovals.length, 0);
  assert.equal(saved.pendingRuntimeCommands.length, 1);
  assert.match(
    h.notices.at(-1)!,
    /does not match the current workflow attempt/,
  );
});

test("concurrent explicit recover operations accept only one retry reservation", async () => {
  const f = await approvalRecoveryFixture();
  const engines = [0, 1].map(
    () =>
      new WorkflowEngine(f.cwd, new FixtureRunner(), {
        progress() {},
        ask: async () => undefined,
        approve: async () => ["recover"],
      }),
  );
  const results = await Promise.allSettled(
    engines.map(async (e) =>
      e.retryAgent(
        await e.store.load(f.state.id),
        "pentester",
        false,
        "recover",
      ),
    ),
  );
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  const saved = await f.engine.store.load(f.state.id);
  assert.equal(saved.executions.length, 1);
  assert.equal(
    saved.history.filter(
      (e) => e.event === "interrupted_agent_recovery_accepted",
    ).length,
    1,
  );
});

test("changed HEAD cannot be overridden by resolved command permission", async () => {
  const f = await approvalRecoveryFixture();
  await f.engine.resumeReadonly(f.state);
  await git(f.cwd, [
    "-c",
    "core.hooksPath=/dev/null",
    "commit",
    "--allow-empty",
    "-m",
    "test: external HEAD change",
  ]);
  let prompted = false;
  (f.engine.ui as any).approve = async () => {
    prompted = true;
    return ["recover"];
  };
  await assert.rejects(
    f.engine.retryAgent(f.state, "pentester", false, "recover"),
    /HEAD/,
  );
  assert.equal(prompted, false);
  assert.equal((await f.engine.store.load(f.state.id)).executions.length, 1);
});

test("uncertain child startup prevents approval recovery", async () => {
  const f = await approvalRecoveryFixture();
  f.state.executions[0].children.push({ id: randomUUID(), status: "STARTING" });
  await f.engine.store.save(f.state);
  await f.engine.resumeReadonly(f.state);
  assert.equal((await getWorkflowRecoveryPlan(f.state, f.cwd)).kind, "unsafe");
  await assert.rejects(
    f.engine.retryAgent(f.state, "pentester", false, "recover"),
    /UNKNOWN/,
  );
});

test("cancelling explicit recovery preserves the resolved permission without scheduling an attempt", async () => {
  const f = await approvalRecoveryFixture();
  const h = handlers(f.cwd, [["cancel"]]);
  await h.invoke("team-retry", "pentester recover");
  const saved = await f.engine.store.load(f.state.id);
  assert.equal(saved.manualRetry, undefined);
  assert.equal(saved.executions.length, 1);
  assert.equal(saved.runtimeCommandApprovals.length, 1);
  assert.match(h.notices.at(-1)!, /Recovery cancelled/);
});

test("discovery completion and a reusable grant cannot substitute for a recorded approval decision", async () => {
  const f = await approvalRecoveryFixture();
  f.state.history = f.state.history.filter(
    (e) => e.event !== "command_approval_decided",
  );
  await f.engine.store.save(f.state);
  await f.engine.resumeReadonly(f.state);
  assert.equal(f.state.commandApprovalComplete, true);
  assert.equal(f.state.runtimeCommandApprovals.length, 1);
  assert.equal(
    f.state.history.some(
      (e) => e.event === "command_approval_recovery_required",
    ),
    false,
  );
  assert.notEqual(
    (await getWorkflowRecoveryPlan(f.state, f.cwd)).kind,
    "interrupted-quality-gate",
  );
});
