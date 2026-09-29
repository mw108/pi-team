import type { Role } from "./schemas.ts";
import type { WorkflowState } from "../workflow/state.ts";
import { actualDiff } from "../workflow/git.ts";
import { effectiveConfig } from "./discovery.ts";
import { buildCompletionReportInput } from "../workflow/report.ts";
export async function contextFor(
  role: Role,
  s: WorkflowState,
): Promise<Record<string, any>> {
  if (role === "reporter")
    return (
      (s.reportInput as Record<string, any> | undefined) ??
      (await buildCompletionReportInput(s))
    );
  const context: Record<string, unknown> = {
    task: s.task,
    requirements: s.requirements,
    answers: s.answers,
    workflowPosition: {
      role,
      phase: s.phase,
      uncommittedChangesExpected: !["commitAgent"].includes(role),
      laterGates:
        "Code review → optional penetration/security review → Tester → Commit Agent. A commit is forbidden until all earlier enabled gates pass.",
    },
  };
  const copy = (...keys: string[]) => {
    for (const key of keys) if (s.results[key]) context[key] = s.results[key];
  };
  if (role === "orchestrator")
    context.repositoryBaseline = {
      isGitRepository: true,
      workingTreeDirty: s.baseline.dirtyPaths.length > 0,
      status: s.baseline.status,
      nextPhase:
        "Researcher inspects repository files, source, tests and instructions",
    };
  if (role === "researcher")
    copy(
      "researcher",
      "previous_codeReviewer",
      "previous_securityReviewer",
      "previous_tester",
    );
  if (role.startsWith("solver")) {
    copy("researcher");
    context.solverId = role;
  }
  if (role === "critic" || role === "reviewer")
    copy("researcher", "solver1", "solver2", "solver3");
  if (role === "reviewer") copy("critic");
  if (role === "implementor")
    copy(
      "reviewer",
      "researcher",
      "previous_codeReviewer",
      "previous_securityReviewer",
      "previous_tester",
    );
  if (role === "implementor" && s.manualRetry?.agent === "implementor")
    context.manualRetry = {
      instruction:
        "This is a fresh attempt on the existing working tree. Inspect current files and diff before editing. Preserve all existing changes; do not reset or revert them.",
    };
  if (role === "implementor" && s.approvedDirtyPaths.length)
    context.preExistingChanges = {
      approvedExactPaths: s.approvedDirtyPaths,
      baselineDiff: s.baseline.diff,
      baselineCachedDiff: s.baseline.cachedDiff,
      instruction:
        "Preserve all existing working-tree content and user edits as the implementation base. Do not restore/reset or overwrite unrelated hunks. Read before editing. Automatic commit is prohibited for these files.",
    };
  if (
    [
      "codeReviewer",
      "pentester",
      "securityReviewer",
      "tester",
      "commitAgent",
    ].includes(role)
  ) {
    copy("reviewer", "implementor");
    context.actualDiff = await actualDiff(s.cwd);
    context.baselineDirtyPaths = s.baseline.dirtyPaths;
  }
  if (role === "securityReviewer") copy("pentester");
  if (role === "pentester")
    context.localHttpPolicy = {
      ...s.config.pentest.localHttp,
      allowedOrigins: [
        ...s.config.pentest.localHttp.allowedOrigins,
        ...s.config.pentest.localUrls.map((value) => new URL(value).origin),
      ],
    };
  if (role === "tester")
    context.approvedCommands = effectiveConfig(s).commands.filter((c) =>
      ["test", "static"].includes(c.purpose),
    );
  if (role === "commitAgent")
    copy("codeReviewer", "securityReviewer", "tester");
  context.previousFindings = s.history
    .filter((e) => e.event.startsWith("FIX_"))
    .slice(-5)
    .map((e) => e.event);
  return context;
}
