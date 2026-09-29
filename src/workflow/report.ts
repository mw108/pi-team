import { completionReportSchema } from "../agents/schemas.ts";
import { dirtyPaths } from "./git.ts";
import type { WorkflowState } from "./state.ts";

export type CompletionReport = ReturnType<typeof completionReportSchema.parse>;
export interface ValidationCommandResult {
  id: string;
  executable?: string;
  args?: string[];
  purpose?: string;
  success: boolean;
  exitCode: number;
  timedOut: boolean;
  durationMs?: number;
}
export interface CompletionReportInput {
  workflowId: string;
  task: string;
  requirements: string[];
  outcome: "done";
  implementation: {
    contractSummary?: string;
    implementedSummary?: string;
    changedFiles: string[];
  };
  validation: CompletionReport["validation"];
  validationCommands: ValidationCommandResult[];
  commit: CompletionReport["commit"];
  cycles: { design: number; localFix: number; pentest: number };
  warnings: string[];
  unresolvedIssues: string[];
  limitations: string[];
}

const unique = (values: string[]) => [...new Set(values)].sort();
export async function buildCompletionReportInput(
  s: WorkflowState,
  historical = false,
): Promise<CompletionReportInput> {
  const implementation = s.results.implementor as any;
  const contract = s.results.reviewer as any;
  const current =
    s.commit || historical ? [] : await dirtyPaths(s.cwd).catch(() => []);
  const claimed = new Set(
    implementation?.status === "IMPLEMENTED" ? implementation.changedFiles : [],
  );
  const changedFiles = unique(
    s.commit?.files ??
      current.filter(
        (path) =>
          !path.startsWith(".pi/team/") &&
          (!s.baseline.dirtyPaths.includes(path) || claimed.has(path)),
      ),
  );
  const validation: CompletionReport["validation"] = [];
  const gate = (
    label: string,
    enabled: boolean,
    result: unknown,
    passed: boolean,
    detail?: string,
  ) => {
    validation.push({
      label,
      status: !enabled
        ? "disabled"
        : !result
          ? "not-run"
          : passed
            ? "passed"
            : "failed",
      ...(detail ? { detail } : {}),
    });
  };
  const review = s.results.codeReviewer as any;
  gate(
    "Code review",
    s.config.qualityGates.codeReview.enabled,
    review,
    review?.status === "APPROVED",
  );
  const pentest = s.results.pentester as any;
  gate(
    "Pentest",
    s.config.qualityGates.pentest.enabled,
    pentest,
    !!pentest && pentest.findings.length === 0,
  );
  const security = s.results.securityReviewer as any;
  if (
    s.config.qualityGates.pentest.enabled &&
    pentest?.findings.length &&
    security?.findings.every((finding: any) =>
      ["FALSE_POSITIVE", "ENVIRONMENT_ARTIFACT"].includes(
        finding.classification,
      ),
    )
  ) {
    const pentestGate = validation.find((entry) => entry.label === "Pentest")!;
    pentestGate.status = "warning";
    pentestGate.detail = `${pentest.findings.length} finding(s) classified by security review`;
  }
  gate(
    "Security review",
    s.config.qualityGates.pentest.enabled,
    security,
    !!security &&
      security.findings.every(
        (f: any) =>
          f.classification !== "CONFIRMED" &&
          f.classification !== "ACCEPTED_RISK",
      ),
  );
  const tester = s.results.tester as any;
  gate(
    "Testing",
    s.config.qualityGates.testing.enabled,
    tester,
    tester?.status === "PASS",
  );
  const validationCommands: ValidationCommandResult[] = [];
  for (const result of tester?.commands ?? []) {
    const command = [...s.approvedCommands, ...s.config.commands].find(
      (c) => c.id === result.id,
    );
    validationCommands.push({
      id: result.id,
      ...(command
        ? {
            executable: command.executable,
            args: command.args,
            purpose: command.purpose,
          }
        : {}),
      success: result.exitCode === 0 && !result.timedOut,
      exitCode: result.exitCode,
      timedOut: !!result.timedOut,
      ...(typeof result.durationMs === "number"
        ? { durationMs: result.durationMs }
        : {}),
    });
    validation.push({
      label: command
        ? [command.executable, ...command.args].join(" ")
        : `Command ${result.id}`,
      status: result.exitCode === 0 && !result.timedOut ? "passed" : "failed",
      detail: `exit ${result.exitCode}${result.timedOut ? "; timed out" : ""}`,
    });
  }
  const unresolvedIssues = unique([
    ...(review?.findings ?? []).map((f: any) => `${f.severity}: ${f.problem}`),
    ...(pentest?.findings ?? [])
      .filter(
        (f: any) =>
          security?.findings?.find((r: any) => r.id === f.id)
            ?.classification === "ACCEPTED_RISK",
      )
      .map((f: any) => `${f.severity}: ${f.title}`),
  ]);
  const warnings = unique([
    ...validation
      .filter(
        (v) =>
          v.status === "disabled" ||
          v.status === "not-run" ||
          v.status === "failed" ||
          v.status === "warning",
      )
      .map((v) => `${v.label}: ${v.status}`),
    ...(s.reportFailure ? [`Narrative report failed: ${s.reportFailure}`] : []),
  ]);
  const commitResult = s.results.commitAgent as any;
  return {
    workflowId: s.id,
    task: s.task,
    requirements: s.requirements,
    outcome: "done",
    implementation: {
      contractSummary: contract?.goal,
      implementedSummary:
        implementation?.status === "IMPLEMENTED"
          ? implementation.summary
          : undefined,
      changedFiles,
    },
    validation,
    validationCommands,
    commit: {
      created: !!s.commit,
      ...(s.commit
        ? { hash: s.commit.hash, message: commitResult?.message }
        : {
            detail: s.config.qualityGates.commit.enabled
              ? (s.blocker ?? "No commit was recorded.")
              : "Disabled by configuration.",
          }),
    },
    cycles: {
      design: s.fullCycle,
      localFix: s.localFixCycle,
      pentest: s.pentestCycle,
    },
    warnings,
    unresolvedIssues,
    limitations: unique([
      ...(pentest?.limitations ?? []),
      ...(historical && !s.commit
        ? [
            "Changed paths are unavailable in this older workflow state without a recorded commit.",
          ]
        : []),
    ]),
  };
}

function supportedSummary(input: CompletionReportInput, candidate?: string) {
  if (!candidate) return undefined;
  const mentionedFiles =
    candidate.match(
      /\b[A-Za-z0-9_./-]+\.(?:tsx?|jsx?|mjs|cjs|py|rs|go|java|php|vue|css|scss|html|json|ya?ml|md)\b/g,
    ) ?? [];
  const knownFiles = new Set(
    input.implementation.changedFiles.flatMap((path) => [
      path,
      path.split("/").at(-1)!,
    ]),
  );
  return mentionedFiles.every((path) => knownFiles.has(path))
    ? candidate
    : undefined;
}

export function fallbackReport(input: CompletionReportInput): CompletionReport {
  const implementedSummary = supportedSummary(
    input,
    input.implementation.implementedSummary,
  );
  return {
    summary: implementedSummary ?? `Workflow completed: ${input.task}`,
    implemented: implementedSummary ? [implementedSummary] : [],
    changedFiles: input.implementation.changedFiles,
    validation: input.validation,
    notes: [...input.warnings, ...input.limitations],
    unresolvedIssues: input.unresolvedIssues,
    commit: input.commit,
  };
}

export function finalizeReport(
  input: CompletionReportInput,
  candidate: unknown,
): CompletionReport {
  const prose = completionReportSchema.parse(candidate);
  const implementedSummary = supportedSummary(
    input,
    input.implementation.implementedSummary,
  );
  const summary =
    supportedSummary(input, prose.summary) ??
    implementedSummary ??
    `Workflow completed: ${input.task}`;
  return completionReportSchema.parse({
    ...prose,
    summary,
    implemented: implementedSummary ? [implementedSummary] : [],
    changedFiles: input.implementation.changedFiles,
    validation: input.validation,
    unresolvedIssues: input.unresolvedIssues,
    commit: input.commit,
    notes: unique([...input.warnings, ...input.limitations]),
  });
}

export function renderReport(report: CompletionReport, failure?: string) {
  const lines = ["Team DONE", "", "Summary", report.summary];
  if (failure)
    lines.push("", "Report generation", `Narrative report failed: ${failure}`);
  const section = (title: string, items: string[]) => {
    lines.push(
      "",
      title,
      ...(items.length ? items.map((item) => `- ${item}`) : ["None."]),
    );
  };
  section("Implemented", report.implemented);
  section("Changed files", report.changedFiles);
  section(
    "Validation",
    report.validation.map(
      (v) =>
        `${v.status === "passed" ? "✓" : "⚠"} ${v.label}: ${v.status}${v.detail ? ` (${v.detail})` : ""}`,
    ),
  );
  lines.push(
    "",
    "Commit",
    report.commit.created
      ? `${report.commit.hash ?? "Hash unavailable"}${report.commit.message ? ` ${report.commit.message}` : ""}`
      : `Not created: ${report.commit.detail ?? "No commit recorded."}`,
  );
  if (report.notes.length) section("Notes", report.notes);
  section("Open issues", report.unresolvedIssues);
  return lines.join("\n");
}

export function renderBlocked(s: WorkflowState) {
  const stopped =
    s.history.findLast((entry) => entry.event === "blocked")?.phase ?? s.phase;
  const failed = s.history.findLast(
    (entry) =>
      entry.phase === stopped &&
      (entry.event === "agent_failure" ||
        entry.event === "agent_attempt_failed"),
  );
  const role =
    failed?.meta?.agent ?? /^([a-zA-Z0-9]+):/.exec(failed?.detail ?? "")?.[1];
  const completed = s.history
    .filter((entry) => entry.event === "agent_completed")
    .map((entry) => entry.detail);
  const diagnostics = s.history.findLast(
    (entry) =>
      entry.phase === stopped &&
      entry.event === "agent_attempt_failed" &&
      (!role || entry.meta?.agent === role),
  )?.meta;
  const next = s.pendingQuestion
    ? "Answer the pending question."
    : s.blocker?.includes("repository") ||
        s.blocker?.includes("commit") ||
        s.blocker?.includes("mutating")
      ? "Inspect repository changes before retrying."
      : role && s.blocker?.startsWith("Agent execution failed:")
        ? `/team-retry ${role}`
        : "Use /team-status and /team-log for details.";
  return [
    "Team BLOCKED",
    "",
    "Stopped at",
    `${stopped}${role ? ` · ${role}` : ""}`,
    "",
    "Reason",
    s.blocker ?? "Unknown blocker",
    "",
    "Completed",
    ...(completed.length
      ? unique(completed).map((item) => `✓ ${item}`)
      : ["None recorded."]),
    "",
    "Repository changes",
    s.commit
      ? `Commit ${s.commit.hash}`
      : s.results.implementor
        ? "Implementation may have changed files; inspect the working tree."
        : "No implementation recorded.",
    "",
    "Diagnostics",
    `- Agent failures: ${s.agentFailures}/${s.config.workflow.maxAgentFailures}`,
    ...(diagnostics?.timeoutMs
      ? [`- Agent timeout: ${(diagnostics.timeoutMs / 1000).toFixed(1)}s`]
      : []),
    ...(diagnostics?.finalError?.requestDurationMs
      ? [
          `- Provider request: ${(diagnostics.finalError.requestDurationMs / 1000).toFixed(1)}s`,
        ]
      : []),
    ...(diagnostics?.finalError?.code
      ? [`- Provider code: ${diagnostics.finalError.code}`]
      : []),
    "",
    "Next action",
    next,
  ].join("\n");
}
