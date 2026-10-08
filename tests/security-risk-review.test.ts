import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { WorkflowEngine } from "../src/workflow/engine.ts";
import {
  block,
  newState,
  record,
  validateState,
} from "../src/workflow/state.ts";
import { transition } from "../src/workflow/router.ts";
import { getWorkflowRecoveryPlan } from "../src/workflow/recovery.ts";
import { renderProgress } from "../src/ui/progress.ts";
import { approvalParams, approvalValues } from "../src/integrations/pi-ask.ts";
import { currentSecurityRiskReview } from "../src/workflow/security-risk-review.ts";
import { buildCompletionReportInput } from "../src/workflow/report.ts";
import { FixtureRunner, config, output, repository } from "./helpers.ts";
import { redactVisibleText } from "../src/agents/redaction.ts";

const incident = {
  id: "register-verify-005",
  classification: "ACCEPTED_RISK" as const,
  evidence:
    "The verification URL contains a signature query parameter as part of the signed verification-link mechanism.",
};
const other = {
  id: "risk-002",
  classification: "ACCEPTED_RISK" as const,
  evidence: "The fallback path retains an older cipher for compatibility.",
};
const tokenEvidence = "Authorization: Bearer test-token-123";
const tokenFinding = {
  id: "risk-token-001",
  classification: "ACCEPTED_RISK" as const,
  evidence: tokenEvidence,
};
const review = (...findings: any[]) => ({ findings, summary: "Reviewed" });
const noCommit = () => {
  const cfg = config();
  cfg.qualityGates.commit.enabled = false;
  return cfg;
};

async function fixture(
  findings: any[] = [incident],
  answer?: "yes" | "no",
  nextReview?: any[],
) {
  const cwd = await repository();
  const runner = new FixtureRunner(async (role, _state, count) =>
    role === "securityReviewer"
      ? review(...(count === 1 ? findings : (nextReview ?? findings)))
      : undefined,
  );
  const requests: any[] = [];
  const engine = new WorkflowEngine(cwd, runner, {
    progress: () => {},
    ask: async () => undefined,
    approve: async (request) => {
      if (request.kind !== "securityRisk") return undefined;
      requests.push(request);
      return answer ? [answer] : undefined;
    },
  });
  const state = await engine.start("Fix addition", noCommit());
  await engine.run(state);
  return { cwd, runner, requests, engine, state };
}

test("review state, reviewer result, and pi-ask retain original token-like evidence", async () => {
  const { state, engine, requests } = await fixture([tokenFinding]);
  assert.equal(state.phase, "WAITING_USER");
  assert.equal(
    state.results.securityReviewer?.findings[0].evidence,
    tokenEvidence,
  );
  assert.equal(state.securityRiskReview?.findings[0].evidence, tokenEvidence);
  assert.match(requests[0].prompt, /Authorization: Bearer test-token-123/);
  assert.doesNotMatch(requests[0].prompt, /\[REDACTED\]/);
  const loaded = await engine.store.load(state.id);
  assert.equal(
    loaded.results.securityReviewer?.findings[0].evidence,
    tokenEvidence,
  );
  assert.equal(loaded.securityRiskReview?.findings[0].evidence, tokenEvidence);
  assert.ok(
    (await readFile(engine.store.path(state.id), "utf8")).includes(
      tokenEvidence,
    ),
  );
});

test("status, history, and agent logs keep token-like evidence out of diagnostics", async () => {
  const { state, engine } = await fixture([tokenFinding]);
  assert.doesNotMatch(renderProgress(state).join("\n"), /test-token-123/);
  assert.doesNotMatch(JSON.stringify(state.history), /test-token-123/);
  assert.doesNotMatch(
    JSON.stringify(await engine.logs.read(state.id, "securityReviewer", 1)),
    /test-token-123/,
  );
  assert.ok(
    state.history.some(
      (entry) => entry.event === "security_risk_review_requested",
    ),
  );
});

test("digest distinguishes original evidence that would redact to the same text", () => {
  const a = "Authorization: Bearer token-A";
  const b = "Authorization: Bearer token-B";
  assert.equal(redactVisibleText(a), redactVisibleText(b));
  const state = newState("/tmp/security-review", "task", noCommit(), {
    head: null,
    dirtyPaths: [],
    status: "",
    diff: "",
    cachedDiff: "",
  });
  state.results.securityReviewer = review({ ...tokenFinding, evidence: a });
  const digestA = currentSecurityRiskReview(state)?.resultHash;
  state.results.securityReviewer = review({ ...tokenFinding, evidence: b });
  const digestB = currentSecurityRiskReview(state)?.resultHash;
  assert.notEqual(digestA, digestB);
});

test("long question evidence is truncated without redacting its beginning", async () => {
  const evidence = `${tokenEvidence}\n${"context ".repeat(500)}`;
  const { state, requests } = await fixture([{ ...tokenFinding, evidence }]);
  assert.equal(state.securityRiskReview?.findings[0].evidence, evidence);
  assert.match(requests[0].prompt, /Authorization: Bearer test-token-123/);
  assert.match(requests[0].prompt, /\[truncated\]/);
  assert.ok(requests[0].prompt.length < 1500);
});

test("one accepted risk asks through the existing single-choice pi-ask contract; Yes persists and continues", async () => {
  const { state, runner, requests } = await fixture([incident], "yes");
  assert.equal(state.phase, "DONE", state.blocker);
  assert.equal(requests.length, 1);
  assert.match(requests[0].prompt, /\[register-verify-005\]/);
  assert.match(requests[0].prompt, /signature query parameter/);
  assert.match(requests[0].prompt, /Accept this security risk and continue\?/);
  assert.equal(approvalParams(requests[0]).questions[0].type, "single");
  assert.deepEqual(
    requests[0].options.map((option: any) => option.value),
    ["yes", "no"],
  );
  assert.equal(state.securityRiskReview?.status, "accepted");
  assert.equal(
    state.securityRiskReview?.resultHash,
    currentSecurityRiskReview(state)?.resultHash,
  );
  assert.equal(state.agentFailures, 0);
  assert.equal(runner.counts.securityReviewer, 1);
  assert.ok(runner.calls.includes("tester"));
  assert.ok(
    state.history.some(
      (event) => event.event === "security_risk_review_requested",
    ),
  );
  assert.ok(
    state.history.some(
      (event) => event.event === "security_risk_review_accepted",
    ),
  );
  assert.ok(!state.history.some((event) => event.event === "agent_failure"));
});

test("approved accepted risks can pass the Commit gate and appear in report metadata", async () => {
  const cwd = await repository();
  const runner = new FixtureRunner(async (role) =>
    role === "securityReviewer" ? review(incident) : undefined,
  );
  const engine = new WorkflowEngine(cwd, runner, {
    progress: () => {},
    ask: async () => undefined,
    approve: async (request) =>
      request.kind === "securityRisk" ? ["yes"] : undefined,
  });
  const state = await engine.start("Fix addition", config());
  await engine.run(state);
  assert.equal(state.phase, "DONE", state.blocker);
  assert.ok(state.commit);
  const report = await buildCompletionReportInput(state, true);
  assert.match(
    report.validation.find((entry) => entry.label === "Security review")
      ?.detail ?? "",
    /explicitly approved by the user/,
  );
});

test("Yes resumes through configured ordering when testing and commit are disabled", async () => {
  const cwd = await repository();
  const cfg = noCommit();
  cfg.qualityGates.testing.enabled = false;
  const runner = new FixtureRunner(async (role) =>
    role === "securityReviewer" ? review(incident) : undefined,
  );
  const engine = new WorkflowEngine(cwd, runner, {
    progress: () => {},
    ask: async () => undefined,
    approve: async (request) =>
      request.kind === "securityRisk" ? ["yes"] : undefined,
  });
  const state = await engine.start("Fix addition", cfg);
  await engine.run(state);
  assert.equal(state.phase, "DONE", state.blocker);
  assert.equal(runner.counts.tester, undefined);
  assert.equal(runner.counts.reporter, 1);
});

test("No records rejection and uses the normal aborted state", async () => {
  const { state, runner, requests } = await fixture([incident], "no");
  assert.equal(requests.length, 1);
  assert.equal(state.phase, "ABORTED");
  assert.equal(runner.counts.tester, undefined);
  assert.ok(
    state.history.some(
      (event) => event.event === "security_risk_review_rejected",
    ),
  );
  assert.equal(state.history.at(-1)?.event, "workflow_aborted");
  assert.match(
    state.history.at(-1)?.detail ?? "",
    /User rejected accepted security risks/,
  );
  assert.equal(state.agentFailures, 0);
});

test("multiple risks use one bounded aggregate question", async () => {
  const huge = { ...other, evidence: "e".repeat(4000) };
  const { state, requests } = await fixture([incident, huge], "yes");
  assert.equal(state.phase, "DONE", state.blocker);
  assert.equal(requests.length, 1);
  assert.match(requests[0].prompt, /\[register-verify-005\]/);
  assert.match(requests[0].prompt, /\[risk-002\]/);
  assert.match(requests[0].prompt, /signature query parameter/);
  assert.match(requests[0].prompt, /e{100}/);
  assert.match(requests[0].prompt, /\[truncated\]/);
  assert.ok(requests[0].prompt.length < 3000);
});

for (const findings of [
  [],
  [{ id: "fp", classification: "FALSE_POSITIVE", evidence: "Not exploitable" }],
])
  test(`${findings.length ? "false positives" : "no findings"} do not ask`, async () => {
    const { state, requests } = await fixture(findings);
    assert.equal(state.phase, "DONE", state.blocker);
    assert.equal(requests.length, 0);
  });

test("confirmed remediation takes precedence over accepted risk", () => {
  const state = newState("/tmp/security-review", "task", noCommit(), {
    head: null,
    dirtyPaths: [],
    status: "",
    diff: "",
    cachedDiff: "",
  });
  state.phase = "SECURITY_REVIEW";
  state.results.securityReviewer = review(incident, {
    id: "confirmed-1",
    classification: "CONFIRMED",
    route: "FIX_LOCAL",
    evidence: "Reproduced",
  });
  transition(state);
  assert.equal(state.phase, "IMPLEMENT");
  assert.equal(state.securityRiskReview, undefined);
});

test("upstream requirement changes clear an earlier accepted-risk decision", () => {
  const state = newState("/tmp/security-review", "task", noCommit(), {
    head: null,
    dirtyPaths: [],
    status: "",
    diff: "",
    cachedDiff: "",
  });
  state.phase = "SECURITY_REVIEW";
  state.results.securityReviewer = review(incident);
  transition(state);
  state.securityRiskReview!.status = "accepted";
  state.phase = "CODE_REVIEW";
  state.results.codeReviewer = {
    status: "FIX_REQUIREMENTS",
    findings: [],
    question: "Clarify scope?",
  };
  transition(state);
  assert.equal(state.phase, "WAITING_USER");
  assert.equal(state.securityRiskReview, undefined);
  assert.equal(state.pendingQuestion?.question, "Clarify scope?");
});

test("pending cancellation survives restart and /team-continue asks again", async () => {
  const { cwd, state, runner } = await fixture();
  assert.equal(state.phase, "WAITING_USER");
  const plan = await getWorkflowRecoveryPlan(state, cwd);
  assert.equal(plan.kind, "continue");
  assert.equal(plan.actions[0].command, "/team-continue");
  const lines = renderProgress(state).join("\n");
  assert.match(lines, /Waiting for explicit review/);
  assert.match(lines, /register-verify-005/);
  assert.doesNotMatch(lines, /Next action: \/team-abort/);
  const requests: any[] = [];
  const resumed = new WorkflowEngine(cwd, runner, {
    progress: () => {},
    ask: async () => undefined,
    approve: async (request) => {
      requests.push(request);
      return ["yes"];
    },
  });
  const loaded = await resumed.store.load(state.id);
  await resumed.continueBlocked(loaded);
  assert.equal(loaded.phase, "DONE", loaded.blocker);
  assert.equal(requests.length, 1);
  assert.equal(runner.counts.securityReviewer, 1);
});

test("/team-continue reopens pending review with original evidence after restart", async () => {
  const { cwd, state, runner } = await fixture([tokenFinding]);
  const prompts: string[] = [];
  const resumed = new WorkflowEngine(cwd, runner, {
    progress: () => {},
    ask: async () => undefined,
    approve: async (request) => {
      prompts.push(request.prompt);
      return undefined;
    },
  });
  const loaded = await resumed.store.load(state.id);
  await resumed.continueBlocked(loaded);
  assert.equal(loaded.phase, "WAITING_USER");
  assert.equal(loaded.securityRiskReview?.findings[0].evidence, tokenEvidence);
  assert.match(prompts[0], /Authorization: Bearer test-token-123/);
});

test("older redacted pending review is rebuilt when original reviewer result survives", async () => {
  const { cwd, state, runner } = await fixture([tokenFinding]);
  const redacted = redactVisibleText(tokenEvidence);
  state.securityRiskReview!.findings[0].evidence = redacted;
  state.securityRiskReview!.resultHash = createHash("sha256")
    .update(JSON.stringify(state.securityRiskReview!.findings))
    .digest("hex");
  await new WorkflowEngine(cwd, runner, {
    progress: () => {},
    ask: async () => undefined,
  }).store.save(state);
  const prompts: string[] = [];
  const resumed = new WorkflowEngine(cwd, runner, {
    progress: () => {},
    ask: async () => undefined,
    approve: async (request) => {
      prompts.push(request.prompt);
      return undefined;
    },
  });
  const loaded = await resumed.store.load(state.id);
  await resumed.continueBlocked(loaded);
  assert.equal(loaded.phase, "WAITING_USER");
  assert.equal(loaded.securityRiskReview?.findings[0].evidence, tokenEvidence);
  assert.match(prompts[0], /Authorization: Bearer test-token-123/);
});

test("an interrupted pi-ask leaves the review pending", async () => {
  const { state, cwd, runner } = await fixture();
  const resumed = new WorkflowEngine(cwd, runner, {
    progress: () => {},
    ask: async () => undefined,
    approve: async () => {
      throw new Error("Pi ask closed");
    },
  });
  await resumed.continueBlocked(state);
  assert.equal(state.phase, "WAITING_USER");
  assert.equal(state.securityRiskReview?.status, "pending");
  assert.equal(state.agentFailures, 0);
  assert.ok(
    state.history.some(
      (event) => event.event === "security_risk_review_interrupted",
    ),
  );
});

test("a separate pending approval takes priority over the risk confirmation", async () => {
  const { state, cwd } = await fixture();
  state.pendingApproval = {
    kind: "configDrift",
    title: "Config changed",
    prompt: "Review config",
    options: [{ value: "abort", label: "Abort", description: "Stop" }],
  };
  const plan = await getWorkflowRecoveryPlan(state, cwd);
  assert.equal(plan.kind, "waiting-user");
});

test("accepted decision persisted before transition resumes without asking or rerunning reviewer", async () => {
  const { cwd, state, runner } = await fixture();
  state.securityRiskReview!.status = "accepted";
  state.securityRiskReview!.reviewedAt = new Date().toISOString();
  await new WorkflowEngine(cwd, runner, {
    progress: () => {},
    ask: async () => undefined,
  }).store.save(state);
  let asks = 0;
  const resumed = new WorkflowEngine(cwd, runner, {
    progress: () => {},
    ask: async () => undefined,
    approve: async () => {
      asks++;
      return ["yes"];
    },
  });
  const loaded = await resumed.store.load(state.id);
  await resumed.continueBlocked(loaded);
  assert.equal(loaded.phase, "DONE", loaded.blocker);
  assert.equal(asks, 0);
  assert.equal(runner.counts.securityReviewer, 1);
});

test("retry after saved Yes invalidates approval and asks again for an identical review", async () => {
  const { state, engine, runner, requests } = await fixture();
  state.securityRiskReview!.status = "accepted";
  await engine.store.save(state);
  assert.equal(
    await engine.retryAgent(state, "securityReviewer", true),
    "prepared",
  );
  assert.equal(state.securityRiskReview, undefined);
  await engine.run(state);
  assert.equal(state.phase, "WAITING_USER", state.blocker);
  assert.equal(runner.counts.securityReviewer, 2);
  assert.equal(requests.length, 2);
});

test("changed evidence after saved Yes restores pending review before downstream work", async () => {
  const { state, engine, runner, requests } = await fixture();
  state.securityRiskReview!.status = "accepted";
  state.results.securityReviewer!.findings[0].evidence = "Changed evidence";
  await engine.store.save(state);
  await engine.continueBlocked(state);
  assert.equal(state.phase, "WAITING_USER", state.blocker);
  assert.equal(requests.length, 2);
  assert.match(requests.at(-1).prompt, /Changed evidence/);
  assert.equal(runner.counts.tester, undefined);
});

for (const answer of ["yes", "no"] as const)
  test(`legacy accepted-risk BLOCKED state recovers through /team-continue (${answer})`, async () => {
    const { cwd, state, runner } = await fixture();
    delete state.securityRiskReview;
    state.phase = "SECURITY_REVIEW";
    block(state, "Accepted security risks require explicit user review");
    await new WorkflowEngine(cwd, runner, {
      progress: () => {},
      ask: async () => undefined,
    }).store.save(state);
    const requests: any[] = [];
    const resumed = new WorkflowEngine(cwd, runner, {
      progress: () => {},
      ask: async () => undefined,
      approve: async (request) => {
        requests.push(request);
        return [answer];
      },
    });
    const loaded = await resumed.store.load(state.id);
    assert.equal((await getWorkflowRecoveryPlan(loaded, cwd)).kind, "continue");
    await resumed.continueBlocked(loaded);
    assert.equal(requests.length, 1);
    assert.match(requests[0].prompt, /register-verify-005/);
    assert.equal(
      loaded.phase,
      answer === "yes" ? "DONE" : "ABORTED",
      loaded.blocker,
    );
    assert.equal(runner.counts.securityReviewer, 1);
  });

test("legacy blocked recovery copies original Security Reviewer evidence into pi-ask", async () => {
  const evidence =
    "API_KEY_INTERNAL is exposed in debug output; Authorization: Bearer legacy-token-123";
  const { cwd, state, runner } = await fixture([{ ...tokenFinding, evidence }]);
  delete state.securityRiskReview;
  state.phase = "SECURITY_REVIEW";
  block(state, "Accepted security risks require explicit user review");
  await new WorkflowEngine(cwd, runner, {
    progress: () => {},
    ask: async () => undefined,
  }).store.save(state);
  const prompts: string[] = [];
  const resumed = new WorkflowEngine(cwd, runner, {
    progress: () => {},
    ask: async () => undefined,
    approve: async (request) => {
      prompts.push(request.prompt);
      return undefined;
    },
  });
  const loaded = await resumed.store.load(state.id);
  await resumed.continueBlocked(loaded);
  assert.equal(loaded.phase, "WAITING_USER");
  assert.equal(loaded.securityRiskReview?.findings[0].evidence, evidence);
  assert.ok(prompts[0].includes(evidence));
});

test("legacy blocker with a confirmed vulnerability does not offer risk acceptance", async () => {
  const { cwd, state, runner } = await fixture();
  delete state.securityRiskReview;
  state.results.securityReviewer = review(incident, {
    id: "confirmed",
    classification: "CONFIRMED",
    route: "FIX_LOCAL",
    evidence: "Reproduced",
  });
  state.phase = "SECURITY_REVIEW";
  block(state, "Accepted security risks require explicit user review");
  await new WorkflowEngine(cwd, runner, {
    progress: () => {},
    ask: async () => undefined,
  }).store.save(state);
  const plan = await getWorkflowRecoveryPlan(state, cwd);
  assert.notEqual(plan.kind, "continue");
});

for (const [name, next] of [
  ["no risks", []],
  ["same risk", [incident]],
  ["changed risk", [other]],
  ["added risk", [incident, other]],
] as const)
  test(`retry pending Security Reviewer with ${name} supersedes prior decision`, async () => {
    const { state, engine, runner, requests } = await fixture(
      [incident],
      undefined,
      [...next],
    );
    assert.equal(state.phase, "WAITING_USER");
    assert.equal(
      await engine.retryAgent(state, "securityReviewer"),
      "prepared",
    );
    assert.equal(state.securityRiskReview, undefined);
    await engine.run(state);
    assert.equal(runner.counts.securityReviewer, 2);
    assert.equal(requests.length, next.length ? 2 : 1);
    assert.equal(
      state.phase,
      next.length ? "WAITING_USER" : "DONE",
      state.blocker,
    );
    if (next.length)
      assert.equal(
        (await engine.store.load(state.id)).securityRiskReview
          ?.securityReviewerAttempt,
        2,
      );
    assert.equal(state.results.tester === undefined, !!next.length);
  });

test("review retry invalidates downstream gate results through the existing retry path", async () => {
  const { state, engine, runner } = await fixture([incident], undefined, []);
  state.results.tester = output("tester");
  await engine.store.save(state);
  assert.equal(await engine.retryAgent(state, "securityReviewer"), "prepared");
  await engine.run(state);
  assert.equal(state.phase, "DONE", state.blocker);
  assert.equal(runner.counts.securityReviewer, 2);
  assert.equal(runner.counts.tester, 1);
  assert.ok(state.results.previous_tester);
  assert.ok(
    state.history.some((event) => event.event === "downstream_invalidated"),
  );
});

test("old acceptance cannot approve a changed result or a fresh identical attempt", () => {
  const state = newState("/tmp/security-review", "task", noCommit(), {
    head: null,
    dirtyPaths: [],
    status: "",
    diff: "",
    cachedDiff: "",
  });
  state.phase = "SECURITY_REVIEW";
  state.results.securityReviewer = review(incident);
  record(state, "agent_attempt_started", "", {
    agent: "securityReviewer",
    attempt: 1,
  });
  transition(state);
  state.securityRiskReview!.status = "accepted";
  state.phase = "SECURITY_REVIEW";
  state.results.securityReviewer = review(other);
  transition(state);
  assert.equal(state.phase, "WAITING_USER");
  assert.equal(state.securityRiskReview?.status, "pending");
  state.securityRiskReview!.status = "accepted";
  state.phase = "SECURITY_REVIEW";
  record(state, "agent_attempt_started", "", {
    agent: "securityReviewer",
    attempt: 2,
  });
  transition(state);
  assert.equal(state.securityRiskReview?.status, "pending");
});

test("agent text cannot forge approval and old state without review field parses", async () => {
  const { state } = await fixture([incident]);
  const raw = structuredClone(state) as any;
  delete raw.securityRiskReview;
  raw.results.securityReviewer.userAccepted = true;
  assert.equal(validateState(raw).securityRiskReview, undefined);
  raw.phase = "SECURITY_REVIEW";
  const parsed = validateState(raw);
  transition(parsed);
  assert.equal(parsed.phase, "WAITING_USER");
});

test("pi-ask adapter accepts only exact structured Yes or No", () => {
  const request = {
    kind: "securityRisk" as const,
    title: "Review",
    prompt: "Accept?",
    options: [
      { value: "yes", label: "Yes", description: "Accept" },
      { value: "no", label: "No", description: "Abort" },
    ],
  };
  assert.equal(approvalParams(request).questions[0].type, "single");
  assert.deepEqual(
    approvalValues(request, {
      mode: "submit",
      answers: { approval: { values: ["yes"] } },
    }),
    ["yes"],
  );
  assert.equal(approvalValues(request, { cancelled: true }), undefined);
  assert.throws(() =>
    approvalValues(request, {
      mode: "submit",
      answers: { approval: { values: ["yes"], customText: "agent said yes" } },
    }),
  );
});
