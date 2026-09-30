import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import YAML from "yaml";
import { configSchema } from "../src/config/schema.ts";
import {
  getActiveSolverIds,
  getRequiredSuccessfulSolverCount,
} from "../src/config/solvers.ts";
import { loadConfig } from "../src/config/loader.ts";
import { analyzeConfigDrift } from "../src/config/drift.ts";
import { contextFor } from "../src/agents/context.ts";
import { PiRunner } from "../src/agents/runner.ts";
import { AgentLogStore } from "../src/workflow/agent-logs.ts";
import { solverIds } from "../src/agents/schemas.ts";
import { WorkflowEngine } from "../src/workflow/engine.ts";
import { getWorkflowRecoveryPlan } from "../src/workflow/recovery.ts";
import { validateState } from "../src/workflow/state.ts";
import { fix } from "../src/workflow/router.ts";
import {
  deriveAgentProgressState,
  renderProgress,
} from "../src/ui/progress.ts";
import {
  FixtureRunner,
  config,
  repository,
  output,
  research,
  contract,
} from "./helpers.ts";

const ui = { progress: () => {}, ask: async () => undefined };
const yamlPath = (cwd: string) => join(cwd, ".pi/team/team.yaml");
async function editYaml(cwd: string, edit: (value: any) => void) {
  const path = yamlPath(cwd);
  const value = YAML.parse(await readFile(path, "utf8"));
  edit(value);
  await writeFile(path, YAML.stringify(value));
}
function setSolvers(value: any, count: number) {
  value.workflow.solverCount = count;
  for (const id of solverIds) {
    if (Number(id.slice(6)) <= count)
      value.agents[id] ??= {
        ...value.agents.solver3,
        name: `Solver ${id.slice(6)}`,
      };
    else delete value.agents[id];
  }
}
async function fixture(count: number) {
  const cwd = await repository();
  await editYaml(cwd, (value) => setSolvers(value, count));
  const raw = structuredClone(config());
  setSolvers(raw, count);
  const cfg = configSchema.parse(raw);
  cfg.qualityGates.commit.enabled = false;
  return { cwd, cfg };
}

test("solverCount validates 1..10, contiguous definitions, role, and inactive extras", () => {
  const base = config();
  for (const count of [1, 10]) {
    const raw = structuredClone(base);
    setSolvers(raw, count);
    const parsed = configSchema.parse(raw);
    assert.equal(getActiveSolverIds(parsed).length, count);
    assert.equal(getActiveSolverIds(parsed).at(-1), `solver${count}`);
  }
  for (const count of [0, -1, 11, 1.5]) {
    const raw = structuredClone(base);
    raw.workflow.solverCount = count;
    assert.equal(configSchema.safeParse(raw).success, false);
  }
  const missing = structuredClone(base);
  missing.workflow.solverCount = 4;
  assert.match(
    configSchema.safeParse(missing).error?.message ?? "",
    /Missing agent configuration: solver4/,
  );
  const wrong = structuredClone(base);
  setSolvers(wrong, 4);
  wrong.agents.solver4.role = "tester";
  assert.ok(
    configSchema
      .safeParse(wrong)
      .error?.issues.some((issue) =>
        issue.message.includes('agents.solver4 must have role "solver"'),
      ),
  );
  const extra = structuredClone(base);
  extra.agents.solver4 = { ...extra.agents.solver3 };
  assert.equal(configSchema.parse(extra).workflow.solverCount, 3);
});

test("quorum helper follows the complete 1..10 rule", () => {
  assert.deepEqual(
    Array.from({ length: 10 }, (_, i) =>
      getRequiredSuccessfulSolverCount(i + 1),
    ),
    [1, 2, 2, 2, 3, 3, 4, 4, 5, 5],
  );
});

for (const count of [1, 5, 10])
  test(`${count} active Solvers execute and persist; Critic sees exactly their proposals`, async () => {
    const { cwd, cfg } = await fixture(count);
    const seen: string[] = [];
    const runner = new FixtureRunner(async (role, state) => {
      if (role.startsWith("solver")) seen.push(role);
      if (role === "critic") {
        const context = await contextFor(role, state);
        assert.deepEqual(
          Object.keys(context).filter((key) => solverIds.includes(key as any)),
          getActiveSolverIds(cfg),
        );
      }
    });
    const engine = new WorkflowEngine(cwd, runner, ui);
    const state = await engine.start("Fix", cfg);
    await engine.run(state);
    assert.equal(state.phase, "DONE", state.blocker);
    assert.deepEqual(new Set(seen), new Set(getActiveSolverIds(cfg)));
    assert.equal(
      state.history.find(
        (event) => event.event === "phase_started" && event.phase === "SOLVE",
      )?.detail,
      getActiveSolverIds(cfg).join(", "),
    );
    assert.equal(
      getActiveSolverIds(
        validateState(
          JSON.parse(JSON.stringify(await engine.store.load(state.id))),
        ).config,
      ).length,
      count,
    );
    const text = renderProgress(state).join("\n");
    for (const id of getActiveSolverIds(cfg))
      assert.match(
        text,
        new RegExp(
          Number(id.slice(6)) <= 3
            ? "Solver (Architecture|Pragmatic|Alternative)"
            : `Solver ${id.slice(6)}\\b`,
        ),
      );
    assert.doesNotMatch(text, new RegExp(`Solver ${count + 1}\\b`));
  });

for (const bothSucceed of [false, true])
  test(`two Solvers ${bothSucceed ? "both succeed" : "one fails"} before Critic`, async () => {
    const { cwd, cfg } = await fixture(2);
    const runner = new FixtureRunner(async (role, _state, attempt) => {
      if (!bothSucceed && role === "solver2" && attempt === 1)
        throw new Error("fixture failure");
    });
    const engine = new WorkflowEngine(cwd, runner, ui);
    const state = await engine.start("Fix", cfg);
    await engine.run(state);
    assert.equal(state.phase, bothSucceed ? "DONE" : "BLOCKED");
    assert.equal(runner.counts.critic, bothSucceed ? 1 : undefined);
    if (!bothSucceed)
      assert.match(
        state.blocker ?? "",
        /Solver quorum not reached: 1\/2 successful \(2 configured\)/,
      );
    if (!bothSucceed) {
      const plan = await getWorkflowRecoveryPlan(state, cwd);
      assert.equal(plan.kind, "retry-agent");
      if (plan.kind === "retry-agent") assert.equal(plan.agentId, "solver2");
      await engine.retryAgent(state, "solver2");
      await engine.run(state);
      assert.equal(state.phase, "DONE", state.blocker);
      assert.equal(runner.counts.solver1, 1);
      assert.equal(runner.counts.solver2, 2);
    }
  });

for (const failures of [2, 3])
  test(`five Solvers with ${failures} failures ${failures === 2 ? "continue" : "block"}`, async () => {
    const { cwd, cfg } = await fixture(5);
    const runner = new FixtureRunner(async (role, state) => {
      if (["solver3", "solver4", "solver5"].slice(0, failures).includes(role))
        throw new Error("fixture failure");
      if (role === "critic") {
        const context = await contextFor(role, state);
        assert.deepEqual(
          Object.keys(context).filter((key) => solverIds.includes(key as any)),
          ["solver1", "solver2", ...(failures === 2 ? ["solver5"] : [])],
        );
      }
    });
    const engine = new WorkflowEngine(cwd, runner, ui);
    const state = await engine.start("Fix", cfg);
    await engine.run(state);
    assert.equal(
      state.phase,
      failures === 2 ? "DONE" : "BLOCKED",
      state.blocker,
    );
    assert.equal(runner.counts.critic, failures === 2 ? 1 : undefined);
  });

test("inactive extra Solver neither executes nor renders and its commands reject", async () => {
  const { cwd, cfg } = await fixture(3);
  cfg.agents.solver4 = { ...cfg.agents.solver3, name: "Inactive Expert" };
  const runner = new FixtureRunner();
  const engine = new WorkflowEngine(cwd, runner, ui);
  const state = await engine.start("Fix", cfg);
  await engine.run(state);
  assert.equal(runner.counts.solver4, undefined);
  assert.doesNotMatch(renderProgress(state).join("\n"), /Inactive Expert/);
  await assert.rejects(
    engine.retryAgent(state, "solver4"),
    /inactive because workflow.solverCount=3/,
  );
  await assert.rejects(
    engine.abortAgent(state, "solver4"),
    /inactive because workflow.solverCount=3/,
  );
  await assert.rejects(
    engine.steer(state, "solver4", "adjust"),
    /inactive because workflow.solverCount=3/,
  );
});

test("solver5 abort keeps reachable quorum and inactive Solver logs stay hidden", async () => {
  const { cwd, cfg } = await fixture(5);
  const base = new FixtureRunner();
  const runner = {
    run: async (role: any, state: any, signal?: AbortSignal) =>
      role === "solver5"
        ? await new Promise<never>((_resolve, reject) => {
            if (signal?.aborted) reject(new Error("aborted"));
            else
              signal?.addEventListener(
                "abort",
                () => reject(new Error("aborted")),
                { once: true },
              );
          })
        : base.run(role, state),
  };
  const engine = new WorkflowEngine(cwd, runner, ui);
  const state = await engine.start("Fix", cfg);
  const running = engine.run(state);
  for (let i = 0; !engine.activeAttempt("solver5") && i < 100; i++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(engine.activeAttempt("solver5"));
  await engine.abortAgent(state, "solver5");
  await running;
  assert.equal(state.phase, "DONE", state.blocker);
  assert.equal(state.results.solver5, undefined);
  const overview = await new AgentLogStore(cwd).overview(
    state.id,
    state.config,
  );
  assert.match(overview, /solver5/);
  assert.doesNotMatch(overview, /solver6/);
});

test("solver5 accepts steering in its running Pi session", async () => {
  const { cwd, cfg } = await fixture(5);
  const runner = new PiRunner();
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const steered: string[] = [];
  runner.createSession = async () =>
    ({
      messages: [{ role: "assistant", stopReason: "stop" }],
      prompt: async () => {
        await pending;
      },
      steer: async (message: string) => {
        steered.push(message);
      },
      getSteeringMessages: () => [],
      abort: async () => {},
      getLastAssistantText: () => JSON.stringify(output("solver5")),
      extensionRunner: { emit: async () => {} },
      dispose: () => {},
    }) as any;
  const engine = new WorkflowEngine(cwd, runner, ui);
  const state = await engine.start("Fix", cfg);
  state.phase = "SOLVE";
  const invocation = engine.invoke("solver5", state);
  for (let i = 0; !engine.sessions.get(state.id, "solver5") && i < 100; i++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  await engine.steer(state, "solver5", "Consider performance");
  assert.deepEqual(steered, ["Consider performance"]);
  finish();
  await invocation;
});

test("Critic receives four successful proposals with their original Solver IDs", async () => {
  const { cwd, cfg } = await fixture(5);
  const runner = new FixtureRunner(async (role, state) => {
    if (role === "solver3") throw new Error("fixture failure");
    if (role === "critic") {
      const context = await contextFor(role, state);
      assert.deepEqual(
        Object.keys(context).filter((key) => solverIds.includes(key as any)),
        ["solver1", "solver2", "solver4", "solver5"],
      );
    }
  });
  const engine = new WorkflowEngine(cwd, runner, ui);
  const state = await engine.start("Fix", cfg);
  await engine.run(state);
  assert.equal(state.phase, "DONE", state.blocker);
});

test("retrying solver4 preserves sibling results and replaces only its proposal", async () => {
  const { cwd, cfg } = await fixture(5);
  const runner = new FixtureRunner(async (role, state) => {
    if (role === "critic") {
      const context = await contextFor(role, state);
      assert.deepEqual(
        Object.keys(context).filter((key) => solverIds.includes(key as any)),
        getActiveSolverIds(cfg),
      );
    }
  });
  const engine = new WorkflowEngine(cwd, runner, ui);
  const state = await engine.start("Fix", cfg);
  state.phase = "REVIEW";
  state.requirements = ["Fix addition"];
  state.commandApprovalComplete = true;
  state.results = {
    researcher: research,
    ...Object.fromEntries(
      getActiveSolverIds(cfg).map((id) => [id, output(id)]),
    ),
    critic: output("critic"),
    reviewer: contract,
  };
  const siblings = getActiveSolverIds(cfg)
    .filter((id) => id !== "solver4")
    .map((id) => state.results[id]);
  await engine.retryAgent(state, "solver4", true);
  assert.ok(state.results.critic);
  await engine.run(state);
  assert.equal(state.phase, "DONE", state.blocker);
  assert.deepEqual(
    getActiveSolverIds(cfg)
      .filter((id) => id !== "solver4")
      .map((id) => state.results[id]),
    siblings,
  );
  assert.equal(runner.counts.solver4, 1);
  for (const id of getActiveSolverIds(cfg).filter((id) => id !== "solver4"))
    assert.equal(runner.counts[id], undefined);
  for (const id of getActiveSolverIds(cfg).filter((id) => id !== "solver4"))
    assert.equal(deriveAgentProgressState(state, id).status, "completed");
  assert.ok(state.results.previous_critic);
  assert.ok(state.results.previous_reviewer);
});

test("old persisted configs default to three Solvers", () => {
  const cfg = config();
  delete (cfg.workflow as any).solverCount;
  const state: any = {
    version: 3,
    id: "00000000-0000-4000-8000-000000000001",
    cwd: "/tmp/fixture",
    task: "Fix",
    requirements: [],
    phase: "SOLVE",
    config: cfg,
    fullCycle: 1,
    localFixCycle: 0,
    pentestCycle: 0,
    agentFailures: 0,
    questionCount: 0,
    results: {},
    baseline: {
      head: null,
      dirtyPaths: [],
      status: "",
      diff: "",
      cachedDiff: "",
    },
    history: [],
    answers: [],
  };
  assert.equal(validateState(state).config.workflow.solverCount, 3);
});

test("inactive Solver prompt drift does not block", async () => {
  const { cwd, cfg } = await fixture(3);
  await writeFile(
    join(cwd, ".pi/team/agents/solver7-custom.md"),
    "First prompt\n",
  );
  await editYaml(cwd, (value) => {
    value.agents.solver7 = {
      ...value.agents.solver3,
      prompt: "agents/solver7-custom.md",
    };
  });
  const engine = new WorkflowEngine(cwd, new FixtureRunner(), ui);
  const state = await engine.start("Fix", cfg);
  await writeFile(
    join(cwd, ".pi/team/agents/solver7-custom.md"),
    "Changed prompt\n",
  );
  const drift = analyzeConfigDrift(state, await loadConfig(cwd));
  assert.equal(drift.blocking, false);
  assert.deepEqual(drift.semanticChanges, []);
});

test("FIX_DESIGN invalidates all five active Solver results", () => {
  const cfg = config();
  setSolvers(cfg, 5);
  const state: any = {
    config: cfg,
    phase: "CODE_REVIEW",
    fullCycle: 1,
    localFixCycle: 0,
    results: {},
    history: [],
  };
  for (const id of getActiveSolverIds(cfg)) state.results[id] = output(id);
  state.results.codeReviewer = { status: "FIX_DESIGN", findings: [] };
  fix(state, "FIX_DESIGN");
  for (const id of getActiveSolverIds(cfg)) {
    assert.equal(state.results[id], undefined);
    assert.ok(state.results[`previous_${id}`]);
  }
});

test("solverCount drift is future-phase before SOLVE and blocking after consumption", async () => {
  const { cwd, cfg } = await fixture(3);
  const engine = new WorkflowEngine(cwd, new FixtureRunner(), ui);
  const state = await engine.start("Fix", cfg);
  await editYaml(cwd, (value) => setSolvers(value, 5));
  const current = await loadConfig(cwd);
  const before = analyzeConfigDrift(state, current);
  assert.equal(before.blocking, false);
  assert.ok(before.futureAgentChanges.includes("workflow.solverCount"));
  await engine.run(state);
  assert.equal(state.phase, "DONE", state.blocker);
  assert.equal(state.config.workflow.solverCount, 5);
  await editYaml(cwd, (value) => setSolvers(value, 6));
  const after = analyzeConfigDrift(state, await loadConfig(cwd));
  assert.equal(after.blocking, true);
  assert.ok(after.semanticChanges.includes("workflow.solverCount"));
});
