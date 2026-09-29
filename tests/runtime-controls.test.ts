import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { ActiveSessionRegistry } from "../src/agents/active-sessions.ts";
import { AgentAbortedByUserError } from "../src/agents/errors.ts";
import { PiRunner, type AgentRunner } from "../src/agents/runner.ts";
import type { Role } from "../src/agents/schemas.ts";
import { WorkflowEngine } from "../src/workflow/engine.ts";
import {
  output,
  repository,
  config,
  FixtureRunner,
  research,
  contract,
} from "./helpers.ts";

const ui = {
  progress() {},
  async ask() {
    return undefined;
  },
};
async function until(predicate: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for agent");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
function waitForAbort(signal?: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    const cancel = () => reject(new Error("aborted"));
    if (signal?.aborted) cancel();
    else signal?.addEventListener("abort", cancel, { once: true });
  });
}

class PendingRunner implements AgentRunner {
  calls: {
    role: Role;
    attempt: number;
    signal?: AbortSignal;
    resolve(value: unknown): void;
    reject(error: unknown): void;
  }[] = [];
  async run(
    role: Role,
    _state: any,
    signal?: AbortSignal,
    _activity?: any,
    attempt = 1,
  ) {
    return await new Promise((resolve, reject) => {
      const call = { role, attempt, signal, resolve, reject };
      this.calls.push(call);
      const cancel = () => reject(new Error("Request aborted"));
      if (signal?.aborted) cancel();
      else signal?.addEventListener("abort", cancel, { once: true });
    });
  }
}

test("session registry keys by workflow and agent, steers the same object, and removes only its own attempt", async () => {
  const registry = new ActiveSessionRegistry();
  const steered: string[] = [];
  const session = {
    steer: async (message: string) => {
      steered.push(message);
    },
  } as AgentSession;
  const first = {
    workflowId: "one",
    agentId: "solver1" as const,
    attempt: 1,
    session,
    startedAt: Date.now(),
    state: "running" as const,
  };
  const sibling = { ...first, agentId: "solver2" as const };
  const other = { ...first, workflowId: "two" };
  registry.register(first);
  registry.register(sibling);
  registry.register(other);
  assert.equal(registry.list("one").length, 2);
  await registry.steer(
    "one",
    "solver1",
    "Use existing context.\nFinalize now.",
  );
  assert.deepEqual(steered, ["Use existing context.\nFinalize now."]);
  assert.equal(registry.get("one", "solver1")?.session, session);
  assert.equal(registry.get("one", "solver1")?.attempt, 1);
  registry.remove(first);
  assert.equal(registry.get("one", "solver1"), undefined);
  assert.ok(registry.get("one", "solver2"));
  assert.ok(registry.get("two", "solver1"));
  await assert.rejects(
    registry.steer("one", "solver1", "later"),
    /not currently running/,
  );
  const replacement = { ...first, attempt: 2 };
  registry.register(replacement);
  registry.remove(first);
  assert.equal(registry.get("one", "solver1")?.attempt, 2);
  await registry.steer("one", "solver1", "new attempt only");
  assert.deepEqual(steered, [
    "Use existing context.\nFinalize now.",
    "new attempt only",
  ]);
});

test("Pi runner steering preserves its session and attempt until completion", async () => {
  const cwd = await repository();
  const runner = new PiRunner();
  let finish!: () => void;
  const waitForFinish = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const steered: string[] = [];
  let disposed = 0;
  let created = 0;
  runner.createSession = async () => {
    created++;
    const session: any = {
      messages: [{ role: "assistant", stopReason: "stop" }],
      prompt: async () => {
        await waitForFinish;
      },
      steer: async (message: string) => {
        steered.push(message);
      },
      getSteeringMessages: () => [],
      abort: async () => {},
      getLastAssistantText: () => JSON.stringify(output("solver1")),
      extensionRunner: { emit: async () => {} },
      dispose: () => {
        disposed++;
      },
    };
    return session;
  };
  const engine = new WorkflowEngine(cwd, runner, ui);
  const state = await engine.start("Fix", config());
  state.phase = "SOLVE";
  const pending = engine.invoke("solver1", state);
  await until(() => engine.sessions.list(state.id).length === 1);
  const session = engine.sessions.get(state.id, "solver1")?.session;
  await engine.steer(
    state,
    "solver1",
    "Stop repeating failed reads.\nFinalize now.",
  );
  assert.equal(created, 1);
  assert.equal(engine.sessions.get(state.id, "solver1")?.session, session);
  assert.equal(engine.sessions.get(state.id, "solver1")?.attempt, 1);
  assert.deepEqual(steered, ["Stop repeating failed reads.\nFinalize now."]);
  finish();
  await pending;
  assert.equal(disposed, 1);
  assert.equal(engine.sessions.list(state.id).length, 0);
});

test("manual abort stops one attempt without hard retry or failure accounting", async () => {
  const cwd = await repository();
  const runner = new PendingRunner();
  const engine = new WorkflowEngine(cwd, runner, ui);
  const state = await engine.start("Fix", config());
  state.phase = "SOLVE";
  const first = engine.invoke("solver1", state);
  const second = engine.invoke("solver2", state);
  await until(() => runner.calls.length === 2);
  const unrelated = { ...state, id: randomUUID() };
  await assert.rejects(
    engine.abortAgent(unrelated, "solver1"),
    /not currently running/,
  );
  await assert.rejects(
    engine.retryAgent(unrelated, "solver1"),
    /Workflow mismatch/,
  );
  assert.equal(
    runner.calls.find((call) => call.role === "solver1")?.signal?.aborted,
    false,
  );
  await engine.abortAgent(state, "solver1");
  await assert.rejects(first, AgentAbortedByUserError);
  assert.equal(runner.calls.length, 2);
  assert.equal(
    runner.calls.find((call) => call.role === "solver2")?.signal?.aborted,
    false,
  );
  runner.calls
    .find((call) => call.role === "solver2")!
    .resolve(output("solver2"));
  await second;
  assert.equal(state.agentFailures, 0);
  assert.equal(
    state.history.filter((event) => event.event === "agent_retry").length,
    0,
  );
  assert.equal(
    state.history.filter((event) => event.event === "agent_aborted_by_user")
      .length,
    1,
  );
});

test("retry racing with natural completion creates one replacement attempt", async () => {
  const cwd = await repository();
  const runner = new PendingRunner();
  const engine = new WorkflowEngine(cwd, runner, ui);
  const state = await engine.start("Fix", config());
  state.phase = "SOLVE";
  const pending = engine.invoke("solver1", state);
  await until(() => runner.calls.length === 1);
  runner.calls[0].resolve(output("solver1"));
  await engine.retryAgent(state, "solver1");
  await until(() => runner.calls.length === 2);
  runner.calls[1].resolve(output("solver1"));
  await pending;
  assert.deepEqual(
    runner.calls.map((call) => call.attempt),
    [1, 2],
  );
  assert.equal(
    state.history.filter(
      (event) =>
        event.event === "agent_attempt_completed" &&
        event.meta?.agent === "solver1",
    ).length,
    1,
  );
});

test("manual retry aborts the old attempt, starts a new number, and leaves siblings running", async () => {
  const cwd = await repository();
  const runner = new PendingRunner();
  const engine = new WorkflowEngine(cwd, runner, ui);
  const state = await engine.start("Fix", config());
  state.phase = "SOLVE";
  const first = engine.invoke("solver1", state);
  const sibling = engine.invoke("solver2", state);
  await until(() => runner.calls.length === 2);
  await engine.retryAgent(state, "solver1");
  await assert.rejects(
    engine.retryAgent(state, "solver1"),
    /already restarting/,
  );
  await until(() => runner.calls.length === 3);
  const replacement = runner.calls.find(
    (call) => call.role === "solver1" && call.attempt === 2,
  );
  assert.ok(replacement);
  assert.equal(
    runner.calls.find((call) => call.role === "solver1" && call.attempt === 1)
      ?.signal?.aborted,
    true,
  );
  assert.equal(
    runner.calls.find((call) => call.role === "solver2")?.signal?.aborted,
    false,
  );
  replacement.resolve(output("solver1"));
  runner.calls
    .find((call) => call.role === "solver2")!
    .resolve(output("solver2"));
  await Promise.all([first, sibling]);
  assert.equal(state.agentFailures, 0);
  assert.deepEqual(
    state.history
      .filter(
        (event) =>
          event.event === "agent_attempt_started" &&
          event.meta?.agent === "solver1",
      )
      .map((event) => event.meta?.attempt),
    [1, 2],
  );
  assert.equal(
    state.history.filter((event) => event.event === "agent_retry").length,
    0,
  );
});

test("manual retry recovers a Critic blocked by its own failure", async () => {
  const cwd = await repository();
  const runner = new FixtureRunner(async (role, _state, count) => {
    if (role === "critic" && count === 1) throw new Error("Malformed critique");
  });
  const engine = new WorkflowEngine(cwd, runner, ui);
  const state = await engine.start("Fix", config());
  await engine.run(state);
  assert.equal(state.phase, "BLOCKED");
  assert.equal(state.agentFailures, 1);
  await engine.retryAgent(state, "critic");
  assert.equal(state.phase, "CRITIQUE");
  await engine.run(state);
  assert.equal(state.phase, "DONE", state.blocker);
  assert.equal(runner.counts.critic, 2);
  assert.equal(runner.counts.solver1, 1);
  assert.equal(
    state.history.findLast(
      (event) =>
        event.event === "agent_attempt_started" &&
        event.meta?.agent === "critic",
    )?.meta?.trigger,
    "manual_retry",
  );
});

test("one manually aborted Solver allows two siblings to continue", async () => {
  const cwd = await repository();
  const base = new FixtureRunner();
  const runner: AgentRunner = {
    run: async (role, state, signal) =>
      role === "solver1" ? await waitForAbort(signal) : base.run(role, state),
  };
  const engine = new WorkflowEngine(cwd, runner, ui);
  const state = await engine.start("Fix", config());
  const running = engine.run(state);
  await until(() => !!engine.activeAttempt("solver1"));
  await engine.abortAgent(state, "solver1");
  await running;
  assert.equal(state.phase, "DONE", state.blocker);
  assert.equal(state.agentFailures, 0);
  assert.ok(state.results.solver2);
  assert.ok(state.results.solver3);
  assert.equal(state.results.solver1, undefined);
  assert.equal(base.counts.solver2, 1);
  assert.equal(base.counts.solver3, 1);
});

test("completed Solver can retry at the phase boundary before Critic runs", async () => {
  const cwd = await repository();
  const runner = new FixtureRunner();
  let requested = false;
  let request: Promise<unknown> | undefined;
  let engine!: WorkflowEngine;
  engine = new WorkflowEngine(cwd, runner, {
    ...ui,
    progress: (state) => {
      if (!requested && state.phase === "CRITIQUE" && !state.results.critic) {
        requested = true;
        request = engine.retryAgent(state, "solver1", true);
      }
    },
  });
  const state = await engine.start("Fix", config());
  await engine.run(state);
  await request;
  assert.equal(state.phase, "DONE", state.blocker);
  assert.equal(runner.counts.solver1, 2);
  assert.equal(runner.counts.solver2, 1);
  assert.equal(runner.counts.solver3, 1);
  assert.equal(runner.counts.critic, 1);
});

test("retrying a Solver stops an active Critic and recomputes downstream reasoning", async () => {
  const cwd = await repository();
  const base = new FixtureRunner();
  let firstCritic = true;
  const runner: AgentRunner = {
    run: async (role, state, signal) => {
      if (role === "critic" && firstCritic) {
        firstCritic = false;
        return await waitForAbort(signal);
      }
      return base.run(role, state);
    },
  };
  const engine = new WorkflowEngine(cwd, runner, ui);
  const state = await engine.start("Fix", config());
  const running = engine.run(state);
  await until(() => !!engine.activeAttempt("critic"));
  await engine.retryAgent(state, "solver1", true);
  await running;
  assert.equal(state.phase, "DONE", state.blocker);
  assert.equal(state.agentFailures, 0);
  assert.equal(base.counts.solver1, 2);
  assert.equal(base.counts.solver2, 1);
  assert.equal(base.counts.solver3, 1);
  assert.equal(base.counts.critic, 1);
  assert.ok(
    state.history.some(
      (event) =>
        event.event === "agent_superseded_by_upstream_retry" &&
        event.meta?.agent === "critic",
    ),
  );
});

test("retry after manual abort resumes the blocked Researcher with attempt two", async () => {
  const cwd = await repository();
  const base = new FixtureRunner();
  let first = true;
  const runner: AgentRunner = {
    run: async (role, state, signal) => {
      if (role === "researcher" && first) {
        first = false;
        return await waitForAbort(signal);
      }
      return base.run(role, state);
    },
  };
  const engine = new WorkflowEngine(cwd, runner, ui);
  const state = await engine.start("Fix", config());
  const running = engine.run(state);
  await until(() => !!engine.activeAttempt("researcher"));
  await engine.abortAgent(state, "researcher");
  await running;
  assert.equal(state.phase, "BLOCKED");
  assert.equal(state.agentFailures, 0);
  await engine.retryAgent(state, "researcher");
  await engine.run(state);
  assert.equal(state.phase, "DONE", state.blocker);
  assert.deepEqual(
    state.history
      .filter(
        (event) =>
          event.event === "agent_attempt_started" &&
          event.meta?.agent === "researcher",
      )
      .map((event) => event.meta?.attempt),
    [1, 2],
  );
});

test("retrying a completed Solver retains its result until success and recomputes dependents", async () => {
  const cwd = await repository();
  const runner = new FixtureRunner();
  const engine = new WorkflowEngine(cwd, runner, ui);
  const cfg = config();
  cfg.agents.solver1.name = "Architecture Expert";
  const state = await engine.start("Fix", cfg);
  state.phase = "REVIEW";
  state.requirements = ["Fix addition"];
  state.commandApprovalComplete = true;
  state.results = {
    researcher: research,
    solver1: output("solver1"),
    solver2: output("solver2"),
    solver3: output("solver3"),
    critic: output("critic"),
    reviewer: contract,
  };
  const original = state.results.solver1;
  assert.match(
    engine.retryConfirmation(state, "solver1") ?? "",
    /Architecture Expert \(solver1\)/,
  );
  await assert.rejects(engine.retryAgent(state, "solver1"), /confirmation/);
  await engine.retryAgent(state, "solver1", true);
  assert.equal(state.results.solver1, original);
  assert.equal(state.results["Architecture Expert"], undefined);
  assert.ok(state.results.critic);
  await engine.run(state);
  assert.equal(state.phase, "DONE", state.blocker);
  const persisted = await engine.store.load(state.id);
  assert.ok(persisted.results.solver1);
  assert.equal(persisted.results["Architecture Expert"], undefined);
  assert.equal(runner.counts.solver1, 1);
  assert.equal(runner.counts.solver2, undefined);
  assert.equal(runner.counts.solver3, undefined);
  assert.equal(runner.counts.critic, 1);
  assert.equal(runner.counts.reviewer, 1);
  assert.ok(state.results.previous_critic);
  assert.ok(state.results.previous_reviewer);
});

test("retrying Researcher invalidates all Solver reasoning", async () => {
  const cwd = await repository();
  const runner = new FixtureRunner();
  const engine = new WorkflowEngine(cwd, runner, ui);
  const state = await engine.start("Fix", config());
  state.phase = "REVIEW";
  state.requirements = ["Fix addition"];
  state.commandApprovalComplete = true;
  state.results = {
    researcher: research,
    solver1: output("solver1"),
    solver2: output("solver2"),
    solver3: output("solver3"),
    critic: output("critic"),
    reviewer: contract,
  };
  await engine.retryAgent(state, "researcher", true);
  await engine.run(state);
  assert.equal(state.phase, "DONE", state.blocker);
  assert.equal(runner.counts.researcher, 1);
  assert.equal(runner.counts.solver1, 1);
  assert.equal(runner.counts.solver2, 1);
  assert.equal(runner.counts.solver3, 1);
  assert.ok(state.results.previous_solver1);
});

test("Critic and Reviewer retries invalidate only their downstream results", async () => {
  for (const role of ["critic", "reviewer"] as const) {
    const cwd = await repository();
    const runner = new FixtureRunner();
    const engine = new WorkflowEngine(cwd, runner, ui);
    const state = await engine.start("Fix", config());
    state.phase = role === "critic" ? "REVIEW" : "IMPLEMENT";
    state.requirements = ["Fix addition"];
    state.commandApprovalComplete = true;
    state.results = {
      researcher: research,
      solver1: output("solver1"),
      solver2: output("solver2"),
      solver3: output("solver3"),
      critic: output("critic"),
      reviewer: contract,
    };
    await engine.retryAgent(state, role, true);
    await engine.run(state);
    assert.equal(state.phase, "DONE", state.blocker);
    assert.equal(runner.counts.researcher, undefined);
    assert.equal(runner.counts.solver1, undefined);
    assert.equal(runner.counts.critic, role === "critic" ? 1 : undefined);
    assert.equal(runner.counts.reviewer, 1);
    if (role === "critic") assert.ok(state.results.previous_reviewer);
    else assert.equal(state.results.previous_critic, undefined);
  }
});

test("a failed replacement preserves the completed Solver result", async () => {
  const cwd = await repository();
  const runner = new FixtureRunner(async (role) => {
    if (role === "solver1") throw new Error("replacement failed");
  });
  const engine = new WorkflowEngine(cwd, runner, ui);
  const state = await engine.start("Fix", config());
  state.phase = "CRITIQUE";
  state.requirements = ["Fix addition"];
  state.commandApprovalComplete = true;
  state.results = {
    researcher: research,
    solver1: output("solver1"),
    solver2: output("solver2"),
    solver3: output("solver3"),
  };
  const old = state.results.solver1;
  await engine.retryAgent(state, "solver1", true);
  await engine.run(state);
  assert.equal(state.phase, "BLOCKED");
  assert.equal(state.results.solver1, old);
  assert.equal(state.results.critic, undefined);
});

test("completed Implementor retry needs confirmation and preserves the working tree", async () => {
  const cwd = await repository();
  const engine = new WorkflowEngine(cwd, new FixtureRunner(), ui);
  const state = await engine.start("Fix", config());
  state.phase = "CODE_REVIEW";
  state.results.researcher = research;
  state.results.reviewer = contract;
  state.results.implementor = output("implementor");
  const path = join(cwd, "math.js");
  await writeFile(path, "export const add = (a, b) => a + b; // user edit\n");
  await assert.rejects(engine.retryAgent(state, "implementor"), /confirmation/);
  await engine.retryAgent(state, "implementor", true);
  assert.equal(state.phase, "IMPLEMENT");
  assert.equal(
    await readFile(path, "utf8"),
    "export const add = (a, b) => a + b; // user edit\n",
  );
});
