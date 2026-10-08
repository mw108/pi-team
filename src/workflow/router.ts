import { block, record, type WorkflowState, type Phase } from "./state.ts";
import { pentestSchema, type Role } from "../agents/schemas.ts";
import { enforcePentestPolicy } from "./pentest-policy.ts";
import { getActiveSolverIds } from "../config/solvers.ts";
import {
  currentSecurityRiskReview,
  matchingSecurityRiskReview,
  requestSecurityRiskReview,
} from "./security-risk-review.ts";
export const phaseRoles: Partial<Record<Phase, Role[]>> = {
  ORCHESTRATE: ["orchestrator"],
  RESEARCH: ["researcher"],
  SOLVE: [],
  CRITIQUE: ["critic"],
  REVIEW: ["reviewer"],
  IMPLEMENT: ["implementor"],
  CODE_REVIEW: ["codeReviewer"],
  PENTEST: ["pentester"],
  SECURITY_REVIEW: ["securityReviewer"],
  TEST: ["tester"],
  COMMIT: ["commitAgent"],
  REPORT: ["reporter"],
};
export function getPhaseRoles(
  s: WorkflowState,
  phase: Phase,
): Role[] | undefined {
  return phase === "SOLVE" ? getActiveSolverIds(s.config) : phaseRoles[phase];
}
export function afterCodeReview(s: WorkflowState): Phase {
  return s.config.qualityGates.pentest.enabled ? "PENTEST" : "SECURITY_REVIEW";
}
export function afterSecurity(s: WorkflowState): Phase {
  return s.config.qualityGates.testing.enabled ? "TEST" : afterTests(s);
}
export function afterTests(s: WorkflowState): Phase {
  return s.config.qualityGates.commit.enabled ? "COMMIT" : "REPORT";
}
export function fix(
  s: WorkflowState,
  route: "FIX_LOCAL" | "FIX_DESIGN" | "FIX_REQUIREMENTS",
  question?: string,
) {
  record(s, route, s.phase);
  delete s.securityRiskReview;
  if (route === "FIX_REQUIREMENTS") {
    const sourcePhase = s.phase;
    const sourceAgent = getPhaseRoles(s, sourcePhase)?.[0];
    if (!sourceAgent)
      throw new Error(`Unknown FIX_REQUIREMENTS source in ${sourcePhase}`);
    s.pendingQuestion = {
      type: "QUESTION_REQUEST",
      blocking: true,
      question: question ?? "Clarify the blocking requirement.",
      reason: "A quality gate needs a requirement decision.",
      route,
      sourceAgent,
      sourcePhase,
    };
    s.resumePhase = "ORCHESTRATE";
    s.phase = "WAITING_USER";
    return;
  }
  if (route === "FIX_DESIGN") {
    if (s.fullCycle >= s.config.workflow.maxFullCycles) {
      block(s, "Full design cycle limit reached");
      return;
    }
    s.fullCycle++;
    s.phase = "RESEARCH";
    if (s.results.researcher)
      s.results.previous_researcher = s.results.researcher;
    delete s.results.researcher;
  } else {
    if (s.localFixCycle >= s.config.workflow.maxLocalFixCycles) {
      block(s, "Local fix cycle limit reached");
      return;
    }
    s.localFixCycle++;
    s.phase = "IMPLEMENT";
  }
  // Keep prior outputs as evidence, but invalidate all downstream gate approvals.
  for (const key of [
    "codeReviewer",
    "pentester",
    "securityReviewer",
    "tester",
    "commitAgent",
  ]) {
    if (s.results[key]) s.results[`previous_${key}`] = s.results[key];
    delete s.results[key];
  }
  delete s.gateHashes;
  if (route === "FIX_DESIGN")
    for (const key of [
      ...getActiveSolverIds(s.config),
      "critic",
      "reviewer",
      "implementor",
    ]) {
      if (s.results[key]) s.results[`previous_${key}`] = s.results[key];
      delete s.results[key];
    }
}
export function transition(s: WorkflowState) {
  switch (s.phase) {
    case "ORCHESTRATE":
      if (!s.results.orchestrator)
        throw new Error("Missing Orchestrator result");
      s.requirements = s.results.orchestrator.requirements;
      s.phase = "RESEARCH";
      break;
    case "RESEARCH":
      if (
        !s.results.researcher ||
        s.results.researcher.unresolvedQuestions.length !== 0
      )
        throw new Error(
          "Researcher has unresolved questions; Solvers cannot start",
        );
      for (const key of [
        ...getActiveSolverIds(s.config),
        "critic",
        "reviewer",
        "implementor",
        "codeReviewer",
        "pentester",
        "securityReviewer",
        "tester",
        "commitAgent",
      ]) {
        if (s.results[key]) s.results[`previous_${key}`] = s.results[key];
        delete s.results[key];
      }
      delete s.gateHashes;
      delete s.securityRiskReview;
      s.phase = "SOLVE";
      break;
    case "SOLVE":
      s.phase = "CRITIQUE";
      break;
    case "CRITIQUE":
      s.phase = "REVIEW";
      break;
    case "REVIEW":
      s.phase = "IMPLEMENT";
      break;
    case "IMPLEMENT": {
      const r = s.results.implementor;
      if (!r) throw new Error("Missing Implementor result");
      if (r.status === "IMPLEMENTATION_BLOCKED")
        fix(s, r.suggestedRoute, r.reason);
      else
        s.phase = s.config.qualityGates.codeReview.enabled
          ? "CODE_REVIEW"
          : afterCodeReview(s);
      break;
    }
    case "CODE_REVIEW": {
      const r = s.results.codeReviewer;
      if (!r) throw new Error("Missing Code Reviewer result");
      if (r.status === "APPROVED") s.phase = afterCodeReview(s);
      else fix(s, r.status, r.question);
      break;
    }
    case "PENTEST": {
      const result = enforcePentestPolicy(
        s,
        pentestSchema.parse(s.results.pentester),
      );
      s.results.pentester = result;
      if (result.status === "BLOCKED") {
        s.pentestCycle = Math.max(0, s.pentestCycle - 1);
        const attempt = s.history.findLast(
          (event) =>
            event.event === "agent_attempt_started" &&
            event.meta?.agent === "pentester",
        )?.meta?.attempt;
        block(
          s,
          `Pentest blocked: ${result.blocker!.message}`,
          attempt
            ? {
                kind: "quality_gate_blocked",
                sourceAgent: "pentester",
                sourcePhase: "PENTEST",
                sourceAttempt: attempt,
              }
            : undefined,
        );
      } else s.phase = "SECURITY_REVIEW";
      break;
    }
    case "SECURITY_REVIEW": {
      const review = s.results.securityReviewer,
        pentest = s.results.pentester;
      if (!review) throw new Error("Missing Security Reviewer result");
      if (s.config.qualityGates.pentest.enabled && !pentest) {
        block(s, "Security review requires the enabled Pentest result");
        break;
      }
      const expected = s.config.qualityGates.pentest.enabled
        ? pentest?.findings.map((f) => f.id).sort()
        : undefined;
      const actual = review.findings.map((f) => f.id).sort();
      if (expected && JSON.stringify(expected) !== JSON.stringify(actual)) {
        block(
          s,
          "Security review must classify every pentest finding exactly once",
        );
        break;
      }
      const confirmed = review.findings.filter(
        (f) => f.classification === "CONFIRMED",
      );
      if (confirmed.some((f) => !f.route)) {
        block(s, "Confirmed findings require a fix route");
        break;
      }
      if (confirmed.length)
        fix(
          s,
          confirmed.some((f) => f.route === "FIX_DESIGN")
            ? "FIX_DESIGN"
            : "FIX_LOCAL",
        );
      else if (currentSecurityRiskReview(s)) {
        if (
          s.securityRiskReview?.status === "accepted" &&
          matchingSecurityRiskReview(s)
        )
          s.phase = afterSecurity(s);
        else requestSecurityRiskReview(s);
      } else {
        delete s.securityRiskReview;
        s.phase = afterSecurity(s);
      }
      break;
    }
    case "TEST": {
      const r = s.results.tester;
      if (!r) throw new Error("Missing Tester result");
      if (r.status === "BLOCKED") {
        const attempt = s.history.findLast(
          (event) =>
            event.event === "agent_attempt_started" &&
            event.meta?.agent === "tester",
        )?.meta?.attempt;
        block(
          s,
          `Testing blocked: ${r.reason ?? "Required validation could not run"}`,
          attempt
            ? {
                kind: "quality_gate_blocked",
                sourceAgent: "tester",
                sourcePhase: "TEST",
                sourceAttempt: attempt,
              }
            : undefined,
        );
        break;
      }
      if (
        r.status === "PASS" &&
        r.commands.length &&
        r.commands.every((c) => c.exitCode === 0)
      )
        s.phase = afterTests(s);
      else fix(s, r.classification ?? "FIX_LOCAL");
      break;
    }
    case "COMMIT":
      s.phase = "REPORT";
      break;
    case "REPORT":
      s.phase = "DONE";
      break;
  }
}
