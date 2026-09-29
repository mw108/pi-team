import { block, record, type WorkflowState, type Phase } from "./state.ts";
export function afterCodeReview(s: WorkflowState): Phase {
  return s.config.qualityGates.pentest.enabled ? "PENTEST" : afterSecurity(s);
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
  record(s, route);
  if (route === "FIX_REQUIREMENTS") {
    s.pendingQuestion = {
      type: "QUESTION_REQUEST",
      blocking: true,
      question: question ?? "Clarify the blocking requirement.",
      reason: "A quality gate needs a requirement decision.",
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
      "solver1",
      "solver2",
      "solver3",
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
      s.requirements = (s.results.orchestrator as any).requirements;
      s.phase = "RESEARCH";
      break;
    case "RESEARCH":
      for (const key of [
        "solver1",
        "solver2",
        "solver3",
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
      const r = s.results.implementor as any;
      if (r.status === "IMPLEMENTATION_BLOCKED")
        fix(s, r.suggestedRoute, r.reason);
      else
        s.phase = s.config.qualityGates.codeReview.enabled
          ? "CODE_REVIEW"
          : afterCodeReview(s);
      break;
    }
    case "CODE_REVIEW": {
      const r = s.results.codeReviewer as any;
      if (r.status === "APPROVED") s.phase = afterCodeReview(s);
      else fix(s, r.status, r.question);
      break;
    }
    case "PENTEST":
      s.phase = "SECURITY_REVIEW";
      break;
    case "SECURITY_REVIEW": {
      const review = s.results.securityReviewer as any,
        pentest = s.results.pentester as any;
      const expected = pentest.findings.map((f: any) => f.id).sort();
      const actual = review.findings.map((f: any) => f.id).sort();
      if (JSON.stringify(expected) !== JSON.stringify(actual)) {
        block(
          s,
          "Security review must classify every pentest finding exactly once",
        );
        break;
      }
      const confirmed = review.findings.filter(
        (f: any) => f.classification === "CONFIRMED",
      );
      if (
        review.findings.some((f: any) => f.classification === "ACCEPTED_RISK")
      ) {
        block(s, "Accepted security risks require explicit user review");
        break;
      }
      if (confirmed.some((f: any) => !f.route)) {
        block(s, "Confirmed findings require a fix route");
        break;
      }
      if (confirmed.length)
        fix(
          s,
          confirmed.some((f: any) => f.route === "FIX_DESIGN")
            ? "FIX_DESIGN"
            : "FIX_LOCAL",
        );
      else s.phase = afterSecurity(s);
      break;
    }
    case "TEST": {
      const r = s.results.tester as any;
      if (
        r.status === "PASS" &&
        r.commands.length &&
        r.commands.every((c: any) => c.exitCode === 0)
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
