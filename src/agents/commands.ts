import { spawn } from "node:child_process";
import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TeamConfig, Command } from "../config/schema.ts";
import type { Role } from "./schemas.ts";
export interface CommandEvidence {
  id: string;
  exitCode: number;
  output: string;
  stdout?: string;
  stderr?: string;
  timedOut?: boolean;
  durationMs?: number;
}
export async function execute(
  command: Command,
  cwd: string,
  signal?: AbortSignal,
): Promise<CommandEvidence> {
  if (signal?.aborted) throw new Error("Command aborted");
  const startedAt = Date.now();
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) =>
      ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "SHELL"].includes(key),
    ),
  );
  return new Promise((resolve, reject) => {
    const child = spawn(command.executable, command.args, {
      cwd,
      env,
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "",
      stdout = "",
      stderr = "",
      timedOut = false;
    const append = (data: Buffer) => {
      output = (output + data.toString()).slice(-50000);
    };
    child.stdout.on("data", (data) => {
      stdout = (stdout + data.toString()).slice(-50000);
      append(data);
    });
    child.stderr.on("data", (data) => {
      stderr = (stderr + data.toString()).slice(-50000);
      append(data);
    });
    const kill = () => {
      try {
        if (child.pid && process.platform !== "win32")
          process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {}
    };
    const timer = setTimeout(() => {
      output += "\nCommand timeout";
      timedOut = true;
      kill();
    }, command.timeoutMs);
    signal?.addEventListener("abort", kill, { once: true });
    child.on("error", (e) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", kill);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", kill);
      resolve({
        id: command.id,
        exitCode: code ?? -1,
        output,
        stdout,
        stderr,
        timedOut,
        durationMs: Math.max(0, Date.now() - startedAt),
      });
    });
  });
}
export function commandTool(
  role: Role,
  config: TeamConfig,
  cwd: string,
  evidence: CommandEvidence[],
): ToolDefinition {
  const purposes =
    role === "implementor"
      ? ["development", "test", "static"]
      : role === "tester"
        ? ["test", "static"]
        : role === "codeReviewer"
          ? ["static"]
          : role === "pentester"
            ? ["pentest"]
            : [];
  const allowed = config.commands.filter((c) => purposes.includes(c.purpose));
  return {
    name: "team_command",
    label: "Approved project command",
    description: `Execute an explicitly configured argv command. Available IDs: ${allowed.map((c) => c.id).join(", ") || "none"}. No shell interpolation.`,
    parameters: Type.Object({ id: Type.String() }),
    async execute(_id, params, signal) {
      const command = allowed.find(
        (c) => c.id === (params as { id: string }).id,
      );
      if (!command) throw new Error("Command not approved for this role");
      const result = await execute(command, cwd, signal);
      evidence.push(result);
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        details: result,
      };
    },
  };
}
export { localHttpTool } from "./http.ts";
