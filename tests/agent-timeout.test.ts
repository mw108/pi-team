import assert from "node:assert/strict";
import test from "node:test";
import {
  AgentTimeoutBudget,
  type AgentTimeoutEvent,
} from "../src/agents/agent-timeout.ts";
import { PiRunner } from "../src/agents/runner.ts";
import { WorkflowEngine } from "../src/workflow/engine.ts";
import { FixtureRunner, config, output, repository } from "./helpers.ts";

class FakeClock {
  now = 0;
  private sequence = 0;
  private readonly timers = new Map<
    object,
    { due: number; sequence: number; callback: () => void }
  >();

  setTimer = (callback: () => void, delayMs: number) => {
    const token = {};
    this.timers.set(token, {
      due: this.now + delayMs,
      sequence: this.sequence++,
      callback,
    });
    return token as ReturnType<typeof setTimeout>;
  };

  clearTimer = (timer: ReturnType<typeof setTimeout>) => {
    this.timers.delete(timer as object);
  };

  advance(ms: number) {
    const target = this.now + ms;
    while (true) {
      const next = [...this.timers.entries()]
        .filter(([, timer]) => timer.due <= target)
        .sort(
          ([, left], [, right]) =>
            left.due - right.due || left.sequence - right.sequence,
        )[0];
      if (!next) break;
      const [token, timer] = next;
      this.timers.delete(token);
      this.now = timer.due;
      timer.callback();
    }
    this.now = target;
  }

  count() {
    return this.timers.size;
  }
}

function budget(timeoutMs: number | undefined) {
  const clock = new FakeClock();
  const events: AgentTimeoutEvent[] = [];
  let timeouts = 0;
  const value = new AgentTimeoutBudget(timeoutMs, {
    now: () => clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    onTimeout: () => timeouts++,
    onEvent: (event) => events.push(event),
  });
  value.start();
  return { value, clock, events, timeouts: () => timeouts };
}

test("three-hour approval wait preserves the exact active execution budget", () => {
  const { value, clock, events, timeouts } = budget(60 * 60_000);
  clock.advance(15 * 60_000);
  const release = value.pause("runtime_command_approval");
  clock.advance(3 * 60 * 60_000);
  assert.equal(value.elapsed(), 15 * 60_000);
  assert.equal(value.remaining(), 45 * 60_000);
  assert.equal(timeouts(), 0);
  release();
  clock.advance(10 * 60_000);
  assert.equal(value.elapsed(), 25 * 60_000);
  assert.equal(value.remaining(), 35 * 60_000);
  assert.equal(value.waiting(), 3 * 60 * 60_000);
  assert.deepEqual(
    events.map((event) => event.type),
    ["agent_timeout_paused", "agent_timeout_resumed"],
  );
});

test("timeout accounting retains fractional monotonic precision", () => {
  const { value, clock, timeouts } = budget(1_000);
  clock.now = 1_000.125;
  value.stop();
  const precise = new AgentTimeoutBudget(1_000, {
    now: () => clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    onTimeout: () => {},
  });
  precise.start();
  clock.now = 1_154.5678;
  assert.ok(Math.abs(precise.elapsed()! - 154.4428) < 1e-9);
  assert.ok(Math.abs(precise.remaining()! - 845.5572) < 1e-9);
  assert.equal(timeouts(), 0);
});

test("sequential approvals accumulate active time without resetting the budget", () => {
  const { value, clock, timeouts } = budget(60 * 60_000);
  for (const [active, waiting, reason] of [
    [10, 120, "runtime_command_approval"],
    [5, 30, "runtime_file_approval"],
    [15, 240, "contract_path_approval"],
  ] as const) {
    clock.advance(active * 60_000);
    const release = value.pause(reason);
    clock.advance(waiting * 60_000);
    release();
  }
  clock.advance(10 * 60_000);
  assert.equal(value.elapsed(), 40 * 60_000);
  assert.equal(value.remaining(), 20 * 60_000);
  assert.equal(value.waiting(), 390 * 60_000);
  assert.equal(timeouts(), 0);
});

test("nested pause tokens and duplicate releases cannot resume prematurely", () => {
  const { value, clock, events, timeouts } = budget(100);
  clock.advance(20);
  const releasePreflight = value.pause("model_preflight");
  clock.advance(1_000);
  const releaseApproval = value.pause("runtime_command_approval");
  releasePreflight();
  releasePreflight();
  clock.advance(1_000);
  assert.equal(value.remaining(), 80);
  assert.equal(clock.count(), 0);
  releaseApproval();
  assert.equal(clock.count(), 1);
  clock.advance(79);
  assert.equal(timeouts(), 0);
  clock.advance(1);
  assert.equal(timeouts(), 1);
  assert.deepEqual(
    events.map((event) => event.type),
    ["agent_timeout_paused", "agent_timeout_resumed"],
  );
});

test("exceptions release pause ownership and an expired budget cannot revive", async () => {
  const { value, clock, timeouts } = budget(50);
  await assert.rejects(
    value.withPaused("runtime_file_approval", async () => {
      clock.advance(500);
      throw new Error("approval failed");
    }),
    /approval failed/,
  );
  assert.equal(value.remaining(), 50);
  clock.advance(50);
  assert.equal(timeouts(), 1);
  const release = value.pause("runtime_file_approval");
  clock.advance(500);
  release();
  assert.equal(timeouts(), 1);
  assert.equal(value.remaining(), 0);
});

test("unlimited timeout keeps pause operations as safe timer no-ops", async () => {
  const { value, clock, events, timeouts } = budget(undefined);
  await value.withPaused("runtime_command_approval", async () => {
    clock.advance(24 * 60 * 60_000);
  });
  assert.equal(value.elapsed(), null);
  assert.equal(value.remaining(), null);
  assert.equal(clock.count(), 0);
  assert.equal(timeouts(), 0);
  assert.deepEqual(events, []);
});

test("runner excludes sequential command, file, and contract user waits", async () => {
  const cwd = await repository();
  const cfg = config();
  cfg.agents.researcher.timeoutMs = 1_000;
  const state = await new WorkflowEngine(cwd, new FixtureRunner(), {
    progress: () => {},
    ask: async () => undefined,
  }).start("Approval timeout integration", cfg);
  const runner = new PiRunner();
  runner.createSession = async (...args: any[]) => {
    const runtimeApproval = args[9];
    const fileApproval = args[10];
    const contractApproval = args[15];
    return {
      messages: [{ role: "assistant", stopReason: "end" }],
      prompt: async () => {
        assert.equal(await runtimeApproval({} as any, {} as any), "allow");
        assert.equal(await fileApproval("read", ".env"), true);
        assert.equal(
          await contractApproval.request("modify", "src/a.ts", "required"),
          true,
        );
        await new Promise((resolve) => setTimeout(resolve, 100));
      },
      abort: async () => {},
      getLastAssistantText: () => JSON.stringify(output("researcher")),
      extensionRunner: { emit: async () => {} },
      dispose: () => {},
    } as any;
  };
  const wait = () => new Promise<void>((resolve) => setTimeout(resolve, 400));
  const timeoutEvents: AgentTimeoutEvent[] = [];
  const result = await runner.run(
    "researcher",
    state,
    undefined,
    undefined,
    1,
    undefined,
    undefined,
    undefined,
    undefined,
    (event) => {
      if (event.type.startsWith("agent_timeout_"))
        timeoutEvents.push(event as AgentTimeoutEvent);
    },
    undefined,
    async (_command, _request, _signal, waitForHumanInput) =>
      waitForHumanInput!("runtime_command_approval", async () => {
        await wait();
        return "allow" as const;
      }),
    undefined,
    undefined,
    undefined,
    undefined,
    {
      request: async (_operation, _path, _reason, _signal, waitForHumanInput) =>
        waitForHumanInput!("contract_path_approval", async () => {
          await wait();
          return true;
        }),
      consumeOnce: () => false,
    },
    async (_operation, _path, _signal, waitForHumanInput) =>
      waitForHumanInput!("runtime_file_approval", async () => {
        await wait();
        return true;
      }),
  );
  assert.deepEqual(result, output("researcher"));
  assert.deepEqual(
    timeoutEvents.map((event) => [event.type, event.reason]),
    [
      ["agent_timeout_paused", "runtime_command_approval"],
      ["agent_timeout_resumed", "runtime_command_approval"],
      ["agent_timeout_paused", "runtime_file_approval"],
      ["agent_timeout_resumed", "runtime_file_approval"],
      ["agent_timeout_paused", "contract_path_approval"],
      ["agent_timeout_resumed", "contract_path_approval"],
    ],
  );
});

test("late denial keeps denial semantics instead of becoming an agent timeout", async () => {
  const cwd = await repository();
  const cfg = config();
  cfg.agents.researcher.timeoutMs = 1_000;
  const state = await new WorkflowEngine(cwd, new FixtureRunner(), {
    progress: () => {},
    ask: async () => undefined,
  }).start("Late denial integration", cfg);
  const runner = new PiRunner();
  runner.createSession = async (...args: any[]) => {
    const runtimeApproval = args[9];
    return {
      messages: [{ role: "assistant", stopReason: "end" }],
      prompt: async () => {
        assert.equal(await runtimeApproval({} as any, {} as any), "deny");
      },
      abort: async () => {},
      getLastAssistantText: () => JSON.stringify(output("researcher")),
      extensionRunner: { emit: async () => {} },
      dispose: () => {},
    } as any;
  };
  const result = await runner.run(
    "researcher",
    state,
    undefined,
    undefined,
    1,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    async (_command, _request, _signal, waitForHumanInput) =>
      waitForHumanInput!("runtime_command_approval", async () => {
        await new Promise((resolve) => setTimeout(resolve, 1_100));
        return "deny" as const;
      }),
  );
  assert.deepEqual(result, output("researcher"));
});

test("workflow cancellation remains effective while an approval owns a pause", async () => {
  const cwd = await repository();
  const cfg = config();
  cfg.agents.researcher.timeoutMs = 1_000;
  const state = await new WorkflowEngine(cwd, new FixtureRunner(), {
    progress: () => {},
    ask: async () => undefined,
  }).start("Cancelled approval integration", cfg);
  const runner = new PiRunner();
  runner.createSession = async (...args: any[]) => {
    const getSignal = args[5];
    const runtimeApproval = args[9];
    return {
      messages: [{ role: "assistant", stopReason: "end" }],
      prompt: async () => {
        await runtimeApproval({} as any, {} as any, getSignal());
      },
      abort: async () => {},
      getLastAssistantText: () => JSON.stringify(output("researcher")),
      extensionRunner: { emit: async () => {} },
      dispose: () => {},
    } as any;
  };
  const controller = new AbortController();
  const running = runner.run(
    "researcher",
    state,
    controller.signal,
    undefined,
    1,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    async (_command, _request, signal, waitForHumanInput) =>
      waitForHumanInput!(
        "runtime_command_approval",
        () =>
          new Promise<"pending">((resolve) => {
            if (signal?.aborted) resolve("pending");
            else
              signal?.addEventListener("abort", () => resolve("pending"), {
                once: true,
              });
          }),
      ),
  );
  setTimeout(() => controller.abort(), 50);
  await assert.rejects(running, /Workflow interrupted/);
});
