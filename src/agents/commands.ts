import { spawn } from "node:child_process";
import { CommandOutputCollector } from "./command-output.ts";
import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TeamConfig, Command } from "../config/schema.ts";
import type { Role } from "./schemas.ts";
import {
  allowedCommandCategories,
  commandCategories,
  staticCommandMatches,
} from "./command-policy.ts";
import { commandKey } from "./discovery.ts";
import {
  normalizedRuntimeCommand,
  type RuntimeCommandRequest,
} from "./runtime-commands.ts";
import {
  prepareExecution,
  SandboxSetupError,
  sandboxSetupFailure,
  type SandboxDetails,
} from "./sandbox.ts";
export type RuntimeCommandApprover = (
  command: Command,
  request: RuntimeCommandRequest,
  signal?: AbortSignal,
) => Promise<"allow" | "deny" | "pending">;
export interface CommandEvidence {
  id: string;
  exitCode: number;
  output: string;
  stdout?: string;
  stderr?: string;
  timedOut?: boolean;
  durationMs?: number;
  sandbox: SandboxDetails;
}
export async function execute(
  command: Command,
  cwd: string,
  signal?: AbortSignal,
  sandboxConfig: TeamConfig["execution"]["sandbox"] = {
    mode: "auto",
    network: "deny",
    pentestNetwork: "deny",
  },
): Promise<CommandEvidence> {
  if (signal?.aborted) throw new Error("Command aborted");
  const startedAt = Date.now();
  const prepared = await prepareExecution(command, cwd, sandboxConfig);
  if (signal?.aborted) {
    await prepared.cleanup();
    throw new Error("Command aborted");
  }
  try {
    return await new Promise((resolve, reject) => {
      const child = spawn(prepared.executable, prepared.args, {
        cwd: prepared.cwd,
        env: prepared.env,
        shell: false,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
      const collector = new CommandOutputCollector();
      let timedOut = false;
      child.stdout.on("data", (data: Buffer) =>
        collector.write("stdout", data),
      );
      child.stderr.on("data", (data: Buffer) =>
        collector.write("stderr", data),
      );
      const kill = () => {
        try {
          if (child.pid && process.platform !== "win32")
            process.kill(-child.pid, "SIGKILL");
          else child.kill("SIGKILL");
        } catch {}
      };
      const timer = setTimeout(() => {
        collector.timeout();
        timedOut = true;
        kill();
      }, command.timeoutMs);
      signal?.addEventListener("abort", kill, { once: true });
      child.on("error", (e) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", kill);
        reject(
          prepared.sandbox.mode === "bubblewrap"
            ? new SandboxSetupError(`Bubblewrap could not start: ${e.message}`)
            : e,
        );
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", kill);
        const { output, stdout, stderr } = collector.finish();
        const setupFailure = sandboxSetupFailure(
          prepared.sandbox,
          code,
          stderr,
          timedOut,
        );
        if (setupFailure) {
          reject(setupFailure);
          return;
        }
        resolve({
          id: command.id,
          exitCode: code ?? -1,
          output,
          stdout,
          stderr,
          timedOut,
          durationMs: Math.max(0, Date.now() - startedAt),
          sandbox: prepared.sandbox,
        });
      });
    });
  } finally {
    await prepared.cleanup();
  }
}
export function commandTool(
  role: Role,
  config: TeamConfig,
  cwd: string,
  evidence: CommandEvidence[],
  runtimeApproval?: RuntimeCommandApprover,
  currentCommands?: () => Command[],
): ToolDefinition {
  const allowed = approvedCommandsForRole(role, config);
  return {
    name: "team_command",
    label: "Approved project command",
    description: `Execute an approved argv command by ID, or submit structured argv for static policy matching or user approval. Available IDs: ${allowed.map((c) => c.id).join(", ") || "none"}. Configured static rules: ${JSON.stringify(config.permissions.commands.allow)}. No shell interpolation.`,
    parameters: Type.Union([
      Type.Object({ id: Type.String() }),
      Type.Object({
        executable: Type.String(),
        args: Type.Array(Type.String()),
        purpose: Type.String(),
        category: Type.Optional(
          Type.Union(
            commandCategories.map((category) => Type.Literal(category)),
          ),
        ),
      }),
    ]),
    async execute(_id, params, signal) {
      const approvedNow = currentCommands?.() ?? allowed;
      let command: Command | undefined;
      if ("id" in (params as object)) {
        command = approvedNow.find(
          (c) => c.id === (params as { id: string }).id,
        );
        if (!command) throw new Error("Command not approved for this role");
      } else {
        const normalized = normalizedRuntimeCommand(params, role);
        command = approvedNow.find(
          (c) => commandKey(c) === commandKey(normalized.command),
        );
        if (
          !command &&
          config.permissions.commands.allow.some((rule) =>
            staticCommandMatches(rule, normalized.command),
          )
        )
          command = normalized.command;
        if (!command) {
          if (!runtimeApproval)
            throw new Error("Runtime command approval is unavailable");
          const decision = await runtimeApproval(
            normalized.command,
            normalized.request,
            signal,
          );
          if (decision !== "allow" || signal?.aborted) {
            const denied = {
              status: decision === "deny" ? "denied" : "pending",
              code:
                decision === "deny"
                  ? "COMMAND_APPROVAL_DENIED"
                  : "COMMAND_APPROVAL_PENDING",
              commandId: normalized.command.id,
            };
            return {
              content: [{ type: "text", text: JSON.stringify(denied) }],
              details: denied,
            };
          }
          command = normalized.command;
        }
      }
      const result = await execute(
        command,
        cwd,
        signal,
        config.execution.sandbox,
      );
      evidence.push(result);
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        details: result,
      };
    },
  };
}

/** Same role allowlist used by execution and observational logging. */
export function approvedCommandsForRole(role: Role, config: TeamConfig) {
  const categories = allowedCommandCategories(role);
  return config.commands.filter((command) =>
    categories.includes(command.purpose),
  );
}
export { localHttpTool } from "./http.ts";
