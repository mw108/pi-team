import { z } from "zod";
import { posix } from "node:path";
import { assertRelative } from "./permissions.ts";

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
export const pentestSchema = z
  .object({
    status: z.enum(["PASS", "FINDINGS", "BLOCKED"]),
    findings: z.array(pentestFindingSchema),
    coverage: strings,
    limitations: strings,
    blocker: pentestBlockerSchema.optional(),
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
export const testSchema = z.object({
  status: z.enum(["PASS", "FAIL"]),
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
});
export const commitSchema = z.object({ message: text, files: strings });
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
export const resultSchemas: Record<Role, z.ZodTypeAny> = {
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
};
export type Contract = z.infer<typeof contractSchema>;
export type Question = z.infer<typeof questionSchema>;
export function parseResult(role: Role, value: unknown): any {
  if (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === "QUESTION_REQUEST"
  )
    return questionSchema.parse(value);
  return resultSchemas[role].parse(value);
}
export type OutputRecovery = {
  reason: "trailing_closing_delimiter";
  discardedLength: number;
  discardedPreview: string;
};

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

export function parseText(
  role: Role,
  text: string,
  onRecovered?: (recovery: OutputRecovery) => void,
): any {
  const trimmed = text
    .trim()
    .replace(/^```(?:json)?\s*/, "")
    .replace(/\s*```$/, "");
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch (originalError) {
    const end = leadingJsonEnd(trimmed);
    const trailing = end === undefined ? "" : trimmed.slice(end);
    if (!trailing || !/^[\s}\]]+$/.test(trailing) || !/[}\]]/.test(trailing))
      throw originalError;
    try {
      value = JSON.parse(trimmed.slice(0, end));
    } catch {
      throw originalError;
    }
    const result = parseResult(role, value);
    onRecovered?.({
      reason: "trailing_closing_delimiter",
      discardedLength: trailing.length,
      discardedPreview: trailing.slice(0, 32),
    });
    return result;
  }
  return parseResult(role, value);
}
