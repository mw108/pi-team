import { z } from "zod";

export const roles = [
  "orchestrator",
  "researcher",
  "solver1",
  "solver2",
  "solver3",
  "critic",
  "reviewer",
  "implementor",
  "codeReviewer",
  "pentester",
  "securityReviewer",
  "tester",
  "commitAgent",
] as const;
export type Role = (typeof roles)[number];
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
export const contractSchema = z.object({
  goal: text,
  filesToModify: strings,
  filesToCreate: strings,
  filesToDelete: strings,
  requiredChanges: strings,
  technicalDecisions: strings,
  constraints: strings,
  requiredTests: strings,
  acceptanceCriteria: strings,
  knownRisks: strings,
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
export const pentestSchema = z.object({
  findings: z.array(pentestFindingSchema),
  coverage: strings,
  limitations: strings,
});
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
    }),
  ),
  failedAreas: strings,
  classification: z.enum(["FIX_LOCAL", "FIX_DESIGN"]).optional(),
});
export const commitSchema = z.object({ message: text, files: strings });
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
  critic: critiqueSchema,
  reviewer: contractSchema,
  implementor: implementationSchema,
  codeReviewer: reviewSchema,
  pentester: pentestSchema,
  securityReviewer: securitySchema,
  tester: testSchema,
  commitAgent: commitSchema,
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
export function parseText(role: Role, text: string): any {
  const trimmed = text
    .trim()
    .replace(/^```(?:json)?\s*/, "")
    .replace(/\s*```$/, "");
  return parseResult(role, JSON.parse(trimmed));
}
