import { z } from "zod";
import { randomUUID } from "node:crypto";
import {
  configSchema,
  commandSchema,
  discoveredCommandSchema,
  type TeamConfig,
} from "../config/schema.ts";
import { assertRelative } from "../agents/permissions.ts";
import { detectedCommandId } from "../agents/discovery.ts";
import { similarCommandRuleSchema } from "../agents/runtime-commands.ts";
import { posix } from "node:path";
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
] as const;
export type Phase = (typeof phases)[number];
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
  results: z.record(z.unknown()),
  baseline: baselineSchema,
  history: z.array(
    z.object({
      at: z.string(),
      phase: z.enum(phases),
      event: z.string(),
      detail: z.string(),
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
        })
        .optional(),
    }),
  ),
  pendingQuestion: questionSchema.optional(),
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
  commandApprovalComplete: z.boolean().default(false),
  approvedDirtyPaths: z.array(exactPath).default([]),
  pendingApproval: approvalSchema.optional(),
  inFlight: z
    .object({ phase: z.enum(phases), roles: z.array(z.enum(roles)) })
    .optional(),
  manualRetry: z
    .object({ agent: z.enum(roles), phase: z.enum(phases) })
    .optional(),
  blocker: z.string().optional(),
  gateHashes: z.record(z.string()).optional(),
  commitIntent: z
    .object({
      head: z.string().nullable(),
      files: z.array(z.string()),
      message: z.string(),
      hashes: z.record(z.string()),
    })
    .optional(),
  commit: z.object({ hash: z.string(), files: z.array(z.string()) }).optional(),
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
  if ((value as any).version === 2) return { ...(value as object), version: 3 };
  if ((value as any).version !== 1) return value;
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
  // Version 3 predates explicit Pentest completion. Legacy empty findings
  // cannot be promoted to PASS on reload.
  const oldPentest = state.results.pentester as Record<string, any> | undefined;
  if (oldPentest && !oldPentest.status) {
    if (Array.isArray(oldPentest.findings) && oldPentest.findings.length) {
      state.results.pentester = { ...oldPentest, status: "FINDINGS" };
    } else {
      state.results.pentester = {
        ...oldPentest,
        status: "BLOCKED",
        blocker: {
          code: "LEGACY_PENTEST_REQUIRES_RERUN",
          message:
            "Legacy Pentest result has no completion status; rerun required.",
          remediation: "Use /team-retry pentester.",
        },
      };
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
  for (const pending of state.pendingRuntimeCommands)
    if (
      pending.workflowId !== state.id ||
      pending.command.id !== detectedCommandId(pending.command)
    )
      throw new Error("Pending command approval identity mismatch");
  for (const path of state.approvedDirtyPaths)
    if (!state.baseline.dirtyPaths.includes(path))
      throw new Error("Approved dirty path is not in the baseline");
  for (const [key, result] of Object.entries(state.results))
    if ((roles as readonly string[]).includes(key))
      parseResult(key as Role, result);
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
    similarCommandRules: [],
    pendingRuntimeCommands: [],
    approvedDirtyPaths: [],
    commandApprovalComplete: false,
  };
}
export function record(
  state: WorkflowState,
  event: string,
  detail = "",
  meta?: WorkflowState["history"][number]["meta"],
) {
  state.history.push({
    at: new Date().toISOString(),
    phase: state.phase,
    event,
    detail,
    ...(meta ? { meta } : {}),
  });
}
export function block(state: WorkflowState, reason: string) {
  record(state, "blocked", reason);
  state.phase = "BLOCKED";
  state.blocker = reason;
}
