import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { WorkflowEngine } from "../src/workflow/engine.ts";
import {
  pendingFixRequirements,
  getWorkflowRecoveryPlan,
} from "../src/workflow/recovery.ts";
import {
  deriveAgentProgressState,
  renderProgress,
} from "../src/ui/progress.ts";
import {
  config,
  repository,
  FixtureRunner,
  finding,
  assertAgentAttemptLifecycle,
} from "./helpers.ts";
import { detectedCommandId } from "../src/agents/discovery.ts";
import { contextFor } from "../src/agents/context.ts";
import type { WorkflowState } from "../src/workflow/state.ts";

const ui = { progress: () => {}, ask: async () => undefined };

async function waitingLocalFix() {
  const cwd = await repository();
  const cfg = config();
  cfg.qualityGates.commit.enabled = false;
  const runner = new FixtureRunner(async (role, _state, count) => {
    if (role === "codeReviewer" && count === 1)
      return { status: "FIX_LOCAL", findings: [finding] };
    if (role === "implementor" && count === 2)
      return {
        status: "IMPLEMENTATION_BLOCKED",
        reason: "The previously unavailable file is needed",
        evidence: [],
        suggestedRoute: "FIX_REQUIREMENTS",
      };
    return undefined;
  });
  const engine = new WorkflowEngine(cwd, runner, ui);
  const state = await engine.start("Fix addition", cfg);
  await engine.run(state);
  assert.equal(state.phase, "WAITING_USER");
  assert.equal(state.results.implementor?.status, "IMPLEMENTATION_BLOCKED");
  assert.equal(state.results.previous_codeReviewer?.status, "FIX_LOCAL");
  return { cwd, runner, state, engine };
}

test("FIX_REQUIREMENTS records source provenance and status offers both decisions", async () => {
  const { state } = await waitingLocalFix();
  assert.deepEqual(
    {
      route: state.pendingQuestion?.route,
      sourceAgent: state.pendingQuestion?.sourceAgent,
      sourcePhase: state.pendingQuestion?.sourcePhase,
    },
    {
      route: "FIX_REQUIREMENTS",
      sourceAgent: "implementor",
      sourcePhase: "IMPLEMENT",
    },
  );
  assert.deepEqual(pendingFixRequirements(state), {
    sourceAgent: "implementor",
    sourcePhase: "IMPLEMENT",
    attempt: 2,
  });
  const status = renderProgress(state, undefined, true).join("\n");
  assert.match(status, new RegExp(`/team resume ${state.id}`));
  assert.match(status, /\/team-retry implementor override/);
  assert.match(status, /requested by Implementor during IMPLEMENT/);
  assert.doesNotMatch(status, /\/team-retry codeReviewer/);
  for (const role of [
    "orchestrator",
    "researcher",
    "solver1",
    "critic",
    "reviewer",
  ] as const)
    assert.equal(
      deriveAgentProgressState(state, role).status,
      "completed",
      role,
    );
  assert.equal(
    (await getWorkflowRecoveryPlan(state, state.cwd)).kind,
    "waiting-user",
  );
});

test("override after restart keeps requirements, upstream results, FIX_LOCAL context and working tree", async () => {
  const { cwd, runner, state, engine } = await waitingLocalFix();
  const oldRequirements = structuredClone(state.requirements);
  const upstream = Object.fromEntries(
    [
      "orchestrator",
      "researcher",
      "solver1",
      "solver2",
      "solver3",
      "critic",
      "reviewer",
      "previous_codeReviewer",
    ].map((key) => [key, structuredClone(state.results[key])]),
  );
  const oldLocalCycle = state.localFixCycle;
  const oldFailures = state.agentFailures;
  const oldQuestions = state.questionCount;
  const oldFile = await readFile(join(cwd, "math.js"), "utf8");
  const restarted = new WorkflowEngine(cwd, runner, ui);
  const loaded = await restarted.store.load(state.id);
  await assert.rejects(
    restarted.retryAgent(loaded, "implementor"),
    /\/team-retry implementor override/,
  );
  await assert.rejects(
    restarted.continueBlocked(loaded),
    /waiting for user input/i,
  );
  assert.equal(
    await restarted.retryAgent(loaded, "implementor", false, "override"),
    "prepared",
  );
  assert.equal(await readFile(join(cwd, "math.js"), "utf8"), oldFile);
  assert.equal(loaded.phase, "IMPLEMENT");
  assert.equal(loaded.pendingQuestion, undefined);
  assert.equal(loaded.resumePhase, undefined);
  assert.equal(loaded.results.implementor, undefined);
  assertAgentAttemptLifecycle(loaded, "implementor", 2);
  assert.equal(loaded.results.codeReviewer, undefined);
  assert.deepEqual(loaded.requirements, oldRequirements);
  for (const [key, value] of Object.entries(upstream))
    assert.deepEqual(loaded.results[key], value, key);
  assert.deepEqual(
    (await contextFor("implementor", loaded)).previous_codeReviewer,
    upstream.previous_codeReviewer,
  );
  assert.equal(loaded.localFixCycle, oldLocalCycle);
  assert.equal(loaded.agentFailures, oldFailures);
  assert.equal(loaded.questionCount, oldQuestions); // Existing counter counts answers; override adds none.
  assert.equal(
    deriveAgentProgressState(loaded, "reviewer").status,
    "completed",
  );
  assert.equal(
    deriveAgentProgressState(loaded, "codeReviewer").status,
    "invalidated",
  );
  const applied = loaded.history.findLast(
    (event) => event.event === "fix_requirements_override_applied",
  );
  assert.deepEqual(
    {
      agent: applied?.meta?.agent,
      attempt: applied?.meta?.attempt,
      sourcePhase: applied?.meta?.sourcePhase,
    },
    { agent: "implementor", attempt: 2, sourcePhase: "IMPLEMENT" },
  );
  await restarted.run(loaded);
  assert.equal(loaded.phase, "DONE", loaded.blocker);
  assert.equal(runner.counts.implementor, 3);
  assert.equal(runner.calls.filter((role) => role === "implementor").length, 3);
  assert.equal(runner.counts.codeReviewer, 2);
  for (const role of [
    "orchestrator",
    "researcher",
    "solver1",
    "solver2",
    "solver3",
    "critic",
    "reviewer",
  ] as const)
    assert.equal(runner.counts[role], 1, role);
  const runs = assertAgentAttemptLifecycle(
    loaded,
    "implementor",
    runner.counts.implementor,
  );
  assert.equal(runs.length, 3);
  assert.equal(
    loaded.history.filter(
      (event) => event.event === "fix_requirements_override_applied",
    ).length,
    1,
  );
  assert.equal(
    loaded.history.filter(
      (event) => event.event === "fix_requirements_override_requested",
    ).length,
    1,
  );
  assert.equal(
    loaded.history.filter(
      (event) =>
        event.event === "agent_retry_requested_by_user" &&
        event.detail === "implementor requirements override retry",
    ).length,
    1,
  );
  assert.deepEqual(
    runs.map((event) => [event.meta?.attempt, event.meta?.trigger]),
    [
      [1, "initial"],
      [2, "fix_local"],
      [3, "manual_retry"],
    ],
  );
  assert.equal(runs[2].meta?.retryNumber, 1);
  assert.equal(loaded.localFixCycle, oldLocalCycle);
  assert.equal(loaded.agentFailures, oldFailures);
  assert.deepEqual(
    loaded.results.previous_codeReviewer,
    upstream.previous_codeReviewer,
  );
  assert.equal((await engine.store.load(state.id)).phase, "DONE");
});

test("legacy history infers only the latest unambiguous FIX_REQUIREMENTS origin", async () => {
  const { cwd, state, runner } = await waitingLocalFix();
  delete state.pendingQuestion?.route;
  delete state.pendingQuestion?.sourceAgent;
  delete state.pendingQuestion?.sourcePhase;
  await new WorkflowEngine(cwd, runner, ui).store.save(state);
  const loaded = await new WorkflowEngine(cwd, runner, ui).store.load(state.id);
  assert.equal(pendingFixRequirements(loaded)?.sourceAgent, "implementor");
  assert.match(
    renderProgress(loaded).join("\n"),
    /\/team-retry implementor override/,
  );
  const ambiguous = structuredClone(loaded);
  const phaseComplete = ambiguous.history.pop()!;
  ambiguous.history.push(
    { ...ambiguous.history.at(-1)!, event: "FIX_REQUIREMENTS" },
    phaseComplete,
  );
  assert.equal(pendingFixRequirements(ambiguous), undefined);
  assert.doesNotMatch(
    renderProgress(ambiguous).join("\n"),
    /\/team-retry implementor override/,
  );
});

test("concurrent override requests prepare one retry", async () => {
  const { cwd, state, runner } = await waitingLocalFix();
  const first = new WorkflowEngine(cwd, runner, ui);
  const second = new WorkflowEngine(cwd, runner, ui);
  const firstState = await first.store.load(state.id);
  const secondState = await second.store.load(state.id);
  const requests = await Promise.allSettled([
    first.retryAgent(firstState, "implementor", false, "override"),
    second.retryAgent(secondState, "implementor", false, "override"),
  ]);
  assert.equal(
    requests.filter((request) => request.status === "fulfilled").length,
    1,
  );
  assert.equal(
    requests.filter((request) => request.status === "rejected").length,
    1,
  );
  const prepared = await first.store.load(state.id);
  assert.equal(
    prepared.history.filter(
      (event) => event.event === "fix_requirements_override_applied",
    ).length,
    1,
  );
  assertAgentAttemptLifecycle(prepared, "implementor", 2);
  await new WorkflowEngine(cwd, runner, ui).run(prepared);
  assert.equal(runner.counts.implementor, 3);
  assertAgentAttemptLifecycle(prepared, "implementor", 3);
});

test("wrong agent, answered question, other approvals and active agent reject override", async () => {
  const { cwd, state, runner } = await waitingLocalFix();
  const engine = new WorkflowEngine(cwd, runner, ui);
  await assert.rejects(
    engine.retryAgent(state, "codeReviewer", false, "override"),
    /raised by Implementor/,
  );
  await assert.rejects(
    engine.retryAgent(state, "implementor", false, "keep"),
    /No interrupted mutating attempt/,
  );
  const base = structuredClone(state);
  const cases: Array<(s: WorkflowState) => void> = [
    (s) => {
      s.pendingApproval = {
        kind: "manualRetry",
        title: "Review",
        prompt: "Review",
        options: [],
      };
    },
    (s) => {
      s.pendingRuntimeCommands.push({
        workflowId: s.id,
        agentId: "implementor",
        run: 2,
        requestId: "11111111-1111-4111-8111-111111111111",
        command: {
          ...s.config.commands[0],
          id: detectedCommandId(s.config.commands[0]),
        },
        purpose: "test",
      });
    },
    (s) => {
      s.pendingRuntimeFiles.push({
        workflowId: s.id,
        agentId: "implementor",
        run: 2,
        requestId: "11111111-1111-4111-8111-111111111111",
        operation: "read",
        path: ".env",
      });
    },
    (s) => {
      s.answers.push({ question: s.pendingQuestion!.question, answer: "Yes" });
      delete s.pendingQuestion;
    },
    (s) => {
      s.phase = "IMPLEMENT";
    },
  ];
  for (const change of cases) {
    const copy = structuredClone(base);
    change(copy);
    await engine.store.save(copy);
    await assert.rejects(
      engine.retryAgent(copy, "implementor", false, "override"),
      /No unanswered FIX_REQUIREMENTS/,
    );
  }
  await engine.store.save(base);
  const active = new WorkflowEngine(cwd, runner, ui);
  active.sessions.register({
    workflowId: base.id,
    agentId: "implementor",
    attempt: 2,
    session: {} as any,
    startedAt: Date.now(),
    state: "running",
  });
  await assert.rejects(
    active.retryAgent(base, "implementor", false, "override"),
    /already active/,
  );
});

test("research clarification and ordinary question never accept override", async () => {
  const { cwd, state, runner } = await waitingLocalFix();
  const engine = new WorkflowEngine(cwd, runner, ui);
  const research = structuredClone(state);
  delete research.pendingQuestion;
  research.pendingResearchQuestions = ["What scope?"];
  research.resumePhase = "RESEARCH";
  await engine.store.save(research);
  await assert.rejects(
    engine.retryAgent(research, "researcher", false, "override"),
    /No unanswered FIX_REQUIREMENTS/,
  );
  const ordinary = structuredClone(state);
  ordinary.pendingQuestion = {
    type: "QUESTION_REQUEST",
    blocking: true,
    question: "What scope?",
    reason: "Need scope",
  };
  ordinary.history.push({
    ...ordinary.history.at(-1)!,
    event: "question_requested",
    detail: "What scope?",
  });
  await engine.store.save(ordinary);
  await assert.rejects(
    engine.retryAgent(ordinary, "implementor", false, "override"),
    /No unanswered FIX_REQUIREMENTS/,
  );
});

test("Code Reviewer origin uses its configured name and original phase", async () => {
  const cwd = await repository();
  const cfg = config();
  cfg.qualityGates.commit.enabled = false;
  cfg.agents.codeReviewer.name = "Audit Lead";
  const runner = new FixtureRunner(async (role, _state, count) =>
    role === "codeReviewer" && count === 1
      ? { status: "FIX_REQUIREMENTS", findings: [], question: "Which range?" }
      : undefined,
  );
  const engine = new WorkflowEngine(cwd, runner, ui);
  const state = await engine.start("Fix addition", cfg);
  await engine.run(state);
  assert.equal(state.pendingQuestion?.sourceAgent, "codeReviewer");
  assert.equal(state.pendingQuestion?.sourcePhase, "CODE_REVIEW");
  assert.match(
    renderProgress(state).join("\n"),
    /requested by Audit Lead during CODE_REVIEW/,
  );
  assert.match(
    renderProgress(state).join("\n"),
    /\/team-retry codeReviewer override/,
  );
  await engine.retryAgent(state, "codeReviewer", false, "override");
  assert.equal(state.phase, "CODE_REVIEW");
  await engine.run(state);
  assert.equal(state.phase, "DONE", state.blocker);
  assert.equal(runner.counts.implementor, 1);
  assert.equal(runner.counts.codeReviewer, 2);
  assertAgentAttemptLifecycle(
    state,
    "codeReviewer",
    runner.counts.codeReviewer,
  );
});

test("answering FIX_REQUIREMENTS still restarts the design cycle", async () => {
  const { cwd, state, runner } = await waitingLocalFix();
  const engine = new WorkflowEngine(cwd, runner, {
    progress: () => {},
    ask: async () => "Keep the existing scope",
  });
  const loaded = await engine.store.load(state.id);
  await engine.run(loaded);
  assert.equal(loaded.phase, "DONE", loaded.blocker);
  assert.equal(loaded.answers.at(-1)?.answer, "Keep the existing scope");
  assert.equal(loaded.questionCount, state.questionCount + 1);
  assert.equal(runner.counts.orchestrator, 2);
  assert.equal(runner.counts.researcher, 2);
  assert.equal(runner.counts.reviewer, 2);
  assert.equal(
    loaded.history.some(
      (event) => event.event === "fix_requirements_override_applied",
    ),
    false,
  );
});
