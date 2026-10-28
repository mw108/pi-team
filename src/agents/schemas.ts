import { z, ZodError } from "zod";
import { posix } from "node:path";
import { assertRelative } from "./permissions.ts";
import { AgentOutputError } from "./errors.ts";
import { redactVisibleText } from "./redaction.ts";
import {
  inspectLocalJsonRepairCandidate,
  repairJsonLocally,
  type LocalJsonRepairEvent,
} from "./local-json-repair.ts";

export const roles = [
  "orchestrator",
  "researcher",
  "solver1",
  "solver2",
  "solver3",
  "solver4",
  "solver5",
  "solver6",
  "solver7",
  "solver8",
  "solver9",
  "solver10",
  "critic",
  "reviewer",
  "implementor",
  "codeReviewer",
  "pentester",
  "securityReviewer",
  "tester",
  "commitAgent",
  "reporter",
] as const;
export type Role = (typeof roles)[number];
export type SolverAgentId = Extract<Role, `solver${number}`>;
export const solverIds = roles.filter((role): role is SolverAgentId =>
  /^solver(?:10|[1-9])$/.test(role),
);
const strings = z.array(z.string());
const text = z.string().min(1);
export const route = z.enum([
  "APPROVED",
  "FIX_LOCAL",
  "FIX_DESIGN",
  "FIX_REQUIREMENTS",
]);
export const questionSchema = z
  .object({
    type: z.literal("QUESTION_REQUEST"),
    blocking: z.literal(true),
    question: text,
    reason: text,
  })
  .strict();
const source = z.object({
  title: text,
  url: z.string().url(),
  kind: z.enum(["official", "external"]),
  influence: text,
});
export const researchSchema = z.object({
  affectedFiles: strings,
  relevantSymbols: strings,
  architectureSummary: text,
  existingPatterns: strings,
  dependencies: z.array(
    z.object({ name: text, version: z.string(), notes: z.string() }),
  ),
  constraints: strings,
  regressionRisks: strings,
  externalSources: z.array(source),
  assumptions: strings,
  unresolvedQuestions: strings,
});
export const proposalSchema = z.object({
  solverId: text,
  title: text,
  approach: text,
  filesToChange: strings,
  implementationPlan: strings,
  advantages: strings,
  disadvantages: strings,
  risks: strings,
  assumptions: strings,
  requiredTests: strings,
});
export const critiqueSchema = z.object({
  proposalCritiques: z.array(
    z.object({ solverId: text, weaknesses: strings, tradeoffs: strings }),
  ),
  crossProposalObservations: strings,
  recommendedElements: strings,
  rejectedElements: strings,
  unresolvedRisks: strings,
});
const contractPath = z.string().superRefine((path, ctx) => {
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
      message: "Expected an exact repository-relative path",
    });
  }
});
export const requiredTestSchema = z
  .object({
    description: z.string().trim().min(1),
    action: z.enum(["existing", "create", "modify"]),
    file: contractPath.optional(),
    scope: z.enum(["unit", "integration", "e2e", "other"]).optional(),
    acceptanceCriteria: z.array(z.string().trim().min(1)).optional(),
  })
  .superRefine((test, ctx) => {
    if (test.action !== "existing" && !test.file)
      ctx.addIssue({
        code: "custom",
        path: ["file"],
        message: `${test.action} requires a test file`,
      });
  });
export const contractSchema = z
  .object({
    goal: text,
    filesToModify: z.array(contractPath),
    filesToCreate: z.array(contractPath),
    filesToDelete: z.array(contractPath),
    requiredChanges: strings,
    technicalDecisions: strings,
    constraints: strings,
    requiredTests: z.array(requiredTestSchema),
    acceptanceCriteria: strings,
    knownRisks: strings,
    pentestCapabilities: z
      .array(
        z
          .object({
            id: z.string().regex(/^[a-z][a-z0-9-]*$/),
            description: text,
            requirement: z.enum([
              "REQUIRED",
              "OPTIONAL",
              "INTENTIONALLY_ABSENT",
            ]),
            testMethod: z.enum(["HTTP", "COMMAND", "STATIC", "OTHER"]),
            interfaces: strings,
            rationale: text,
          })
          .strict(),
      )
      .optional(),
  })
  .superRefine((contract, ctx) => {
    const actions = new Map<string, Set<string>>();
    for (const [index, test] of contract.requiredTests.entries()) {
      if (!test.file) continue;
      if (
        test.action === "modify" &&
        !contract.filesToModify.includes(test.file)
      )
        ctx.addIssue({
          code: "custom",
          path: ["requiredTests", index, "file"],
          message: `modify test file must appear in filesToModify: ${test.file}`,
        });
      if (
        test.action === "create" &&
        !contract.filesToCreate.includes(test.file)
      )
        ctx.addIssue({
          code: "custom",
          path: ["requiredTests", index, "file"],
          message: `create test file must appear in filesToCreate: ${test.file}`,
        });
      const seen = actions.get(test.file) ?? new Set<string>();
      seen.add(test.action);
      actions.set(test.file, seen);
      if (seen.has("create") && seen.has("modify"))
        ctx.addIssue({
          code: "custom",
          path: ["requiredTests", index],
          message: `Conflicting test actions for: ${test.file}`,
        });
    }
    const capabilityIds = new Set<string>();
    for (const [index, capability] of (
      contract.pentestCapabilities ?? []
    ).entries()) {
      if (capabilityIds.has(capability.id))
        ctx.addIssue({
          code: "custom",
          path: ["pentestCapabilities", index, "id"],
          message: `Duplicate pentest capability id: ${capability.id}`,
        });
      capabilityIds.add(capability.id);
    }
  });
export const implementationSchema = z.union([
  z.object({
    status: z.literal("IMPLEMENTED"),
    summary: text,
    changedFiles: strings,
    checks: strings,
  }),
  z.object({
    status: z.literal("IMPLEMENTATION_BLOCKED"),
    reason: text,
    evidence: strings,
    blockerCategory: z
      .enum([
        "REQUIREMENT_BLOCKED",
        "CONTRACT_AUTHORIZATION_BLOCKED",
        "RUNTIME_PERMISSION_BLOCKED",
        "TOOL_EXECUTION_BLOCKED",
        "IMPLEMENTATION_FAILED",
      ])
      .optional(),
    suggestedRoute: z.enum(["FIX_DESIGN", "FIX_REQUIREMENTS"]),
  }),
]);
export const findingSchema = z.object({
  severity: z.enum(["critical", "high", "medium", "low"]),
  file: text,
  line: z.number().int().positive().optional(),
  problem: text,
  suggestedFix: text,
  requiresRedesign: z.boolean(),
});
export const reviewSchema = z
  .object({
    status: route,
    findings: z.array(findingSchema),
    question: z.string().optional(),
  })
  .superRefine((v, ctx) => {
    if (v.status === "APPROVED" && v.findings.length)
      ctx.addIssue({
        code: "custom",
        message: "APPROVED cannot have unresolved findings",
      });
    if (v.status === "FIX_REQUIREMENTS" && !v.question)
      ctx.addIssue({
        code: "custom",
        message: "FIX_REQUIREMENTS requires a question",
      });
    if (["FIX_LOCAL", "FIX_DESIGN"].includes(v.status) && !v.findings.length)
      ctx.addIssue({ code: "custom", message: "Fix status requires evidence" });
  });
export const pentestFindingSchema = z.object({
  id: text,
  title: text,
  severity: z.enum(["critical", "high", "medium", "low"]),
  category: text,
  affectedComponent: text,
  reproductionSteps: strings,
  evidence: text,
  impact: text,
  suggestedFix: text,
});
export const pentestBlockerSchema = z.object({
  code: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
  message: text,
  remediation: text.optional(),
});
export const unavailablePentestTestSchema = z
  .object({
    id: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*$/),
    description: text,
    capabilityId: z.string().regex(/^[a-z][a-z0-9-]*$/),
    requiredCapability: text,
    testMethod: z.enum(["HTTP", "COMMAND", "STATIC", "OTHER"]),
    unavailableBecause: text,
    alternativeEvidence: z.string().min(1).optional(),
    evidenceIds: strings,
  })
  .strict();
export const pentestSchema = z
  .object({
    status: z.enum([
      "PASS",
      "FINDINGS",
      "BLOCKED",
      "PENTEST_UNAVAILABLE",
      "COMPLETED_WITH_LIMITATIONS",
      "PENTEST_SKIPPED_BY_USER",
    ]),
    findings: z.array(pentestFindingSchema),
    coverage: strings,
    limitations: strings,
    blocker: pentestBlockerSchema.optional(),
    affectedTests: z.array(unavailablePentestTestSchema).optional(),
    userDecision: z
      .object({
        action: z.literal("SKIP_PENTEST_FOR_WORKFLOW"),
        decidedAt: z.string().datetime(),
        resultHash: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict()
      .optional(),
  })
  .superRefine((result, ctx) => {
    if (result.status === "PASS" && result.findings.length)
      ctx.addIssue({ code: "custom", message: "PASS cannot have findings" });
    if (result.status === "FINDINGS" && !result.findings.length)
      ctx.addIssue({ code: "custom", message: "FINDINGS requires findings" });
    if (result.status === "BLOCKED" && !result.blocker)
      ctx.addIssue({ code: "custom", message: "BLOCKED requires a blocker" });
    if (result.status !== "BLOCKED" && result.blocker)
      ctx.addIssue({
        code: "custom",
        message: "Only BLOCKED may have a blocker",
      });
    if (
      [
        "PENTEST_UNAVAILABLE",
        "COMPLETED_WITH_LIMITATIONS",
        "PENTEST_SKIPPED_BY_USER",
      ].includes(result.status) &&
      !result.affectedTests?.length
    )
      ctx.addIssue({
        code: "custom",
        message: `${result.status} requires affectedTests`,
      });
    if (
      ![
        "PENTEST_UNAVAILABLE",
        "COMPLETED_WITH_LIMITATIONS",
        "PENTEST_SKIPPED_BY_USER",
      ].includes(result.status) &&
      result.affectedTests?.length
    )
      ctx.addIssue({
        code: "custom",
        message: `${result.status} cannot carry unavailable affectedTests`,
      });
    if (result.status === "PENTEST_SKIPPED_BY_USER" && !result.userDecision)
      ctx.addIssue({
        code: "custom",
        message: "PENTEST_SKIPPED_BY_USER requires a host userDecision",
      });
    if (result.status !== "PENTEST_SKIPPED_BY_USER" && result.userDecision)
      ctx.addIssue({
        code: "custom",
        message: "Only PENTEST_SKIPPED_BY_USER may have a userDecision",
      });
    const affectedIds = new Set<string>();
    for (const [index, affected] of (result.affectedTests ?? []).entries()) {
      if (affectedIds.has(affected.id))
        ctx.addIssue({
          code: "custom",
          path: ["affectedTests", index, "id"],
          message: `Duplicate affected test id: ${affected.id}`,
        });
      affectedIds.add(affected.id);
    }
  });
export type PentestResult = z.infer<typeof pentestSchema>;
export const securitySchema = z.object({
  findings: z.array(
    z.object({
      id: text,
      classification: z.enum([
        "CONFIRMED",
        "FALSE_POSITIVE",
        "ENVIRONMENT_ARTIFACT",
        "ACCEPTED_RISK",
      ]),
      route: z.enum(["FIX_LOCAL", "FIX_DESIGN"]).optional(),
      evidence: text,
    }),
  ),
  summary: text,
});
export const persistedTestSchema = z.object({
  status: z.enum(["PASS", "FAIL", "BLOCKED"]),
  reason: z.string().optional(),
  commands: z.array(
    z.object({
      id: text,
      exitCode: z.number().int(),
      output: z.string(),
      stdout: z.string().optional(),
      stderr: z.string().optional(),
      timedOut: z.boolean().optional(),
      durationMs: z.number().int().nonnegative().optional(),
    }),
  ),
  failedAreas: strings,
  classification: z.enum(["FIX_LOCAL", "FIX_DESIGN"]).optional(),
  validationOutcomes: z
    .array(
      z.object({
        id: text,
        validationType: z.enum(["TEST", "STATIC", "BUILD", "DIAGNOSTIC"]),
        validator: z.enum([
          "LARAVEL_PINT",
          "PHP_CS_FIXER",
          "PHPSTAN",
          "PSALM",
          "ESLINT",
          "PRETTIER",
          "TYPESCRIPT",
          "PHP_LINT",
          "VITE",
          "WEBPACK",
          "NEXT",
          "ANGULAR",
          "PHPUNIT",
          "PHP_DIAGNOSTIC",
          "UNKNOWN",
          "COMPOSITE",
        ]),
        validatorSource: z.enum([
          "direct",
          "interpreter",
          "package_script",
          "unknown",
        ]),
        outcome: z.enum([
          "PASS",
          "TEST_FAILURE",
          "STATIC_FORMAT_FAILURE",
          "STATIC_ANALYSIS_FAILURE",
          "BUILD_FAILURE",
          "DIAGNOSTIC_FAILURE",
          "TOOL_UNAVAILABLE",
          "NOT_APPLICABLE",
          "INVOCATION_ERROR",
          "INFRASTRUCTURE_ERROR",
          "INDETERMINATE",
        ]),
        reason: text,
        recoverable: z.boolean(),
        applicability: z
          .enum(["REQUIRED", "OPTIONAL", "NOT_APPLICABLE", "AMBIGUOUS"])
          .optional(),
        executionOutcome: z
          .enum([
            "PASS",
            "TEST_FAILURE",
            "STATIC_FORMAT_FAILURE",
            "STATIC_ANALYSIS_FAILURE",
            "BUILD_FAILURE",
            "DIAGNOSTIC_FAILURE",
            "TOOL_UNAVAILABLE",
            "INVOCATION_ERROR",
            "INFRASTRUCTURE_ERROR",
            "INDETERMINATE",
          ])
          .optional(),
        supersededBy: z.string().uuid().optional(),
      }),
    )
    .optional(),
  failureFingerprint: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
});
export const testSchema = persistedTestSchema.superRefine((result, ctx) => {
  if (
    result.status === "PASS" &&
    (result.failedAreas.length || result.classification)
  )
    ctx.addIssue({
      code: "custom",
      message:
        "Tester PASS requires empty failedAreas and no remediation classification",
    });
  if (
    result.status === "FAIL" &&
    (!result.failedAreas.length || !result.classification)
  )
    ctx.addIssue({
      code: "custom",
      message:
        "Tester FAIL requires failedAreas and a remediation classification",
    });
  if (
    result.status === "BLOCKED" &&
    (result.failedAreas.length || result.classification)
  )
    ctx.addIssue({
      code: "custom",
      message:
        "Tester BLOCKED requires empty failedAreas and no remediation classification",
    });
});
export const commitSchema = z.object({ message: text }).strict();
export const completionReportSchema = z.object({
  summary: text,
  implemented: strings,
  changedFiles: strings,
  validation: z.array(
    z.object({
      label: text,
      status: z.enum(["passed", "failed", "disabled", "not-run", "warning"]),
      detail: z.string().optional(),
    }),
  ),
  notes: strings,
  excludedCommitPaths: z
    .array(z.object({ path: z.string(), reason: z.literal("non-committable") }))
    .optional(),
  unresolvedIssues: strings,
  commit: z.object({
    created: z.boolean(),
    hash: z.string().optional(),
    message: z.string().optional(),
    detail: z.string().optional(),
  }),
});
export const normalizeSchema = z.object({
  requirements: strings.min(1),
  summary: text,
});
export const resultSchemas = {
  orchestrator: normalizeSchema,
  researcher: researchSchema,
  solver1: proposalSchema,
  solver2: proposalSchema,
  solver3: proposalSchema,
  solver4: proposalSchema,
  solver5: proposalSchema,
  solver6: proposalSchema,
  solver7: proposalSchema,
  solver8: proposalSchema,
  solver9: proposalSchema,
  solver10: proposalSchema,
  critic: critiqueSchema,
  reviewer: contractSchema,
  implementor: implementationSchema,
  codeReviewer: reviewSchema,
  pentester: pentestSchema,
  securityReviewer: securitySchema,
  tester: testSchema,
  commitAgent: commitSchema,
  reporter: completionReportSchema,
} satisfies { [R in Role]: z.ZodType<ResultByRole[R]> };
export type ResultByRole = {
  orchestrator: z.infer<typeof normalizeSchema>;
  researcher: z.infer<typeof researchSchema>;
  critic: z.infer<typeof critiqueSchema>;
  reviewer: z.infer<typeof contractSchema>;
  implementor: z.infer<typeof implementationSchema>;
  codeReviewer: z.infer<typeof reviewSchema>;
  pentester: z.infer<typeof pentestSchema>;
  securityReviewer: z.infer<typeof securitySchema>;
  tester: z.infer<typeof testSchema>;
  commitAgent: z.infer<typeof commitSchema>;
  reporter: z.infer<typeof completionReportSchema>;
} & Record<SolverAgentId, z.infer<typeof proposalSchema>>;
/** Historical and future result keys remain readable at the persistence boundary. */
export type WorkflowResults = Partial<ResultByRole> &
  Partial<{ [K in Role as `previous_${K}`]: ResultByRole[K] }> &
  Record<string, unknown>;
export type AgentResult<R extends Role = Role> =
  (ResultByRole[R] & { type?: never }) | Question;
export type Contract = z.infer<typeof contractSchema>;
export type Question = z.infer<typeof questionSchema>;
export function parseResult<R extends Role>(
  role: R,
  value: unknown,
): AgentResult<R> {
  if (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === "QUESTION_REQUEST"
  )
    return questionSchema.parse(value);
  // The keyed schema map is checked above; Zod's indexed parse loses the key.
  return resultSchemas[role].parse(value) as ResultByRole[R];
}
export type OutputRecovery = {
  reason: "trailing_closing_delimiter";
  discardedLength: number;
  discardedPreview: string;
};

export type ParseTextOptions = {
  modelOutputTruncated?: boolean;
  onLocalRepair?: (event: LocalJsonRepairEvent) => void;
};

export function extractJsonCandidate(text: string): string {
  return text
    .trim()
    .replace(/^```(?:json)?\s*/, "")
    .replace(/\s*```$/, "");
}

function leadingJsonEnd(text: string): number | undefined {
  if (text[0] !== "{" && text[0] !== "[") return undefined;
  const closing: string[] = [text[0] === "{" ? "}" : "]"];
  let inString = false;
  let escaped = false;
  for (let i = 1; i < text.length; i++) {
    const char = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{" || char === "[")
      closing.push(char === "{" ? "}" : "]");
    else if (char === "}" || char === "]") {
      if (closing.pop() !== char) return undefined;
      if (closing.length === 0) return i + 1;
    }
  }
  return undefined;
}

export function parseText<R extends Role>(
  role: R,
  text: string,
  onRecovered?: (recovery: OutputRecovery) => void,
  options: ParseTextOptions = {},
): AgentResult<R> {
  const preview = redactVisibleText(text.slice(0, 2048));
  const candidate = extractJsonCandidate(text);
  let value: unknown;
  let originalFailure: AgentOutputError | undefined;
  try {
    value = JSON.parse(candidate);
  } catch (originalError) {
    originalFailure = new AgentOutputError(
      "parse",
      role,
      preview,
      false,
      redactVisibleText(String(originalError).slice(0, 500)),
    );
  }

  if (!originalFailure) {
    const inspection = inspectLocalJsonRepairCandidate(
      candidate,
      options.modelOutputTruncated,
    );
    if (!inspection.safe)
      originalFailure = new AgentOutputError(
        "parse",
        role,
        preview,
        false,
        inspection.diagnostic,
      );
    else
      try {
        return parseResult(role, value);
      } catch (error) {
        originalFailure = new AgentOutputError(
          "schema",
          role,
          preview,
          false,
          schemaDiagnostic(error),
        );
      }
  }

  const repaired = repairJsonLocally({
    candidate,
    originalFailureType:
      originalFailure!.kind === "schema" ? "schema" : "parse",
    ...(originalFailure!.kind === "schema"
      ? { originalParsedValue: value }
      : {}),
    modelOutputTruncated: options.modelOutputTruncated,
    validate: (candidateValue) => parseResult(role, candidateValue),
    onEvent: options.onLocalRepair,
  });
  if (repaired !== undefined) {
    const end = leadingJsonEnd(candidate);
    const trailing = end === undefined ? "" : candidate.slice(end);
    if (trailing && /^[\s}\]]+$/.test(trailing) && /[}\]]/.test(trailing))
      onRecovered?.({
        reason: "trailing_closing_delimiter",
        discardedLength: trailing.trimEnd().length,
        discardedPreview: trailing.trimEnd().slice(0, 32),
      });
    return repaired;
  }
  throw originalFailure!;
}

function schemaDiagnostic(error: unknown): string {
  if (!(error instanceof ZodError))
    return redactVisibleText(String(error)).slice(0, 1500);
  const issues = error.issues.slice(0, 12).map((issue) => {
    const path = issue.path.reduce<string>(
      (result, part) =>
        typeof part === "number"
          ? `${result}[${part}]`
          : result
            ? `${result}.${part}`
            : part,
      "",
    );
    const constraint =
      issue.code === "invalid_type"
        ? ` (expected ${issue.expected}, received ${issue.received})`
        : "";
    return `${path || "(root)"}: ${issue.message}${constraint}`;
  });
  if (error.issues.length > issues.length)
    issues.push(
      `... ${error.issues.length - issues.length} more issues omitted`,
    );
  const safe = redactVisibleText(issues.join("\n"));
  return safe.length > 1500 ? `${safe.slice(0, 1480)}… (truncated)` : safe;
}
