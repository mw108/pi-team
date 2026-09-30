import test from "node:test";
import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { WorkflowEngine } from "../src/workflow/engine.ts";
import { config, FixtureRunner, repository, research } from "./helpers.ts";
import { renderProgress } from "../src/ui/progress.ts";
import { contextFor } from "../src/agents/context.ts";
import {
  researchQuestionAnswers,
  researchQuestionParams,
} from "../src/integrations/pi-ask.ts";

const questions = ["Question A?", "Question B?"];
function answers(items: string[]) {
  return items.map((question, index) => ({
    question,
    answer: `Answer ${index + 1}`,
  }));
}

test("Pi Ask presents every research question and maps each answer", () => {
  const params = researchQuestionParams(questions);
  assert.equal(params.questions.length, 2);
  assert.match(params.questions[0].prompt, /Question A/);
  assert.match(params.questions[1].prompt, /Question B/);
  assert.deepEqual(
    researchQuestionAnswers(questions, {
      mode: "submit",
      answers: {
        research_1: { customText: "First" },
        research_2: { optionNotes: { answer: "Second" } },
      },
    }),
    [
      { question: "Question A?", answer: "First" },
      { question: "Question B?", answer: "Second" },
    ],
  );
  assert.equal(
    researchQuestionAnswers(questions, {
      mode: "submit",
      answers: { research_1: { customText: "First" } },
    }),
    undefined,
  );
});

test("two research questions wait, survive resume, and block all Solver starts", async () => {
  const cwd = await repository();
  const runner = new FixtureRunner(async (role, _state, count) =>
    role === "researcher" && count === 1
      ? { ...research, unresolvedQuestions: [...questions, questions[0]] }
      : undefined,
  );
  const engine = new WorkflowEngine(cwd, runner, {
    progress() {},
    ask: async () => undefined,
    askResearchQuestions: async () => undefined,
  });
  const state = await engine.start("Fix addition", config());
  await engine.run(state);
  assert.equal(state.phase, "WAITING_USER");
  assert.equal(state.resumePhase, "RESEARCH");
  assert.deepEqual(state.pendingResearchQuestions, questions);
  assert.equal(state.agentFailures, 0);
  assert.equal(state.questionCount, 0);
  assert.equal(state.researchClarificationCount, 1);
  assert.equal(
    runner.calls.filter((role) => role.startsWith("solver")).length,
    0,
  );
  assert.equal(
    state.history.some(
      (entry) =>
        entry.event === "agent_attempt_started" &&
        entry.meta?.agent?.startsWith("solver"),
    ),
    false,
  );
  for (const role of ["solver1", "solver2", "solver3"] as const)
    await assert.rejects(() => access(engine.logs.path(state.id, role, 1)));
  const display = renderProgress(state).join("\n");
  assert.match(display, /◉ Researcher.*waiting for user answers · 2 questions/);
  assert.match(display, /Pending research questions: 2/);
  assert.doesNotMatch(display, /✓ Researcher/);
  const saved = await engine.store.load(state.id);
  const prompts: string[][] = [];
  const resumed = new WorkflowEngine(cwd, runner, {
    progress() {},
    ask: async () => undefined,
    askResearchQuestions: async (items) => {
      prompts.push(items);
      return undefined;
    },
  });
  await resumed.run(saved);
  assert.equal(saved.phase, "WAITING_USER");
  assert.deepEqual(saved.pendingResearchQuestions, questions);
  assert.deepEqual(prompts, [questions]);
  assert.equal(runner.counts.researcher, 1);
  assert.equal(
    runner.calls.filter((role) => role.startsWith("solver")).length,
    0,
  );
});

test("answers rerun Researcher with mapped context and clarification trigger before Solvers", async () => {
  const cwd = await repository();
  const runner = new FixtureRunner(async (role, state, count) => {
    if (role === "researcher" && count === 1)
      return { ...research, unresolvedQuestions: questions };
    if (role === "researcher" && count === 2) {
      assert.deepEqual(
        state.answers.slice(-2),
        answers(questions).map((answer) => ({
          ...answer,
          sourceAgent: "researcher",
          cycle: 1,
        })),
      );
      assert.equal(
        (state.results.previous_researcher as any).unresolvedQuestions.length,
        2,
      );
      assert.equal(state.results.researcher, undefined);
      const context = await contextFor("researcher", state);
      assert.deepEqual(context.answers.slice(-2), state.answers.slice(-2));
      assert.match(
        context.researchClarification.instruction,
        /Remove answered questions from unresolvedQuestions/,
      );
    }
    if (role.startsWith("solver")) {
      assert.equal(
        (state.results.researcher as any).unresolvedQuestions.length,
        0,
      );
      assert.equal(runner.counts.researcher, 2);
    }
    return undefined;
  });
  const cfg = config();
  cfg.qualityGates.commit.enabled = false;
  const engine = new WorkflowEngine(cwd, runner, {
    progress() {},
    ask: async () => undefined,
    askResearchQuestions: async (items) => answers(items),
  });
  const state = await engine.start("Fix addition", cfg);
  await engine.run(state);
  assert.equal(state.phase, "DONE", state.blocker);
  assert.equal(runner.counts.researcher, 2);
  assert.equal(state.agentFailures, 0);
  assert.equal(state.questionCount, 0);
  assert.equal(state.researchClarificationCount, 1);
  const starts = state.history.filter(
    (entry) =>
      entry.event === "agent_attempt_started" &&
      entry.meta?.agent === "researcher",
  );
  assert.deepEqual(
    starts.map((entry) => [entry.meta?.attempt, entry.meta?.trigger]),
    [
      [1, "initial"],
      [2, "user_clarification"],
    ],
  );
  assert.equal(
    state.history.find(
      (entry) => entry.event === "research_questions_requested",
    )?.meta?.count,
    2,
  );
  assert.equal(
    state.history.find((entry) => entry.event === "research_questions_answered")
      ?.meta?.count,
    2,
  );
});

test("SOLVE phase refuses a Researcher result with unresolved questions", async () => {
  const cwd = await repository();
  const runner = new FixtureRunner();
  const engine = new WorkflowEngine(cwd, runner, {
    progress() {},
    ask: async () => undefined,
  });
  const state = await engine.start("Fix addition", config());
  state.phase = "SOLVE";
  state.commandApprovalComplete = true;
  state.results.researcher = { ...research, unresolvedQuestions: questions };
  await engine.run(state);
  assert.equal(state.phase, "BLOCKED");
  assert.match(
    state.blocker ?? "",
    /Solvers require a current Researcher result/,
  );
  assert.equal(runner.calls.length, 0);
});

test("multiple research clarification rounds stay local to Researcher", async () => {
  const cwd = await repository();
  const runner = new FixtureRunner(async (role, _state, count) =>
    role === "researcher" && count <= 2
      ? {
          ...research,
          unresolvedQuestions: count === 1 ? questions : ["Question C?"],
        }
      : undefined,
  );
  const cfg = config();
  cfg.qualityGates.commit.enabled = false;
  const asked: string[][] = [];
  const engine = new WorkflowEngine(cwd, runner, {
    progress() {},
    ask: async () => undefined,
    askResearchQuestions: async (items) => {
      asked.push(items);
      return answers(items);
    },
  });
  const state = await engine.start("Fix addition", cfg);
  await engine.run(state);
  assert.equal(state.phase, "DONE", state.blocker);
  assert.deepEqual(asked, [questions, ["Question C?"]]);
  assert.equal(runner.counts.researcher, 3);
  assert.equal(runner.counts.orchestrator, 1);
  assert.equal(state.questionCount, 0);
  assert.equal(state.researchClarificationCount, 2);
  assert.equal(state.agentFailures, 0);
});

test("research clarification limit blocks without starting Solvers", async () => {
  const cwd = await repository();
  const runner = new FixtureRunner(async (role) =>
    role === "researcher"
      ? { ...research, unresolvedQuestions: ["Still blocked?"] }
      : undefined,
  );
  const cfg = config();
  cfg.workflow.maxResearchClarifications = 1;
  const engine = new WorkflowEngine(cwd, runner, {
    progress() {},
    ask: async () => undefined,
    askResearchQuestions: async (items) => answers(items),
  });
  const state = await engine.start("Fix addition", cfg);
  await engine.run(state);
  assert.equal(state.phase, "BLOCKED");
  assert.match(
    state.blocker ?? "",
    /Research clarification limit reached.*1 clarification rounds/,
  );
  assert.equal(state.pendingResearchQuestions, undefined);
  assert.equal(state.researchClarificationCount, 1);
  assert.equal(runner.counts.researcher, 2);
  assert.equal(
    runner.calls.filter((role) => role.startsWith("solver")).length,
    0,
  );
  assert.equal(state.agentFailures, 0);
});

test("five ordinary interactions do not consume a Researcher clarification", async () => {
  const cwd = await repository();
  const cfg = config();
  cfg.workflow.maxQuestions = 5;
  cfg.workflow.maxResearchClarifications = 1;
  const runner = new FixtureRunner(async (role) =>
    role === "researcher"
      ? { ...research, unresolvedQuestions: questions }
      : undefined,
  );
  const engine = new WorkflowEngine(cwd, runner, {
    progress() {},
    ask: async () => undefined,
    askResearchQuestions: async () => undefined,
  });
  const state = await engine.start("Fix addition", cfg);
  state.phase = "RESEARCH";
  state.questionCount = 5; // Three approvals and two generic questions already occurred.
  await engine.run(state);
  assert.equal(state.phase, "WAITING_USER");
  assert.equal(state.questionCount, 5);
  assert.equal(state.researchClarificationCount, 1);
  assert.match(
    renderProgress(state).join("\n"),
    /Research clarification: 1\/1/,
  );
});

for (const limit of [5, 0])
  test(`Researcher clarification ${limit === 0 ? "unlimited" : "five-round"} boundary`, async () => {
    const cwd = await repository();
    const cfg = config();
    cfg.qualityGates.commit.enabled = false;
    cfg.workflow.maxResearchClarifications = limit;
    const runner = new FixtureRunner(async (role, _state, count) =>
      role === "researcher" && count <= 6
        ? { ...research, unresolvedQuestions: [`Round ${count}?`] }
        : undefined,
    );
    const asked: string[][] = [];
    const engine = new WorkflowEngine(cwd, runner, {
      progress() {},
      ask: async () => undefined,
      askResearchQuestions: async (items) => {
        asked.push(items);
        return answers(items);
      },
    });
    const state = await engine.start("Fix addition", cfg);
    await engine.run(state);
    assert.equal(state.researchClarificationCount, limit === 0 ? 6 : 5);
    assert.equal(asked.length, limit === 0 ? 6 : 5);
    assert.equal(state.phase, limit === 0 ? "DONE" : "BLOCKED", state.blocker);
    if (limit === 5) assert.equal(runner.counts.researcher, 6);
    else
      assert.doesNotMatch(
        renderProgress(state).join("\n"),
        /Research clarification: 6\/0/,
      );
  });
