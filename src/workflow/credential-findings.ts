import { posix } from "node:path";
import type {
  SecretFinding,
  SecretScanResult,
} from "../security/secret-scan.ts";
import { policyPath } from "../agents/path-policy.ts";
import type {
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
    prompt: `File: ${pending.path}\nLine: ${pending.line ?? "unknown"}\nScanner: ${pending.scanner}\nFinding: ${pending.ruleId}\nCode: ${pending.excerpt ?? "[REDACTED]"}\n\nAllow this exact finding to be excluded from the commit credential scan?`,
    options: [
      {
        value: "allow_once",
        label: "Ja",
        description: "Allow this finding for the current commit attempt",
      },
      {
        value: "allow_workflow",
        label: "Ja für diesen Workflow",
        description: "Allow this exact finding for this workflow",
      },
      { value: "deny", label: "Nein", description: "Block the commit" },
    ],
  };
}
