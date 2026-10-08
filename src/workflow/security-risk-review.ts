import { createHash } from "node:crypto";
import {
  record,
  type SecurityRiskReview,
  type WorkflowState,
} from "./state.ts";

const legacyBlocker =
  /^Accepted security risks require explicit user review\.?$/i;
const evidenceLimit = 1200;

/** Identity includes the result contents and the host-recorded reviewer attempt. */
export function currentSecurityRiskReview(
  state: WorkflowState,
): Omit<SecurityRiskReview, "status" | "reviewedAt"> | undefined {
  const findings = state.results.securityReviewer?.findings
    .filter((finding) => finding.classification === "ACCEPTED_RISK")
    .map((finding) => ({
      id: finding.id,
      classification: "ACCEPTED_RISK" as const,
      evidence: finding.evidence,
    }))
    .sort((a, b) =>
      a.id === b.id
        ? a.evidence < b.evidence
          ? -1
          : a.evidence > b.evidence
            ? 1
            : 0
        : a.id < b.id
          ? -1
          : 1,
    );
  if (!findings?.length) return undefined;
  const securityReviewerAttempt = state.history.findLast(
    (event) =>
      event.event === "agent_attempt_started" &&
      event.meta?.agent === "securityReviewer",
  )?.meta?.attempt;
  const resultHash = createHash("sha256")
    .update(JSON.stringify(findings))
    .digest("hex");
  return { findings, resultHash, securityReviewerAttempt };
}

export function matchingSecurityRiskReview(state: WorkflowState) {
  const current = currentSecurityRiskReview(state);
  const saved = state.securityRiskReview;
  return !!(
    current &&
    saved &&
    saved.resultHash === current.resultHash &&
    createHash("sha256")
      .update(JSON.stringify(saved.findings))
      .digest("hex") === saved.resultHash &&
    saved.securityReviewerAttempt === current.securityReviewerAttempt
  );
}

export function requestSecurityRiskReview(state: WorkflowState) {
  const current = currentSecurityRiskReview(state);
  if (!current) throw new Error("No accepted security risks to review");
  if (
    !matchingSecurityRiskReview(state) ||
    state.securityRiskReview?.status !== "pending"
  ) {
    state.securityRiskReview = { ...current, status: "pending" };
    record(state, "security_risk_review_requested", "", {
      agent: "securityReviewer",
      attempt: current.securityReviewerAttempt ?? 1,
      count: current.findings.length,
    });
  }
  delete state.blocker;
  delete state.blockerMeta;
  state.phase = "WAITING_USER";
}

export function isLegacySecurityRiskBlock(state: WorkflowState) {
  if (
    state.phase !== "BLOCKED" ||
    state.securityRiskReview ||
    state.results.securityReviewer?.findings.some(
      (finding) => finding.classification === "CONFIRMED",
    ) ||
    !currentSecurityRiskReview(state)
  )
    return false;
  const blocked = state.history.findLast((event) => event.event === "blocked");
  return (
    blocked?.phase === "SECURITY_REVIEW" &&
    legacyBlocker.test(state.blocker ?? "") &&
    legacyBlocker.test(blocked.detail)
  );
}

function boundedEvidenceForQuestion(evidence: string) {
  return evidence.length <= evidenceLimit
    ? evidence
    : `${evidence.slice(0, evidenceLimit)}… [truncated]`;
}

export function securityRiskQuestion(review: SecurityRiskReview) {
  return [
    "Security Reviewer reported accepted risks:",
    ...review.findings.flatMap((finding) => [
      "",
      `[${finding.id}] ACCEPTED_RISK`,
      boundedEvidenceForQuestion(finding.evidence),
    ]),
    "",
    review.findings.length === 1
      ? "Accept this security risk and continue?"
      : "Accept these security risks and continue?",
  ].join("\n");
}
