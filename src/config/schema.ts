import { z } from "zod";
import { roles, solverIds } from "../agents/schemas.ts";
import { httpMethods, localUrl } from "./http.ts";
import {
  commandCategories,
  hasUnsafeArgvToken,
  isForbiddenExecutable,
} from "../agents/command-policy.ts";
import { permissionPattern } from "../agents/path-policy.ts";
export const logicalRoles = [
  "orchestrator",
  "researcher",
  "solver",
  "critic",
  "reviewer",
  "implementor",
  "code-reviewer",
  "pentester",
  "security-reviewer",
  "tester",
  "commit-agent",
  "reporter",
] as const;
export const expectedRoles: Record<
  (typeof roles)[number],
  (typeof logicalRoles)[number]
> = {
  orchestrator: "orchestrator",
  researcher: "researcher",
  solver1: "solver",
  solver2: "solver",
  solver3: "solver",
  solver4: "solver",
  solver5: "solver",
  solver6: "solver",
  solver7: "solver",
  solver8: "solver",
  solver9: "solver",
  solver10: "solver",
  critic: "critic",
  reviewer: "reviewer",
  implementor: "implementor",
  codeReviewer: "code-reviewer",
  pentester: "pentester",
  securityReviewer: "security-reviewer",
  tester: "tester",
  commitAgent: "commit-agent",
  reporter: "reporter",
};
const agent = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    role: z.enum(logicalRoles),
    prompt: z.string().min(1),
    provider: z.string().min(1),
    model: z.string().min(1),
    temperature: z.number().finite().min(0).max(2).optional(),
    timeoutMs: z
      .union([z.literal(0), z.number().int().min(1000).max(86400000)])
      .optional(),
    requestTimeoutMs: z.number().int().min(0).optional(),
    maxToolCalls: z.number().int().min(0).optional(),
    doomLoop: z
      .object({
        enabled: z.boolean().optional(),
        windowSize: z.number().int().min(4).max(100).optional(),
        maxIdenticalCalls: z.number().int().min(2).max(100).optional(),
        maxRepeatedPattern: z.number().int().min(2).max(20).optional(),
        maxInterventions: z.number().int().min(1).max(10).optional(),
        maxToolCallsPerResponse: z.number().int().min(0).optional(),
        maxConsecutiveToolFailures: z.number().int().min(0).optional(),
        maxNoProgressToolCalls: z.number().int().min(0).optional(),
        steerPrompt: z.string().trim().min(1).max(4000).optional(),
      })
      .strict()
      .optional(),
    networkRetry: z
      .object({
        maxRetries: z.number().int().min(0).optional(),
        delayMs: z.number().int().min(100).max(60000).optional(),
      })
      .strict()
      .optional(),
    thinking: z
      .enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"])
      .default("off"),
  })
  .strict();
const gate = (enabled: boolean) =>
  z.object({ enabled: z.boolean().default(enabled) }).default({ enabled });
export const commandSchema = z
  .object({
    id: z.string().regex(/^[\w-]+$/),
    executable: z.string().min(1),
    args: z.array(z.string()),
    purpose: z.enum(commandCategories),
    timeoutMs: z.number().int().positive().max(600000).default(120000),
  })
  .strict()
  .superRefine((command, ctx) => {
    if (isForbiddenExecutable(command.executable))
      ctx.addIssue({
        code: "custom",
        message: "Direct Git and shell-wrapper commands are not allowed",
      });
    if (hasUnsafeArgvToken(command.executable, command.args))
      ctx.addIssue({
        code: "custom",
        message: "Command chaining and control characters are not allowed",
      });
  });
export const discoveredCommandSchema = z.object({
  command: commandSchema,
  source: z.string(),
  confidence: z.enum(["high", "medium", "low"]),
  category: z.enum([
    "test",
    "build",
    "lint",
    "typecheck",
    "static-analysis",
    "format-check",
    "other",
  ]),
});
const filePermissionPattern = z
  .string()
  .min(1)
  .superRefine((value, ctx) => {
    try {
      permissionPattern(value);
    } catch (error) {
      ctx.addIssue({ code: "custom", message: String(error) });
    }
  });
const staticCommandRuleSchema = z
  .object({
    executable: z.string().trim().min(1),
    argsPrefix: z.array(z.string()).default([]),
    allowRemainingArgs: z.boolean().default(false),
  })
  .strict()
  .superRefine((rule, ctx) => {
    if (
      rule.executable.startsWith("/") ||
      /^[A-Za-z]:[\\/]/.test(rule.executable) ||
      isForbiddenExecutable(rule.executable) ||
      hasUnsafeArgvToken(rule.executable, rule.argsPrefix) ||
      rule.argsPrefix.some((arg) => !arg || /[;&|`$<>]/.test(arg)) ||
      /[;&|`$<>\s]/.test(rule.executable)
    )
      ctx.addIssue({
        code: "custom",
        message: "Unsafe static command permission",
      });
  });
export const configSchema = z
  .object({
    workflow: z
      .object({
        solverCount: z.number().int().min(1).max(10).default(3),
        maxFullCycles: z.number().int().min(1).default(3),
        maxLocalFixCycles: z.number().int().min(0).default(5),
        maxPentestCycles: z.number().int().min(1).default(2),
        maxAgentFailures: z.number().int().min(1).default(2),
        maxQuestions: z.number().int().min(1).default(5),
        maxResearchClarifications: z.number().int().min(0).default(5),
        agentTimeoutMs: z
          .union([z.literal(0), z.number().int().min(1000).max(86400000)])
          .default(300000),
        requestTimeoutMs: z.number().int().min(0).optional(),
        networkRetry: z
          .object({
            maxRetries: z.number().int().min(0).default(10),
            delayMs: z.number().int().min(100).max(60000).default(3000),
          })
          .strict()
          .default({}),
        maxToolCalls: z.number().int().min(0).default(80),
        doomLoop: z
          .object({
            enabled: z.boolean().default(true),
            windowSize: z.number().int().min(4).max(100).default(12),
            maxIdenticalCalls: z.number().int().min(2).max(100).default(4),
            maxRepeatedPattern: z.number().int().min(2).max(20).default(3),
            maxInterventions: z.number().int().min(1).max(10).default(2),
            maxToolCallsPerResponse: z.number().int().min(0).default(32),
            maxConsecutiveToolFailures: z.number().int().min(0).default(8),
            maxNoProgressToolCalls: z.number().int().min(0).default(100),
            steerPrompt: z.string().trim().min(1).max(4000).optional(),
          })
          .strict()
          .default({}),
      })
      .default({}),
    qualityGates: z
      .object({
        codeReview: gate(true),
        pentest: gate(false),
        testing: gate(true),
        commit: gate(true),
      })
      .default({}),
    tester: z
      .object({
        mayModifyTests: z.boolean().default(false),
        testPaths: z.array(z.string()).default(["tests/", "test/"]),
      })
      .default({}),
    integrations: z
      .object({ serena: gate(true), context7: gate(true), web: gate(true) })
      .default({}),
    ui: z
      .object({
        progress: z
          .object({
            enabled: z.boolean().default(true),
            refreshMs: z.number().int().min(500).max(10000).default(2000),
            showToolActivity: z.boolean().default(true),
            showModels: z.boolean().default(false),
            showToolProvider: z.boolean().default(false),
          })
          .default({}),
      })
      .default({}),
    toolActivity: z
      .object({
        mappings: z
          .record(
            z
              .object({
                category: z.enum([
                  "web-search",
                  "web-research",
                  "documentation",
                  "mcp",
                  "tool",
                ]),
                provider: z
                  .string()
                  .regex(/^[A-Za-z][A-Za-z0-9 ._-]{0,31}$/)
                  .refine(
                    (value) =>
                      !/bearer|token|api.?key|secret|password/i.test(value),
                    "Provider label may not contain credential text",
                  )
                  .optional(),
              })
              .strict(),
          )
          .default({}),
      })
      .default({}),
    logging: z
      .object({
        agentLogs: z
          .object({
            level: z
              .enum(["off", "summary", "diagnostic", "trace"])
              .default("summary"),
          })
          .default({}),
      })
      .default({}),
    agents: z
      .object(
        Object.fromEntries(
          roles.map((r) => [
            r,
            solverIds.includes(r as any) ? agent.optional() : agent,
          ]),
        ) as Record<
          (typeof roles)[number],
          typeof agent | z.ZodOptional<typeof agent>
        >,
      )
      .strict(),
    commands: z.array(commandSchema).default([]),
    permissions: z
      .object({
        files: z
          .object({
            allowRead: z.array(filePermissionPattern).default([]),
            allowWrite: z.array(filePermissionPattern).default([]),
          })
          .strict()
          .default({}),
        commands: z
          .object({
            allow: z.array(staticCommandRuleSchema).default([]),
          })
          .strict()
          .default({}),
      })
      .strict()
      .default({}),
    execution: z
      .object({
        sandbox: z
          .object({
            mode: z.enum(["auto", "required", "none"]).default("auto"),
            network: z.enum(["deny", "allow"]).default("deny"),
            pentestNetwork: z.enum(["deny", "allow"]).default("deny"),
          })
          .strict()
          .default({}),
      })
      .strict()
      .default({}),
    commit: z.object({ runHooks: z.boolean().default(false) }).default({}),
    pentest: z
      .object({
        localUrls: z.array(z.string().url()).default([]),
        localHttp: z
          .object({
            allowedOrigins: z.array(z.string()).default([]),
            allowedMethods: z
              .array(z.enum(httpMethods))
              .min(1)
              .default(["GET"]),
            timeoutMs: z.number().int().min(1).max(60000).default(10000),
            maxRequestBodyBytes: z
              .number()
              .int()
              .min(0)
              .max(10485760)
              .default(1048576),
            maxResponseBodyBytes: z
              .number()
              .int()
              .min(1)
              .max(10485760)
              .default(2097152),
          })
          .default({}),
      })
      .default({}),
  })
  .strict()
  .superRefine((v, ctx) => {
    for (const slot of solverIds.slice(0, v.workflow.solverCount)) {
      const definition = v.agents[slot];
      if (!definition)
        ctx.addIssue({
          code: "custom",
          path: ["agents", slot],
          message: `workflow.solverCount=${v.workflow.solverCount} requires agents.solver1 through agents.solver${v.workflow.solverCount}. Missing agent configuration: ${slot}`,
        });
      else if (definition.role !== "solver")
        ctx.addIssue({
          code: "custom",
          path: ["agents", slot, "role"],
          message: `agents.${slot} must have role "solver" because workflow.solverCount=${v.workflow.solverCount}.`,
        });
    }
    for (const pattern of Object.keys(v.toolActivity.mappings))
      if (!/^[A-Za-z][A-Za-z0-9_.-]{0,79}\*?$/.test(pattern))
        ctx.addIssue({
          code: "custom",
          message: `Invalid tool activity pattern: ${pattern}`,
        });
    for (const slot of roles.filter(
      (role) => !solverIds.includes(role as any),
    )) {
      const definition = v.agents[slot];
      if (definition && definition.role !== expectedRoles[slot])
        ctx.addIssue({
          code: "custom",
          message: `Invalid role for ${slot}: expected ${expectedRoles[slot]}`,
        });
    }
    for (const command of v.commands) {
      if (isForbiddenExecutable(command.executable))
        ctx.addIssue({
          code: "custom",
          message: `Direct Git and shell-wrapper commands are not allowed: ${command.id}. Git mutations belong only to deterministic commit control.`,
        });
    }
    if (new Set(v.commands.map((c) => c.id)).size !== v.commands.length)
      ctx.addIssue({ code: "custom", message: "Command IDs must be unique" });
    for (const [values, originOnly] of [
      [v.pentest.localUrls, false],
      [v.pentest.localHttp.allowedOrigins, true],
    ] as const)
      for (const url of values)
        try {
          localUrl(url, originOnly);
        } catch {
          ctx.addIssue({
            code: "custom",
            message: "Pentest URLs must use explicit HTTP(S) loopback origins",
          });
        }
  })
  .transform(
    (config) =>
      config as typeof config & {
        agents: Record<(typeof roles)[number], z.infer<typeof agent>>;
      },
  );
export type TeamConfig = z.infer<typeof configSchema>;
export type Command = z.infer<typeof commandSchema>;
export type DiscoveredCommand = z.infer<typeof discoveredCommandSchema>;
