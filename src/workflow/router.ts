import { block, record, type WorkflowState, type Phase } from "./state.ts";
import { pentestSchema, type Role } from "../agents/schemas.ts";
import { enforcePentestPolicy } from "./pentest-policy.ts";
import {
  classifyPentestUnavailability,
  completedWithAcceptedLimitations,
  hasCurrentIgnoredPentestDecision,
  isAuthorizedPentestSkip,
  matchingIgnoredPentestScope,
  pentestUnavailabilityRequest,
} from "./pentest-unavailability.ts";
import { getActiveSolverIds } from "../config/solvers.ts";
import {
  currentSecurityRiskReview,
  matchingSecurityRiskReview,
  requestSecurityRiskReview,
} from "./security-risk-review.ts";
import {
  assessTesterEvidence,
  type ValidationOutcome,
} from "./validation-obligations.ts";

function validationConflictMessage(
  status: "PASS" | "FAIL",
  outcome: ValidationOutcome,
  kind: "remediation" | "blocked",
): string {
  const requirement =
    outcome.applicability === "OPTIONAL"
      ? `Verified ${outcome.validationType.toLowerCase()} failure`
      : `Required ${outcome.validationType.toLowerCase()} validation`;
  const consequence =
    kind === "remediation"
      ? "This verified failure requires remediation before testing can pass."
      : "The required validation has not been successfully reverified.";
  return [
    "Tester result conflicts with verified validation evidence.",
    "",
    "Source:",
    requirement,
    "",
    "Command:",
    outcome.id,
    "",
    "Outcome:",
    outcome.outcome,
    "",
    `The Tester reported ${status}. ${consequence}`,
  ].join("\n");
}

function missingRemediationMessage(outcome: ValidationOutcome): string {
  return [
    "Required remediation evidence is missing.",
    "",
    "Source:",
    `${outcome.applicability === "OPTIONAL" ? "Verified" : "Required"} ${outcome.validationType} failure`,
    "",
    "Command:",
    outcome.id,
    "",
    "Expected:",
    "The Tester result must identify this current verified failure and route it for remediation.",
  ].join("\n");
}

function unsupportedRemediationMessage(id: string): string {
  return [
    "Tester remediation evidence is unsupported.",
    "",
    "Command:",
    id,
    "",
    "Expected:",
    "failedAreas must reference current verified failures that require remediation.",
  ].join("\n");
}
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
  delete s.pentestUnavailabilityReview;
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
  delete s.gateRepositorySnapshot;
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
      delete s.gateRepositorySnapshot;
      delete s.securityRiskReview;
      delete s.pentestUnavailabilityReview;
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
      if (r.status === "IMPLEMENTATION_BLOCKED") {
        const attemptStart = s.history.findLastIndex(
          (event) =>
            event.event === "agent_attempt_started" &&
            event.meta?.agent === "implementor",
        );
        const hostFailure = s.history
          .slice(Math.max(0, attemptStart))
          .findLast(
            (event) =>
              [
                "host_contract_authorization_blocked",
                "contract_path_approval_denied",
                "file_access_approval_denied",
              ].includes(event.event) ||
              (event.event === "command_approval_decided" &&
                /\bdeny\b/.test(event.detail)),
          );
        const technical =
          hostFailure ||
          [
            "CONTRACT_AUTHORIZATION_BLOCKED",
            "RUNTIME_PERMISSION_BLOCKED",
            "TOOL_EXECUTION_BLOCKED",
          ].includes(r.blockerCategory ?? "");
        const ambiguousRequirementRoute =
          r.suggestedRoute === "FIX_REQUIREMENTS" &&
          r.blockerCategory !== "REQUIREMENT_BLOCKED";
        if (technical || ambiguousRequirementRoute) {
          record(
            s,
            "IMPLEMENTATION_TECHNICAL_BLOCKED",
            hostFailure?.detail ?? r.reason,
          );
          s.pendingApproval = {
            kind: "technicalRecovery",
            title: "Implementation blocked",
            prompt: `Agent: Implementor\n\nReason:\n${r.reason}${hostFailure ? `\n\nHost evidence:\n${hostFailure.detail}` : ""}\n\nChoose a targeted recovery action.`,
            options: [
              {
                value: "retry_implementor",
                label: "Retry Implementor",
                description:
                  "Keep the Contract and partial files, then retry only implementation",
              },
              {
                value: "revise_requirements",
                label: "Revise requirements",
                description:
                  "Provide requirement clarification and restart the design cycle",
              },
              {
                value: "abort",
                label: "Abort workflow",
                description: "Stop without reverting repository files",
              },
            ],
          };
          s.resumePhase = "IMPLEMENT";
          s.phase = "WAITING_USER";
        } else fix(s, r.suggestedRoute, r.reason);
      } else
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
      let result = enforcePentestPolicy(
        s,
        pentestSchema.parse(s.results.pentester),
      );
      if (
        ["PASS", "FINDINGS"].includes(result.status) &&
        hasCurrentIgnoredPentestDecision(s)
      )
        result = completedWithAcceptedLimitations(s, result);
      s.results.pentester = result;
      if (result.status === "PENTEST_UNAVAILABLE") {
        const classification = classifyPentestUnavailability(s, result);
        if (classification.kind === "required") {
          record(
            s,
            "pentest_unavailable_required_capability",
            JSON.stringify({ capabilityIds: classification.capabilityIds }),
          );
          fix(
            s,
            "FIX_LOCAL",
            `Required implementation capabilities are unavailable: ${classification.capabilityIds.join(", ")}`,
          );
          break;
        }
        if (classification.kind === "uncertain") {
          record(
            s,
            "pentest_unavailable_contract_uncertain",
            JSON.stringify({ capabilityIds: classification.capabilityIds }),
          );
          s.pentestCycle = Math.max(0, s.pentestCycle - 1);
          s.pendingApproval = {
            kind: "pentestContractClarification",
            title: "Clarify unavailable Pentest capability",
            prompt: `The current Implementation Contract does not explicitly classify these unavailable capabilities: ${classification.capabilityIds.join(", ")}. Confirm whether their absence is an implementation defect before Pi-Team offers any Pentest waiver. This clarification applies only to this workflow and does not rewrite project configuration.`,
            options: [
              {
                value: "required",
                label: "Required capability",
                description:
                  "Treat the missing capability as an implementation defect and route normal remediation",
              },
              {
                value: "not_required",
                label: "Not required by the Contract",
                description:
                  "Confirm the interface is optional or intentionally absent, then review the Pentest coverage decision",
              },
              {
                value: "stop",
                label: "Stop workflow",
                description:
                  "Stop without running downstream agents; preserve state, evidence, and repository changes",
              },
            ],
          };
          s.resumePhase = "PENTEST";
          s.phase = "WAITING_USER";
          break;
        }
        if (matchingIgnoredPentestScope(s, result)) {
          result = completedWithAcceptedLimitations(s, result);
          s.results.pentester = result;
          record(
            s,
            "pentest_limitation_finalized",
            "All feasible checks are complete; the previously accepted limitation remains unverified",
          );
          s.phase = "SECURITY_REVIEW";
          break;
        }
        s.pentestCycle = Math.max(0, s.pentestCycle - 1);
        const attempt =
          s.history.findLast(
            (event) =>
              event.event === "agent_attempt_started" &&
              event.meta?.agent === "pentester",
          )?.meta?.attempt ?? 1;
        s.pendingApproval = pentestUnavailabilityRequest(s, result, attempt);
        s.resumePhase = "PENTEST";
        s.phase = "WAITING_USER";
      } else if (result.status === "BLOCKED") {
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
      } else if (result.status === "PENTEST_SKIPPED_BY_USER") {
        if (!isAuthorizedPentestSkip(s, result))
          block(
            s,
            "Pentest skip result lacks matching workflow-level user authorization",
          );
        else s.phase = "SECURITY_REVIEW";
      } else if (result.status === "COMPLETED_WITH_LIMITATIONS") {
        if (!matchingIgnoredPentestScope(s, result))
          block(
            s,
            "Pentest completion with limitations lacks a matching user decision",
          );
        else s.phase = "SECURITY_REVIEW";
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
      const attempt = s.history.findLast(
        (event) =>
          event.event === "agent_attempt_started" &&
          event.meta?.agent === "tester",
      )?.meta?.attempt;
      const blockTester = (reason: string) =>
        block(
          s,
          reason,
          attempt
            ? {
                kind: "quality_gate_blocked",
                sourceAgent: "tester",
                sourcePhase: "TEST",
                sourceAttempt: attempt,
              }
            : undefined,
        );
      if (r.status === "BLOCKED") {
        blockTester(
          `Testing blocked: ${r.reason ?? "Required validation could not run"}`,
        );
        break;
      }
      const outcomes = r.validationOutcomes;
      const assessment = outcomes?.length
        ? assessTesterEvidence(outcomes)
        : undefined;
      if (outcomes && !outcomes.length) {
        blockTester(
          "Tester result contains no host-verified validation outcomes. Run the required validations again on the current repository state.",
        );
        break;
      }
      if (assessment?.malformed.length) {
        const malformed = assessment.malformed[0];
        blockTester(
          [
            "Tester result contains malformed validation evidence.",
            "",
            "Command:",
            malformed.id,
            "",
            "Problem:",
            malformed.reason,
          ].join("\n"),
        );
        break;
      }
      if (r.status === "PASS") {
        const blocked = assessment?.blocked[0];
        if (blocked) {
          blockTester(validationConflictMessage("PASS", blocked, "blocked"));
          break;
        }
        const remediation = assessment?.remediation[0];
        if (remediation) {
          blockTester(
            validationConflictMessage("PASS", remediation, "remediation"),
          );
          break;
        }
        const legacyPass =
          !assessment &&
          r.commands.length > 0 &&
          r.commands.every((command) => command.exitCode === 0);
        if (
          (assessment || legacyPass) &&
          !r.failedAreas.length &&
          !r.classification
        ) {
          s.phase = afterTests(s);
          break;
        }
        blockTester(
          r.failedAreas[0]
            ? unsupportedRemediationMessage(r.failedAreas[0])
            : "Tester PASS is missing current successful host-verified validation evidence.",
        );
        break;
      }
      if (r.status === "FAIL" && assessment) {
        const blocked = assessment.blocked[0];
        if (blocked) {
          blockTester(validationConflictMessage("FAIL", blocked, "blocked"));
          break;
        }
        const remediationIds = new Set(
          assessment.remediation.map((outcome) => outcome.id),
        );
        const unsupported = r.failedAreas.find((id) => !remediationIds.has(id));
        if (unsupported) {
          blockTester(unsupportedRemediationMessage(unsupported));
          break;
        }
        const missing = assessment.remediation.find(
          (outcome) => !r.failedAreas.includes(outcome.id),
        );
        if (missing) {
          blockTester(missingRemediationMessage(missing));
          break;
        }
        if (!r.classification || !r.failedAreas.length) {
          const source = assessment.remediation[0];
          blockTester(
            source
              ? missingRemediationMessage(source)
              : "Tester reported FAIL without a current verified failure that requires remediation.",
          );
          break;
        }
        const previous = s.results.previous_tester;
        const unchangedRecoverableFailure =
          r.classification === "FIX_LOCAL" &&
          r.validationOutcomes?.some((outcome) =>
            ["STATIC_FORMAT_FAILURE", "STATIC_ANALYSIS_FAILURE"].includes(
              outcome.outcome,
            ),
          ) &&
          r.failureFingerprint !== undefined &&
          previous?.status === "FAIL" &&
          previous.failureFingerprint === r.failureFingerprint;
        if (unchangedRecoverableFailure) {
          record(
            s,
            "tester_static_failure_unchanged",
            "Static validation reported the same findings on the same repository state after local remediation",
          );
          blockTester(
            "Testing blocked: static validation reported the same findings after a local fix attempt, and the repository state did not change. Inspect the prior Implementor result, any denied path approvals, and the validator diagnostics before retrying.",
          );
        } else fix(s, r.classification);
        break;
      }
      if (
        r.status === "FAIL" &&
        r.classification &&
        r.failedAreas.length &&
        r.failedAreas.every((id) =>
          r.commands.some((c) => c.id === id && c.exitCode !== 0),
        )
      ) {
        const previous = s.results.previous_tester;
        const unchangedRecoverableFailure =
          r.classification === "FIX_LOCAL" &&
          r.validationOutcomes?.some((outcome) =>
            ["STATIC_FORMAT_FAILURE", "STATIC_ANALYSIS_FAILURE"].includes(
              outcome.outcome,
            ),
          ) &&
          r.failureFingerprint !== undefined &&
          previous?.status === "FAIL" &&
          previous.failureFingerprint === r.failureFingerprint;
        if (unchangedRecoverableFailure) {
          record(
            s,
            "tester_static_failure_unchanged",
            "Static validation reported the same findings on the same repository state after local remediation",
          );
          blockTester(
            "Testing blocked: static validation reported the same findings after a local fix attempt, and the repository state did not change. Inspect the prior Implementor result, any denied path approvals, and the validator diagnostics before retrying.",
          );
        } else fix(s, r.classification);
      } else
        blockTester(
          "Tester result is inconsistent with its current host-verified validation evidence.",
        );
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
