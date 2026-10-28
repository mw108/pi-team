import type { ResultByRole } from "../agents/schemas.ts";

export type ValidationOutcome = NonNullable<
  ResultByRole["tester"]["validationOutcomes"]
>[number];

export type ValidationEvidenceDisposition =
  | "SATISFIED"
  | "AUDIT_ONLY"
  | "NOT_APPLICABLE"
  | "REMEDIATION_REQUIRED"
  | "VERIFICATION_BLOCKED";

const verifiedFailureOutcomes = new Set<ValidationOutcome["outcome"]>([
  "TEST_FAILURE",
  "STATIC_FORMAT_FAILURE",
  "STATIC_ANALYSIS_FAILURE",
  "BUILD_FAILURE",
  "DIAGNOSTIC_FAILURE",
]);

const incompleteVerificationOutcomes = new Set<ValidationOutcome["outcome"]>([
  "TOOL_UNAVAILABLE",
  "INVOCATION_ERROR",
  "INFRASTRUCTURE_ERROR",
  "INDETERMINATE",
]);

/**
 * Interpret persisted validation evidence without falling back to raw exit
 * codes. Applicability controls gate obligations; a trustworthy classified
 * failure remains remediation evidence even when it came from extra testing.
 */
export function validationEvidenceDisposition(
  evidence: Pick<
    ValidationOutcome,
    "outcome" | "validationType" | "applicability" | "supersededBy"
  >,
): ValidationEvidenceDisposition {
  if (evidence.supersededBy) return "AUDIT_ONLY";
  const applicability = evidence.applicability ?? "REQUIRED";
  if (applicability === "AMBIGUOUS") return "VERIFICATION_BLOCKED";
  if (verifiedFailureOutcomes.has(evidence.outcome))
    return "REMEDIATION_REQUIRED";
  if (applicability === "NOT_APPLICABLE") return "NOT_APPLICABLE";
  if (evidence.outcome === "NOT_APPLICABLE")
    return applicability === "REQUIRED"
      ? "VERIFICATION_BLOCKED"
      : "NOT_APPLICABLE";
  if (applicability === "OPTIONAL") return "AUDIT_ONLY";
  if (evidence.outcome === "PASS") return "SATISFIED";
  if (incompleteVerificationOutcomes.has(evidence.outcome))
    return "VERIFICATION_BLOCKED";
  return "VERIFICATION_BLOCKED";
}

export function validationOutcomeParticipatesInGate(
  evidence: Pick<
    ValidationOutcome,
    "outcome" | "validationType" | "applicability" | "supersededBy"
  >,
): boolean {
  return !["AUDIT_ONLY", "NOT_APPLICABLE"].includes(
    validationEvidenceDisposition(evidence),
  );
}

export type TesterEvidenceAssessment = {
  remediation: ValidationOutcome[];
  blocked: ValidationOutcome[];
  malformed: { id: string; reason: string }[];
};

function malformedOutcome(
  outcome: ValidationOutcome,
): { id: string; reason: string } | undefined {
  const equivalenceFields = [
    outcome.requiredCommandId,
    outcome.satisfiedByCommandId,
    outcome.matchType,
    outcome.matchReasonCode,
  ];
  if (
    outcome.matchType === "VERIFIED_EQUIVALENT" &&
    (outcome.outcome !== "PASS" ||
      !outcome.requiredCommandId ||
      !outcome.satisfiedByCommandId ||
      !outcome.matchReasonCode)
  )
    return {
      id: outcome.id,
      reason:
        "Verified-equivalent evidence requires a passing outcome, required and satisfying command identities, and a match reason.",
    };
  if (
    equivalenceFields.some((field) => field !== undefined) &&
    !outcome.matchType
  )
    return {
      id: outcome.id,
      reason: "Validation match metadata is incomplete.",
    };
  if (
    outcome.requiredCommandId !== undefined &&
    outcome.requiredCommandId !== outcome.id
  )
    return {
      id: outcome.id,
      reason:
        "The validation outcome identity does not match its required command identity.",
    };
  return undefined;
}

export function assessTesterEvidence(
  outcomes: ValidationOutcome[],
): TesterEvidenceAssessment {
  const assessment: TesterEvidenceAssessment = {
    remediation: [],
    blocked: [],
    malformed: [],
  };
  for (const outcome of outcomes) {
    const malformed = malformedOutcome(outcome);
    if (malformed) {
      assessment.malformed.push(malformed);
      continue;
    }
    const disposition = validationEvidenceDisposition(outcome);
    if (disposition === "REMEDIATION_REQUIRED")
      assessment.remediation.push(outcome);
    else if (disposition === "VERIFICATION_BLOCKED")
      assessment.blocked.push(outcome);
  }
  return assessment;
}
