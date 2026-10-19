import { posix } from "node:path";
import type {
  SecretFinding,
  SecretScanResult,
} from "../security/secret-scan.ts";
import { policyPath } from "../agents/path-policy.ts";
import type {
  CredentialFindingApproval,
  CredentialFindingIdentity,
  WorkflowState,
  ApprovalRequest,
} from "./state.ts";

export function credentialIdentity(
  scan: SecretScanResult,
  finding: SecretFinding,
): CredentialFindingIdentity {
  policyPath(finding.path);
  return {
    scanner: scan.scanner,
    ruleId: finding.ruleId,
    path: posix.normalize(finding.path.normalize("NFC").replace(/\\/g, "/")),
    fileSha256: finding.fileSha256,
    findingFingerprint: finding.findingFingerprint,
  };
}

export function sameCredentialFinding(
  a: CredentialFindingIdentity,
  b: CredentialFindingIdentity,
): boolean {
  return (
    a.scanner === b.scanner &&
    a.ruleId === b.ruleId &&
    a.path === b.path &&
    a.fileSha256 === b.fileSha256 &&
    a.findingFingerprint === b.findingFingerprint
  );
}

export type CredentialApprovalMatch =
  | "one_shot_exact_finding"
  | "workflow_exact_finding"
  | "workflow_file_finding_type"
  | "workflow_finding_type";

function approvalScope(
  approval: CredentialFindingApproval,
): Exclude<CredentialApprovalMatch, "one_shot_exact_finding"> {
  return "scope" in approval ? approval.scope : "workflow_exact_finding";
}

export function credentialApprovalMatches(
  approval: CredentialFindingApproval,
  finding: CredentialFindingIdentity,
): boolean {
  if (
    approval.scanner !== finding.scanner ||
    approval.ruleId !== finding.ruleId
  )
    return false;
  switch (approvalScope(approval)) {
    case "workflow_exact_finding":
      return sameCredentialFinding(
        approval as CredentialFindingIdentity,
        finding,
      );
    case "workflow_file_finding_type":
      return "path" in approval && approval.path === finding.path;
    case "workflow_finding_type":
      return true;
  }
}

/** Centralized precedence for all credential approval scopes. */
export function matchingCredentialApproval(
  approvals: readonly CredentialFindingApproval[],
  oneShot: readonly CredentialFindingIdentity[],
  finding: CredentialFindingIdentity,
): CredentialApprovalMatch | undefined {
  if (oneShot.some((approved) => sameCredentialFinding(approved, finding)))
    return "one_shot_exact_finding";
  for (const scope of [
    "workflow_exact_finding",
    "workflow_file_finding_type",
    "workflow_finding_type",
  ] as const)
    if (
      approvals.some(
        (approval) =>
          approvalScope(approval) === scope &&
          credentialApprovalMatches(approval, finding),
      )
    )
      return scope;
  return undefined;
}

export function sameCredentialApproval(
  a: CredentialFindingApproval,
  b: CredentialFindingApproval,
): boolean {
  const scope = approvalScope(a);
  if (scope !== approvalScope(b)) return false;
  if (a.scanner !== b.scanner || a.ruleId !== b.ruleId) return false;
  if (scope === "workflow_finding_type") return true;
  if (scope === "workflow_file_finding_type")
    return "path" in a && "path" in b && a.path === b.path;
  return sameCredentialFinding(
    a as CredentialFindingIdentity,
    b as CredentialFindingIdentity,
  );
}

export class CredentialApprovalRequired extends Error {
  constructor(
    readonly identity: CredentialFindingIdentity,
    readonly line?: number,
    readonly excerpt?: string,
  ) {
    super(
      `Commit is waiting for user approval of a potential credential finding in ${identity.path}${line ? `:${line}` : ""}`,
    );
  }
}

export function credentialFindingPrompt(
  pending: NonNullable<WorkflowState["pendingCredentialFinding"]>,
): ApprovalRequest {
  return {
    kind: "credentialFinding",
    title: "Potential credential detected",
    prompt: `File: ${pending.path}\nLine: ${pending.line ?? "unknown"}\nScanner: ${pending.scanner}\nFinding: ${pending.ruleId}\nCode: ${pending.excerpt ?? "[REDACTED]"}\n\nWhat do you want to do?`,
    options: [
      {
        value: "allow_once",
        label: "Allow once",
        description: "Allow this exact finding for the current commit attempt",
      },
      {
        value: "allow_workflow",
        label: "Allow for this workflow",
        description: "Allow this exact finding for this workflow",
      },
      {
        value: "allow_file_finding_type",
        label: `Allow all findings of type ${pending.ruleId} in this file`,
        description: `Allow this finding type in ${pending.path} for this workflow`,
      },
      {
        value: "allow_workflow_finding_type",
        label: `Allow all findings of type ${pending.ruleId} for this workflow`,
        description:
          "Allow this finding type in authorized files for this workflow",
      },
      { value: "deny", label: "Deny", description: "Block the commit" },
    ],
  };
}
