import { z } from "zod";
import { roles } from "../agents/schemas.ts";
import { httpMethods, localUrl } from "./http.ts";
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
  critic: "critic",
  reviewer: "reviewer",
  implementor: "implementor",
  codeReviewer: "code-reviewer",
  pentester: "pentester",
  securityReviewer: "security-reviewer",
  tester: "tester",
  commitAgent: "commit-agent",
};
const agent = z
  .object({
    role: z.enum(logicalRoles),
    prompt: z.string().min(1),
    provider: z.string().min(1),
    model: z.string().min(1),
    temperature: z.number().finite().min(0).max(2).optional(),
    timeoutMs: z
      .union([z.literal(0), z.number().int().min(1000).max(3600000)])
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
    purpose: z.enum(["development", "test", "static", "pentest"]),
    timeoutMs: z.number().int().positive().max(600000).default(120000),
  })
  .strict()
  .superRefine((command, ctx) => {
    const name = command.executable.split(/[\\/]/).at(-1)?.toLowerCase();
    if (
      [
        "git",
        "git.exe",
        "sh",
        "bash",
        "zsh",
        "fish",
        "pwsh",
        "powershell",
        "cmd",
        "cmd.exe",
        "eval",
      ].includes(name ?? "")
    )
      ctx.addIssue({
        code: "custom",
        message: "Direct Git and shell-wrapper commands are not allowed",
      });
    if (
      [command.executable, ...command.args].some(
        (v) => /[\0\r\n]/.test(v) || /^(?:&&|\|\||;|\||&)$/u.test(v),
      )
    )
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
export const configSchema = z
  .object({
    workflow: z
      .object({
        maxFullCycles: z.number().int().min(1).default(3),
        maxLocalFixCycles: z.number().int().min(0).default(5),
        maxPentestCycles: z.number().int().min(1).default(2),
        maxAgentFailures: z.number().int().min(1).default(2),
        maxQuestions: z.number().int().min(1).default(5),
        agentTimeoutMs: z
          .union([z.literal(0), z.number().int().min(1000).max(3600000)])
          .default(300000),
        maxToolCalls: z.number().int().min(1).default(80),
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
          .object({ level: z.enum(["off", "summary"]).default("summary") })
          .default({}),
      })
      .default({}),
    agents: z
      .object(
        Object.fromEntries(roles.map((r) => [r, agent])) as Record<
          (typeof roles)[number],
          typeof agent
        >,
      )
      .strict(),
    commands: z.array(commandSchema).default([]),
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
    for (const pattern of Object.keys(v.toolActivity.mappings))
      if (!/^[A-Za-z][A-Za-z0-9_.-]{0,79}\*?$/.test(pattern))
        ctx.addIssue({
          code: "custom",
          message: `Invalid tool activity pattern: ${pattern}`,
        });
    for (const slot of roles) {
      const definition = v.agents[slot];
      if (definition && definition.role !== expectedRoles[slot])
        ctx.addIssue({
          code: "custom",
          message: `Invalid role for ${slot}: expected ${expectedRoles[slot]}`,
        });
    }
    for (const command of v.commands) {
      const executable = command.executable
        .split(/[\\/]/)
        .at(-1)
        ?.toLowerCase();
      if (
        [
          "git",
          "git.exe",
          "sh",
          "bash",
          "zsh",
          "fish",
          "pwsh",
          "powershell",
          "cmd",
          "cmd.exe",
        ].includes(executable ?? "")
      )
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
  });
export type TeamConfig = z.infer<typeof configSchema>;
export type Command = z.infer<typeof commandSchema>;
export type DiscoveredCommand = z.infer<typeof discoveredCommandSchema>;
