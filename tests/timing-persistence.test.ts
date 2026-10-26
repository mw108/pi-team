import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import type { Role } from "../src/agents/schemas.ts";
import { WorkflowEngine } from "../src/workflow/engine.ts";
import {
  StatePersistenceError,
  StateStore,
} from "../src/workflow/persistence.ts";
import {
  record,
  toPersistedDurationMs,
  validateState,
  type WorkflowState,
} from "../src/workflow/state.ts";
import { AgentLogStore } from "../src/workflow/agent-logs.ts";
import { FixtureRunner, config, output, repository } from "./helpers.ts";

const ui = {
  progress() {},
  async ask(): Promise<string | undefined> {
    return undefined;
  },
};

test("persisted duration conversion is deterministic, strict, and non-mutating", async () => {
  for (const [input, expected] of [
    [153_942, 153_942],
    [153_942.3678, 153_942],
    [0, 0],
    [0.49, 0],
  ] as const)
    assert.equal(toPersistedDurationMs(input), expected);

  for (const invalid of [
    -1,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    Number.MAX_SAFE_INTEGER * 2,
    "153942",
  ])
    assert.throws(() => toPersistedDurationMs(invalid));

  const cwd = await repository();
  const engine = new WorkflowEngine(cwd, new FixtureRunner(), ui);
  const state = await engine.start("Timing boundary", config());
  const meta = {
    agent: "critic" as const,
    attempt: 1,
    retryNumber: 7,
    durationMs: 153_942.3678,
    timeoutMs: 3_600_000,
    finalError: { requestDurationMs: 0.49 },
  };
  const original = structuredClone(meta);
  record(state, "agent_attempt_completed", "critic run 1 completed", meta);
  assert.deepEqual(meta, original);
  assert.deepEqual(state.history.at(-1)?.meta, {
    agent: "critic",
    attempt: 1,
    retryNumber: 7,
    durationMs: 153_942,
    timeoutMs: 3_600_000,
    finalError: { requestDurationMs: 0 },
  });
  await engine.store.save(state);
  const first = await engine.store.load(state.id);
  await engine.store.save(first);
  assert.deepEqual(await engine.store.load(state.id), first);

  const invalid = structuredClone(state) as any;
  invalid.history.at(-1).meta.durationMs = 1_422_797.375;
  assert.throws(() => validateState(invalid), /Expected integer/);
});

class FractionalProviderRunner extends FixtureRunner {
  readonly emitted: Record<string, unknown>[] = [];
  override async run(role: Role, state: WorkflowState, ...extras: any[]) {
    this.calls.push(role);
    this.counts[role] = (this.counts[role] ?? 0) + 1;
    const providerEvent = extras[7] as
      ((event: Record<string, unknown>) => void) | undefined;
    const start = 1000.125;
    const end = role === "critic" ? 1_154.5678 : 1_200.617;
    const event = {
      type: "reasoning_stall_recovery_started",
      providerRequest: 1,
      provider: "fixture",
      model: "fixture",
      api: "openai-completions",
      networkRetry: 0,
      requestStartedAt: new Date(0).toISOString(),
      requestDurationMs: end - start,
      reasoningOnlyDurationMs: end - start,
      cancellationReason: "reasoning_stall",
    };
    this.emitted.push(event);
    providerEvent?.(event);
    return output(role);
  }
}

test("fractional provider timing persists through the real history path for multiple roles", async () => {
  const cwd = await repository();
  const runner = new FractionalProviderRunner();
  const engine = new WorkflowEngine(cwd, runner, ui);
  const state = await engine.start("Fractional provider timing", config());

  await engine.invoke("critic", state);
  await engine.invoke("researcher", state);

  assert.ok(
    Math.abs(Number(runner.emitted[0].reasoningOnlyDurationMs) - 154.4428) <
      1e-9,
  );
  assert.ok(
    Math.abs(Number(runner.emitted[1].reasoningOnlyDurationMs) - 200.492) <
      1e-9,
  );
  const loaded = await engine.store.load(state.id);
  const timingEvents = loaded.history.filter(
    (event) => event.event === "reasoning_stall_recovery_started",
  );
  assert.deepEqual(
    timingEvents.map((event) => [event.meta?.agent, event.meta?.durationMs]),
    [
      ["critic", 154],
      ["researcher", 200],
    ],
  );
  assert.ok(
    timingEvents.every((event) => Number.isInteger(event.meta?.durationMs)),
  );
  validateState(loaded);
});

test("a background validation failure is controlled and leaves the durable state recoverable", async () => {
  const cwd = await repository();
  const runner = new FractionalProviderRunner();
  const engine = new WorkflowEngine(cwd, runner, ui);
  const state = await engine.start("Controlled persistence failure", config());
  const save = engine.store.save.bind(engine.store);
  let injectedFailures = 0;
  let recursiveSaveAttempts = 0;
  engine.store.save = async (candidate) => {
    if (
      injectedFailures === 0 &&
      candidate.history.at(-1)?.event === "reasoning_stall_recovery_started"
    ) {
      injectedFailures++;
      await save({ ...candidate, questionCount: -1 } as WorkflowState);
      return;
    }
    if (injectedFailures) recursiveSaveAttempts++;
    await save(candidate);
  };
  const unhandled: unknown[] = [];
  const listener = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", listener);
  try {
    await assert.rejects(() => engine.run(state), StatePersistenceError);
    await new Promise<void>((resolve) => setImmediate(resolve));
  } finally {
    process.off("unhandledRejection", listener);
  }

  assert.deepEqual(unhandled, []);
  assert.equal(injectedFailures, 1);
  assert.equal(recursiveSaveAttempts, 0);
  assert.deepEqual(runner.calls, ["orchestrator"]);
  assert.equal(state.phase, "ORCHESTRATE");
  assert.equal(state.blocker, undefined);
  const durable = await new StateStore(cwd).load(state.id);
  assert.equal(durable.phase, "ORCHESTRATE");
  assert.deepEqual(durable.inFlight, {
    phase: "ORCHESTRATE",
    roles: ["orchestrator"],
  });
  assert.equal(durable.questionCount, 0);
  assert.equal(
    durable.history.some(
      (event) => event.event === "reasoning_stall_recovery_started",
    ),
    false,
  );
  assert.match(
    await readFile(
      new AgentLogStore(cwd).path(state.id, "orchestrator", 1),
      "utf8",
    ),
    /workflow_state_persistence_failed/,
  );
});

test("filesystem write failure preserves the prior file and does not poison later saves", async () => {
  const cwd = await repository();
  const engine = new WorkflowEngine(cwd, new FixtureRunner(), ui);
  const state = await engine.start("Atomic write", config());
  const store = engine.store;
  const internal = store as unknown as {
    write(state: WorkflowState): Promise<void>;
  };
  const before = await readFile(store.path(state.id), "utf8");
  const write = internal.write.bind(store);
  internal.write = async () => {
    throw new Error("fixture disk failure");
  };
  state.task = "not durable";
  await assert.rejects(() => store.save(state), StatePersistenceError);
  assert.equal(await readFile(store.path(state.id), "utf8"), before);

  internal.write = write;
  state.task = "durable follow-up";
  await store.save(state);
  assert.equal((await store.load(state.id)).task, "durable follow-up");
});
