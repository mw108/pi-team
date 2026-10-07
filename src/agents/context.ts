import type { Role } from "./schemas.ts";
import type { WorkflowState } from "../workflow/state.ts";
import { providerDiff } from "../workflow/git.ts";
import { redactStructured } from "./redaction.ts";
import { effectiveConfig } from "./discovery.ts";
import { allowedCommandCategories } from "./command-policy.ts";
import { buildCompletionReportInput } from "../workflow/report.ts";
import { getActiveSolverIds } from "../config/solvers.ts";
import { testerValidationContext } from "./validation-context.ts";
export async function contextFor(
  role: Role,
  s: WorkflowState,
): Promise<Record<string, any>> {
  if (role === "reporter")
    return sanitizeContextForProvider(
      (s.reportInput as Record<string, any> | undefined) ??
        (await buildCompletionReportInput(s)),
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
        "Code review → optional Pentest → Security Review → Tester → Commit Agent. A commit is forbidden until all earlier enabled gates pass.",
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
  if (role === "researcher") {
    copy(
      "previous_researcher",
      "previous_codeReviewer",
      "previous_securityReviewer",
      "previous_tester",
    );
    if (s.answers.some((answer) => answer.sourceAgent === "researcher"))
      context.researchClarification = {
        instruction:
          "The researcher entries in answers are user answers to your previous unresolved questions. Incorporate them into your new research result. Remove answered questions from unresolvedQuestions unless an answer creates a genuinely new blocking ambiguity.",
      };
  }
  if (role.startsWith("solver")) {
    copy("researcher");
    context.solverId = role;
  }
  if (role === "critic" || role === "reviewer")
    copy("researcher", ...getActiveSolverIds(s.config));
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
      // Existing user edits are identified by path, without exposing their content.
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
    context.actualDiff = await providerDiff(s);
    context.baselineDirtyPaths = s.baseline.dirtyPaths;
  }
  if (role === "securityReviewer" && s.config.qualityGates.pentest.enabled)
    copy("pentester");
  if (role === "pentester")
    context.localHttpPolicy = {
      ...s.config.pentest.localHttp,
      allowedOrigins: [
        ...s.config.pentest.localHttp.allowedOrigins,
        ...s.config.pentest.localUrls.map((value) => new URL(value).origin),
      ],
    };
  if (role === "tester") {
    context.approvedCommands = effectiveConfig(s, role).commands.filter((c) =>
      allowedCommandCategories(role).includes(c.purpose),
    );
    Object.assign(context, testerValidationContext(s));
    context.candidateValidationCommandList = (
      context.candidateValidationCommands as {
        executable: string;
        args: string[];
      }[]
    ).map(
      (command, index) =>
        `${index + 1}. ${[command.executable, ...command.args].join(" ")}`,
    );
  }
  if (role === "commitAgent") {
    copy("codeReviewer", "securityReviewer", "tester");
    if (!s.commitSelection) throw new Error("Host commit selection is missing");
    context.authoritativeCommitPaths = s.commitSelection.commitPaths;
    context.excludedCommitPaths = s.commitSelection.excludedPaths;
    context.commitPathInstruction =
      "The host has validated the exact file set. Generate a Conventional Commit message for authoritativeCommitPaths. Do not add, remove, or propose paths. excludedCommitPaths are local-only changes and are intentionally omitted; their presence is not an error.";
  }
  context.previousFindings = s.history
    .filter((e) => e.event.startsWith("FIX_"))
    .slice(-5)
    .map((e) => e.event);
  return sanitizeContextForProvider(context);
}

export function sanitizeContextForProvider<T>(context: T): T {
  return redactStructured(context);
}
