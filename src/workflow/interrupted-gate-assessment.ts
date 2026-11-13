import { inspectExecution } from "./execution-identity.ts";
import { createHash } from "node:crypto";
import type { WorkflowState } from "./state.ts";
import {
  repositorySnapshot,
  compareRepositorySnapshots,
  gateSnapshot,
} from "./git.ts";
import {
  assertWithin,
  isWorkflowContractOperationAllowed,
} from "../agents/permissions.ts";
import {
  classifyPath,
  policyPath,
  isWithinPath,
} from "../agents/path-policy.ts";
import { contractSchema } from "../agents/schemas.ts";

/** Host-observed command brackets establish a candidate origin, not exclusive authorship. */
export async function assessInterruptedGate(
  state: WorkflowState,
  agent: "pentester" | "tester",
  attempt: number,
) {
  const commands = state.commandMutationEvidence.filter(
    (e) => e.agent === agent && e.attempt === attempt,
  );
  const execution = state.executions.find(
    (e) => e.agent === agent && e.attempt === attempt,
  );
  const process = await inspectExecution(execution);
  const base = {
    workflowId: state.id,
    agent,
    attempt,
    baselineHead: state.baseline.head,
    commands,
    processStatus: process.status,
    executionId: execution?.id,
    executionStatus: execution?.status,
    sessionId: execution?.sessionId,
    processReason: process.reason,
    uncertainties: [
      execution
        ? "SDK extensions, remote tools, and processes escaping the recorded process group are outside managed process verification."
        : "Previous subprocess termination cannot be proven: no durable child PID/start identity is available.",
      "Database, external-service, ignored-file and out-of-repository effects are not covered by repository snapshots.",
    ],
  };
  try {
    const current = await repositorySnapshot(state.cwd);
    const snapshot = state.gateRepositorySnapshot;
    const changed = snapshot
      ? compareRepositorySnapshots(snapshot, current, Number.MAX_SAFE_INTEGER)
      : undefined;
    const result = (status: string, eligible: boolean, reason: string) => {
      const assessment = {
        ...base,
        status,
        eligible,
        reason,
        currentHead: current.head,
        snapshotId: current.id,
        changed,
      };
      return {
        ...assessment,
        fingerprint: createHash("sha256")
          .update(
            JSON.stringify({
              assessment,
              hashes: state.gateHashes,
              history: state.history,
              manualRetry: state.manualRetry,
              results: state.results,
              approvals: state.workflowApprovedContractPaths,
              config: state.config,
              inFlight: state.inFlight,
              runtimeFileApprovals: state.runtimeFileApprovals,
            }),
          )
          .digest("hex"),
      };
    };
    if (
      process.status === "ACTIVE" ||
      (execution && process.status === "UNKNOWN")
    )
      return result(
        "PROCESS_UNRESOLVED",
        false,
        `${process.status}: ${process.reason} Stop the owning Pi-Team run normally or establish termination through supported process inspection; approval cannot override this condition.`,
      );
    if (!snapshot || !state.gateHashes)
      return result(
        "EVIDENCE_MISSING",
        false,
        "Missing pre-attempt repository snapshot or gate hashes; inspect repository and abort.",
      );
    if (current.head !== state.baseline.head || current.head !== snapshot.head)
      return result(
        "HEAD_CHANGED",
        false,
        "Repository changed: HEAD differs from baseline or pre-gate HEAD.",
      );
    const start = state.history.findLast(
      (e) =>
        (e.event === "agent_attempt_started" ||
          e.event === "execution_reserved") &&
        e.meta?.agent === agent &&
        e.meta.attempt === attempt,
    );
    if (
      !start ||
      snapshot.capturedAt > start.at ||
      !Object.keys(state.gateHashes).length
    )
      return result(
        "EVIDENCE_MISSING",
        false,
        "Missing pre-attempt snapshot chronology or gate hashes.",
      );
    const hashes = await gateSnapshot(state);
    if (current.id === snapshot.id)
      return JSON.stringify(hashes) === JSON.stringify(state.gateHashes)
        ? result(
            "UNCHANGED",
            true,
            "Repository matches pre-gate snapshot and gate hashes.",
          )
        : result(
            "ATTRIBUTION_AMBIGUOUS",
            false,
            "Repository changed: gate hashes disagree with the repository snapshot.",
          );
    const paths = [
      ...new Set([
        ...(changed?.added ?? []),
        ...(changed?.modified ?? []),
        ...(changed?.deleted ?? []),
      ]),
    ];
    if (
      Object.keys({ ...state.gateHashes, ...hashes }).some(
        (path) =>
          hashes[path] !== state.gateHashes?.[path] && !paths.includes(path),
      )
    )
      return result(
        "ATTRIBUTION_AMBIGUOUS",
        false,
        "Repository changed: gate hash drift is not covered by command snapshots.",
      );
    const contract = contractSchema.safeParse(state.results.reviewer);
    for (const path of paths) {
      await assertWithin(state.cwd, path);
      const entry = current.entries.find(
        (e) => policyPath(e.path) === policyPath(path),
      );
      const operation =
        entry?.hash === "DELETED"
          ? "delete"
          : entry?.untracked
            ? "create"
            : "modify";
      if (
        agent === "tester" &&
        (!state.config.tester.mayModifyTests ||
          operation === "delete" ||
          !state.config.tester.testPaths.some((prefix) =>
            isWithinPath(path, prefix),
          ))
      )
        return result(
          "PROTECTED_PATH_VIOLATION",
          false,
          `Repository changed: Tester mutation policy prohibits ${path}.`,
        );
      if (
        classifyPath(path) !== "normal" ||
        !contract.success ||
        !isWorkflowContractOperationAllowed(
          contract.data,
          state.workflowApprovedContractPaths,
          path,
          operation,
        )
      )
        return result(
          "PROTECTED_PATH_VIOLATION",
          false,
          `Repository changed: protected or unauthorized path ${path}.`,
        );
    }
    // Every transition must have one exact, unambiguous host bracket. A path list or timestamp alone is insufficient.
    let cursor = snapshot.id;
    const used = new Set<string>();
    while (cursor !== current.id) {
      const matches = commands.filter(
        (e) => e.beforeSnapshotId === cursor && e.afterSnapshotId !== cursor,
      );
      if (
        matches.length !== 1 ||
        matches[0].attribution !== "OBSERVED" ||
        used.has(matches[0].executionId)
      )
        return result(
          "ATTRIBUTION_AMBIGUOUS",
          false,
          "Repository changed: no unique complete command-mutation chain connects the pre-attempt snapshot to current content.",
        );
      const evidence = matches[0];
      if (evidence.observedAt < start.at)
        return result(
          "ATTRIBUTION_AMBIGUOUS",
          false,
          "Repository changed: command evidence predates interrupted attempt.",
        );
      used.add(evidence.executionId);
      if (
        evidence.phase !== (agent === "tester" ? "TEST" : "PENTEST") ||
        evidence.risk === "UNKNOWN" ||
        evidence.risk === "DEPENDENCY_MUTATION"
      )
        return result(
          "ATTRIBUTION_AMBIGUOUS",
          false,
          "Repository changed: mutation risk or phase does not permit attribution.",
        );
      cursor = evidence.afterSnapshotId;
    }
    const observedPaths = new Set(
      commands
        .filter((e) => used.has(e.executionId))
        .flatMap((e) => [
          ...e.addedPaths,
          ...e.modifiedPaths,
          ...e.deletedPaths,
        ])
        .map(policyPath),
    );
    if (
      !paths.length ||
      paths.some((p) => !observedPaths.has(policyPath(p))) ||
      changed?.renamed.length ||
      changed?.staged.length
    )
      return result(
        "ATTRIBUTION_AMBIGUOUS",
        false,
        "Repository changed: path, rename or index evidence is incomplete.",
      );
    return result(
      "ATTRIBUTABLE_TO_INTERRUPTED_ATTEMPT",
      true,
      "Repository changes match host-observed command brackets. Review possible concurrent/external effects; preserve changes and rerun CODE_REVIEW before the interrupted gate.",
    );
  } catch (error) {
    return {
      ...base,
      status: "EVIDENCE_MISSING",
      eligible: false,
      reason: `Repository assessment unavailable (not a verified integrity failure): ${error instanceof Error ? error.message : String(error)}`,
      fingerprint: "unavailable",
    };
  }
}
export type InterruptedGateAssessment = Awaited<
  ReturnType<typeof assessInterruptedGate>
>;
export function formatInterruptedGateAssessment(a: InterruptedGateAssessment) {
  return [
    `Workflow: ${a.workflowId}`,
    `Agent: ${a.agent}; interrupted attempt: ${a.attempt}`,
    `Baseline HEAD: ${a.baselineHead}`,
    `Current HEAD: ${"currentHead" in a ? a.currentHead : "unavailable"}`,
    `Repository integrity: ${a.status}`,
    a.reason,
    `Changed files: ${"changed" in a ? JSON.stringify(a.changed) : "unavailable"}`,
    `Recorded command mutations: ${a.commands.length} (execution IDs: ${a.commands.map((e) => e.executionId).join(", ") || "none"})`,
    `Execution: ${a.executionId ?? "legacy / unavailable"}; lifecycle: ${a.executionStatus ?? "UNKNOWN"}; SDK session: ${a.sessionId ?? "unavailable"}`,
    `Previous process: ${a.processStatus}: ${a.processReason}`,
    ...a.uncertainties,
  ].join("\n");
}
