import { z } from "zod";
import { randomUUID } from "node:crypto";
import {
  configSchema,
  commandSchema,
  discoveredCommandSchema,
  type TeamConfig,
} from "../config/schema.ts";
import { assertRelative } from "../agents/permissions.ts";
import { policyPath } from "../agents/path-policy.ts";
import { detectedCommandId } from "../agents/discovery.ts";
import {
  normalizedRuntimeCommand,
  similarCommandRuleSchema,
} from "../agents/runtime-commands.ts";
import { posix } from "node:path";
import { verifiedCommandResultSchema } from "./verified-commands.ts";
import type { ProjectInstructions } from "./project-instructions.ts";
import {
  redactVisibleText,
  redactStructured,
  redactStructuredInPlace,
} from "../agents/redaction.ts";
const exactPath = z.string().superRefine((path, ctx) => {
  try {
    assertRelative(path);
    if (
      path.includes("\\") ||
      /[?*\[\]]/.test(path) ||
      posix.normalize(path) !== path ||
      path === "." ||
      path.endsWith("/")
    )
      throw new Error("Not an exact normalized path");
  } catch {
    ctx.addIssue({
      code: "custom",
      message: "Approval requires an exact normalized repository-relative path",
    });
  }
});
export const approvalSchema = z.object({
  kind: z.enum([
    "commands",
    "dirtyPaths",
    "manualCommit",
    "configDrift",
    "manualRetry",
    "runtimeCommand",
    "runtimeFile",
    "contractPath",
    "sensitivePaths",
    "orphanedImplementation",
    "securityRisk",
  ]),
  title: z.string(),
  prompt: z.string(),
  options: z.array(
    z.object({ value: z.string(), label: z.string(), description: z.string() }),
  ),
});
export type ApprovalRequest = z.infer<typeof approvalSchema>;
import {
  roles,
  type Role,
  parseResult,
  questionSchema,
  pentestSchema,
  type WorkflowResults,
} from "../agents/schemas.ts";
export const phases = [
  "ORCHESTRATE",
  "RESEARCH",
  "SOLVE",
  "CRITIQUE",
  "REVIEW",
  "IMPLEMENT",
  "CODE_REVIEW",
  "PENTEST",
  "SECURITY_REVIEW",
  "TEST",
  "COMMIT",
  "REPORT",
  "WAITING_USER",
  "BLOCKED",
  "DONE",
  "ABORTED",
] as const;
export type Phase = (typeof phases)[number];
export const pendingQuestionSchema = questionSchema.extend({
  route: z.literal("FIX_REQUIREMENTS").optional(),
  sourceAgent: z.enum(roles).optional(),
  sourcePhase: z.enum(phases).optional(),
});
export const securityRiskReviewSchema = z.object({
  status: z.enum(["pending", "accepted"]),
  findings: z.array(
    z.object({
      id: z.string(),
      classification: z.literal("ACCEPTED_RISK"),
      evidence: z.string(),
    }),
  ),
  resultHash: z.string().regex(/^[a-f0-9]{64}$/),
  securityReviewerAttempt: z.number().int().positive().optional(),
  reviewedAt: z.string().optional(),
});
export type SecurityRiskReview = z.infer<typeof securityRiskReviewSchema>;
export const baselineSchema = z.object({
  head: z.string().nullable(),
  dirtyPaths: z.array(z.string()),
  status: z.string(),
  diff: z.string(),
  cachedDiff: z.string(),
});
export const stateSchema = z.object({
  version: z.literal(3),
  id: z.string().uuid(),
  cwd: z.string(),
  task: z.string().min(1),
  requirements: z.array(z.string()),
  phase: z.enum(phases),
  config: configSchema,
  teamConfigPath: z.string().optional(),
  teamConfigHash: z.string().optional(),
  semanticConfigHash: z.string().optional(),
  driftConfigSnapshot: configSchema.optional(),
  agentPromptHashes: z.record(z.string()).optional(),
  projectInstructions: z
    .object({
      source: z.literal("AGENTS.md"),
      content: z.string(),
      sha256: z.string(),
      bytes: z.number().int().nonnegative(),
      loadedAt: z.string(),
    })
    .nullable()
    .optional() as z.ZodType<ProjectInstructions | null | undefined>,
  driftCandidate: z
    .object({
      configPath: z.string(),
      configHash: z.string(),
      agentPromptHashes: z.record(z.string()),
      changed: z.array(z.string()),
    })
    .optional(),
  fullCycle: z.number().int().min(1),
  localFixCycle: z.number().int().min(0),
  pentestCycle: z.number().int().min(0),
  agentFailures: z.number().int().min(0),
  questionCount: z.number().int().min(0),
  researchClarificationCount: z.number().int().min(0).default(0),
  results: z.record(z.unknown()).transform((value): WorkflowResults => value),
  baseline: baselineSchema,
  history: z.array(
    z.object({
      at: z.string(),
      phase: z.enum(phases),
      event: z.string(),
      detail: z.string(),
      instruction: z
        .object({
          path: z.literal("AGENTS.md"),
          sha256: z.string().optional(),
          bytes: z.number().int().nonnegative().optional(),
        })
        .optional(),
      meta: z
        .object({
          agent: z.enum(roles),
          attempt: z.number().int().positive(),
          retryNumber: z.number().int().min(0).optional(),
          reason: z.string().optional(),
          timeoutMs: z.number().int().nullable().optional(),
          timeoutMode: z.enum(["limited", "unlimited"]).optional(),
          durationMs: z.number().int().optional(),
          networkRetry: z.number().int().nonnegative().optional(),
          finalError: z
            .object({
              name: z.string().optional(),
              message: z.string().optional(),
              code: z.string().optional(),
              causeMessage: z.string().optional(),
              requestDurationMs: z.number().int().nonnegative().optional(),
            })
            .optional(),
          trigger: z
            .enum([
              "initial",
              "automatic_retry",
              "manual_retry",
              "manual_continue",
              "user_clarification",
              "fix_local",
              "fix_design",
              "fix_requirements",
              "pentest_remediation",
              "security_remediation",
              "test_remediation",
            ])
            .optional(),
          count: z.number().int().nonnegative().optional(),
          sourcePhase: z.enum(phases).optional(),
          sourceOutcome: z.literal("BLOCKED").optional(),
          sourceAttempt: z.number().int().positive().optional(),
          paths: z.array(z.string()).optional(),
        })
        .optional(),
    }),
  ),
  pendingQuestion: pendingQuestionSchema.optional(),
  securityRiskReview: securityRiskReviewSchema.optional(),
  pendingResearchQuestions: z.array(z.string().min(1)).optional(),
  researchClarificationPending: z.boolean().optional(),
  resumePhase: z.enum(phases).optional(),
  answers: z.array(
    z.object({
      question: z.string(),
      answer: z.string(),
      sourceAgent: z.enum(roles).optional(),
      cycle: z.number().int().positive().optional(),
    }),
  ),
  discoveredCommands: z.array(discoveredCommandSchema).default([]),
  approvedCommands: z.array(commandSchema).default([]),
  runtimeApprovedCommandIds: z.array(z.string()).default([]),
  runtimeCommandApprovals: z
    .array(z.object({ role: z.enum(roles), command: commandSchema }))
    .default([]),
  verifiedCommandResults: z.array(verifiedCommandResultSchema).default([]),
  similarCommandRules: z.array(similarCommandRuleSchema).default([]),
  pendingRuntimeCommands: z
    .array(
      z
        .object({
          workflowId: z.string().uuid(),
          agentId: z.enum(roles),
          run: z.number().int().positive(),
          requestId: z.string().uuid(),
          command: commandSchema,
          purpose: z.string().max(500),
        })
        .strict(),
    )
    .default([]),
  runtimeFileApprovals: z
    .array(
      z
        .object({
          role: z.enum(roles),
          operation: z.enum(["read", "write"]),
          path: exactPath,
        })
        .strict(),
    )
    .default([]),
  workflowApprovedContractPaths: z
    .array(
      z
        .object({
          path: exactPath,
          operation: z.enum(["create", "modify", "delete"]),
        })
        .strict(),
    )
    .default([]),
  completedOneShotContractPaths: z.array(exactPath).default([]),
  pendingContractPaths: z
    .array(
      z
        .object({
          workflowId: z.string().uuid(),
          agentId: z.enum(roles),
          run: z.number().int().positive(),
          requestId: z.string().uuid(),
          path: exactPath,
          operation: z.enum(["create", "modify", "delete"]),
          reason: z.string().min(1).max(500),
        })
        .strict(),
    )
    .default([]),
  pendingRuntimeFiles: z
    .array(
      z
        .object({
          workflowId: z.string().uuid(),
          agentId: z.enum(roles),
          run: z.number().int().positive(),
          requestId: z.string().uuid(),
          operation: z.enum(["read", "write"]),
          path: exactPath,
        })
        .strict(),
    )
    .default([]),
  commandApprovalComplete: z.boolean().default(false),
  approvedDirtyPaths: z.array(exactPath).default([]),
  approvedSensitivePaths: z.array(z.string()).default([]),
  sensitiveApprovalContractHash: z.string().optional(),
  pendingApproval: approvalSchema.optional(),
  inFlight: z
    .object({ phase: z.enum(phases), roles: z.array(z.enum(roles)) })
    .optional(),
  manualRetry: z
    .object({ agent: z.enum(roles), phase: z.enum(phases) })
    .optional(),
  interruptedMutationRecovery: z
    .object({
      agent: z.enum(roles),
      phase: z.enum(phases),
      attempt: z.number().int().positive(),
      reason: z.enum(["user_stop", "process_interrupted"]),
      hashes: z.record(z.string()),
      createdPaths: z.array(exactPath),
      discardablePaths: z.array(exactPath),
    })
    .optional(),
  blocker: z.string().optional(),
  blockerMeta: z
    .object({
      sourcePhase: z.enum(phases),
      sourceAgent: z.enum(roles),
      sourceAttempt: z.number().int().positive(),
      kind: z.literal("quality_gate_blocked"),
    })
    .optional(),
  gateHashes: z.record(z.string()).optional(),
  testMutationCycles: z.number().int().min(0).default(0),
  priorImplementation: z
    .object({
      attempt: z.number().int().positive().optional(),
      hashes: z.record(z.string()),
      createdPaths: z.array(z.string()),
      discardablePaths: z.array(exactPath).default([]),
    })
    .optional(),
  observedImplementorMutations: z
    .array(
      z
        .object({
          attempt: z.number().int().positive(),
          path: exactPath,
          identity: z.string(),
          kind: z.enum(["edit", "write", "delete"]),
        })
        .strict(),
    )
    .default([]),
  implementationStartHashes: z.record(z.string()).optional(),
  commitIntent: z
    .object({
      head: z.string().nullable(),
      files: z.array(z.string()),
      message: z.string(),
      hashes: z.record(z.string()),
    })
    .optional(),
  commitSelection: z
    .object({
      workflowPaths: z.array(z.string()),
      excludedPaths: z.array(z.string()),
      commitPaths: z.array(z.string()),
      validatedAt: z.string().optional(),
      completed: z.boolean().default(false),
    })
    .optional(),
  commit: z
    .object({
      hash: z.string(),
      files: z.array(z.string()),
      message: z.string().optional(),
    })
    .optional(),
  reportFailure: z.string().optional(),
  reportInput: z.unknown().optional(),
});
export type WorkflowState = z.infer<typeof stateSchema>;
function migrateState(value: unknown): unknown {
  if (value && typeof value === "object") {
    const old = value as Record<string, any>;
    if (
      (old.version === 1 || old.version === 2 || old.version === 3) &&
      old.config?.agents &&
      !old.config.agents.reporter
    )
      value = {
        ...old,
        config: {
          ...old.config,
          agents: {
            ...old.config.agents,
            reporter: {
              role: "reporter",
              prompt: "agents/reporter.md",
              provider: old.config.agents.orchestrator.provider,
              model: old.config.agents.orchestrator.model,
              temperature: 0.1,
              thinking: "off",
              timeoutMs: 600000,
            },
          },
        },
      };
  }
  if (!value || typeof value !== "object") return value;
  const selection = (value as Record<string, any>).commitSelection;
  if (selection && !Array.isArray(selection.workflowPaths))
    value = {
      ...(value as Record<string, unknown>),
      commitSelection: {
        workflowPaths: selection.requestedPaths ?? [],
        excludedPaths: selection.excludedPaths ?? [],
        commitPaths: selection.commitFiles ?? [],
        completed: selection.completed ?? false,
      },
    };
  // Earlier runtime grants had category scope, and old similarity rules allowed
  // arbitrary suffixes. Their requesting role cannot be recovered safely.
  const legacy = value as Record<string, any>;
  const revokedIds = new Set<string>(legacy.runtimeApprovedCommandIds ?? []);
  const revokedRules = (legacy.similarCommandRules ?? []).filter(
    (rule: any) => rule.allowRemainingArgs || !rule.role,
  );
  if (revokedIds.size || revokedRules.length) {
    value = {
      ...legacy,
      approvedCommands: (legacy.approvedCommands ?? []).filter(
        (command: any) => !revokedIds.has(command.id),
      ),
      runtimeApprovedCommandIds: [],
      similarCommandRules: (legacy.similarCommandRules ?? []).filter(
        (rule: any) => !rule.allowRemainingArgs && rule.role,
      ),
      history: [
        ...(legacy.history ?? []),
        {
          at: new Date().toISOString(),
          phase: legacy.phase,
          event: "legacy_runtime_approvals_revoked",
          detail: `${revokedIds.size} exact and ${revokedRules.length} similar grants require reapproval`,
        },
      ],
    };
  }
  const versioned = value as Record<string, unknown>;
  if (versioned.version === 2) return { ...versioned, version: 3 };
  if (versioned.version !== 1) return value;
  const old = value as Record<string, unknown>;
  const results = { ...((old.results ?? {}) as Record<string, unknown>) };
  for (const key of ["reviewer", "previous_reviewer"]) {
    const contract = results[key];
    if (!contract || typeof contract !== "object") continue;
    const raw = contract as Record<string, unknown>;
    if (!Array.isArray(raw.requiredTests)) continue;
    results[key] = {
      ...raw,
      requiredTests: raw.requiredTests.map((test) =>
        typeof test === "string"
          ? { description: test, action: "existing" }
          : test,
      ),
    };
  }
  return { ...old, version: 3, results };
}
export function validateState(value: unknown): WorkflowState {
  const state = stateSchema.parse(migrateState(value));
  for (const mutation of state.observedImplementorMutations)
    if (policyPath(mutation.path) !== mutation.identity)
      throw new Error(
        "Observed Implementor mutation has invalid path identity",
      );
  // Version 3 predates explicit Pentest completion. Legacy empty findings
  // cannot be promoted to PASS on reload.
  const oldPentest = state.results.pentester as
    Record<string, unknown> | undefined;
  if (oldPentest && !oldPentest.status) {
    if (Array.isArray(oldPentest.findings) && oldPentest.findings.length) {
      state.results.pentester = pentestSchema.parse({
        ...oldPentest,
        status: "FINDINGS",
      });
    } else {
      state.results.pentester = pentestSchema.parse({
        ...oldPentest,
        status: "BLOCKED",
        blocker: {
          code: "LEGACY_PENTEST_REQUIRES_RERUN",
          message:
            "Legacy Pentest result has no completion status; rerun required.",
          remediation: "Use /team-retry pentester.",
        },
      });
      if (
        [
          "PENTEST",
          "SECURITY_REVIEW",
          "TEST",
          "COMMIT",
          "REPORT",
          "DONE",
        ].includes(state.phase)
      ) {
        state.pentestCycle = Math.max(0, state.pentestCycle - 1);
        state.phase = "PENTEST";
        block(
          state,
          "Pentest blocked: Legacy Pentest result has no completion status; rerun required.",
        );
        for (const role of [
          "securityReviewer",
          "tester",
          "commitAgent",
          "reporter",
        ])
          delete state.results[role];
      }
    }
  }
  for (const command of state.approvedCommands)
    if (
      !state.runtimeApprovedCommandIds.includes(command.id) &&
      !state.discoveredCommands.some(
        (c) => JSON.stringify(c.command) === JSON.stringify(command),
      )
    )
      throw new Error("Approved command is not an exact discovered command");
  for (const id of state.runtimeApprovedCommandIds)
    if (
      !state.approvedCommands.some(
        (command) => command.id === id && detectedCommandId(command) === id,
      )
    )
      throw new Error(
        "Runtime command approval has no matching deterministic command",
      );
  for (const approval of state.runtimeCommandApprovals) {
    const command = approval.command;
    const expected = normalizedRuntimeCommand(
      {
        executable: command.executable,
        args: command.args,
        purpose: "Persisted runtime approval",
        category: command.purpose,
      },
      approval.role,
    ).command;
    if (command.id !== expected.id)
      throw new Error("Runtime role approval identity mismatch");
  }
  for (const result of state.verifiedCommandResults)
    if (
      result.commandIdentity !==
      JSON.stringify([result.command.executable, result.command.args])
    )
      throw new Error("Verified command result identity mismatch");
  for (const rule of state.similarCommandRules)
    normalizedRuntimeCommand(
      {
        executable: rule.executable,
        args: rule.argsPrefix,
        purpose: "Persisted similar approval",
        category: rule.category,
      },
      rule.role,
    );
  for (const pending of state.pendingRuntimeCommands)
    if (
      pending.workflowId !== state.id ||
      pending.command.id !== detectedCommandId(pending.command)
    )
      throw new Error("Pending command approval identity mismatch");
  for (const pending of state.pendingRuntimeFiles)
    if (
      pending.workflowId !== state.id ||
      policyPath(pending.path) !== pending.path
    )
      throw new Error("Pending file approval identity mismatch");
  for (const approval of state.runtimeFileApprovals)
    if (policyPath(approval.path) !== approval.path)
      throw new Error("Runtime file approval identity mismatch");
  for (const pending of state.pendingContractPaths)
    if (
      pending.workflowId !== state.id ||
      policyPath(pending.path) !== pending.path
    )
      throw new Error("Pending contract path identity mismatch");
  for (const approval of state.workflowApprovedContractPaths)
    if (policyPath(approval.path) !== approval.path)
      throw new Error("Contract path approval identity mismatch");
  for (const path of state.completedOneShotContractPaths)
    if (policyPath(path) !== path)
      throw new Error("One-shot contract mutation identity mismatch");
  for (const path of state.approvedDirtyPaths)
    if (!state.baseline.dirtyPaths.includes(path))
      throw new Error("Approved dirty path is not in the baseline");
  for (const [key, result] of Object.entries(state.results))
    if ((roles as readonly string[]).includes(key))
      parseResult(
        key as Role,
        key === "commitAgent" && result && typeof result === "object"
          ? { message: (result as Record<string, unknown>).message }
          : result,
      );
  return state;
}
export function newState(
  cwd: string,
  task: string,
  config: TeamConfig,
  baseline: z.infer<typeof baselineSchema>,
): WorkflowState {
  return {
    version: 3,
    id: randomUUID(),
    cwd,
    task,
    requirements: [],
    phase: "ORCHESTRATE",
    config,
    fullCycle: 1,
    localFixCycle: 0,
    pentestCycle: 0,
    agentFailures: 0,
    questionCount: 0,
    researchClarificationCount: 0,
    results: {},
    baseline,
    history: [],
    answers: [],
    discoveredCommands: [],
    approvedCommands: [],
    runtimeApprovedCommandIds: [],
    runtimeCommandApprovals: [],
    verifiedCommandResults: [],
    similarCommandRules: [],
    pendingRuntimeCommands: [],
    runtimeFileApprovals: [],
    pendingRuntimeFiles: [],
    workflowApprovedContractPaths: [],
    completedOneShotContractPaths: [],
    pendingContractPaths: [],
    approvedDirtyPaths: [],
    approvedSensitivePaths: [],
    commandApprovalComplete: false,
    testMutationCycles: 0,
    observedImplementorMutations: [],
  };
}
export function record(
  state: WorkflowState,
  event: string,
  detail = "",
  meta?: WorkflowState["history"][number]["meta"],
  instruction?: WorkflowState["history"][number]["instruction"],
) {
  state.history.push({
    at: new Date().toISOString(),
    phase: state.phase,
    event,
    detail: redactVisibleText(detail).slice(0, 4000),
    ...(meta ? { meta: redactStructured(meta) } : {}),
    ...(instruction ? { instruction } : {}),
  });
}
export function block(
  state: WorkflowState,
  reason: string,
  provenance?: WorkflowState["blockerMeta"],
) {
  record(state, "blocked", reason);
  state.phase = "BLOCKED";
  state.blocker = redactVisibleText(reason).slice(0, 4000);
  if (provenance) state.blockerMeta = provenance;
  else delete state.blockerMeta;
}

/** Sanitize free text before each new state write; operational argv stays intact. */
export function sanitizeWorkflowStateText(state: WorkflowState): void {
  // Preserve projectInstructions.content exactly for later agent attempts.
  // Only diagnostic copies of that content are redacted.
  state.task = redactVisibleText(state.task);
  state.requirements = state.requirements.map(redactVisibleText);
  // Security Reviewer's result is the exact subject of a user risk decision.
  // Keep it intact in private workflow state; diagnostic copies remain redacted.
  for (const [key, result] of Object.entries(state.results)) {
    if (key === "securityReviewer") continue;
    (state.results as Record<string, unknown>)[key] =
      typeof result === "string"
        ? redactVisibleText(result)
        : redactStructuredInPlace(result);
  }
  redactStructuredInPlace(state.answers);
  redactStructuredInPlace(state.history);
  if (state.blocker) state.blocker = redactVisibleText(state.blocker);
  if (state.reportFailure)
    state.reportFailure = redactVisibleText(state.reportFailure);
  if (state.reportInput)
    state.reportInput = redactStructured(state.reportInput);
  if (state.pendingQuestion)
    state.pendingQuestion = redactStructured(state.pendingQuestion);
  if (state.pendingResearchQuestions)
    state.pendingResearchQuestions =
      state.pendingResearchQuestions.map(redactVisibleText);
  if (state.pendingApproval)
    state.pendingApproval = redactStructured(state.pendingApproval);
  state.pendingRuntimeCommands = state.pendingRuntimeCommands.map((entry) => ({
    ...entry,
    purpose: redactVisibleText(entry.purpose),
  }));
  state.baseline.diff = "";
  state.baseline.cachedDiff = "";
}
