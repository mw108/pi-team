import type { Command } from "../config/schema.ts";
import { redactVisibleText } from "./redaction.ts";

export interface CommandSummary {
  command: string;
  commandId: string;
  executable?: string;
  args?: string[];
  purpose?: string;
}

const sensitiveName =
  /^[\w-]*(?:password|passwd|token|secret|authorization|api[-_]?key|credential|credentials|access[-_]?token|auth[-_]?token)[\w-]*$/i;

/** Redact argv by flag identity, preserving the original argv for execution. */
export function redactCommandArgs(args: readonly string[]): string[] {
  let redactNext = false;
  let redactAfterBearer = false;
  return args.map((arg) => {
    if (redactNext) {
      redactNext = false;
      redactAfterBearer = /^Bearer$/i.test(arg);
      return "[REDACTED]";
    }
    if (redactAfterBearer) {
      redactAfterBearer = false;
      return "[REDACTED]";
    }
    const flag = /^(--?|\/)([\w-]+)(?:([=:])(.*))?$/.exec(arg);
    const define = /^-D([\w-]+)=(.*)$/.exec(arg);
    const name = define?.[1] ?? flag?.[2];
    if (name && sensitiveName.test(name)) {
      if (define) return `-D${name}=[REDACTED]`;
      if (flag?.[3]) return `${flag[1]}${name}${flag[3]}[REDACTED]`;
      redactNext = true;
      return arg;
    }
    return redactVisibleText(arg);
  });
}

/** Explicit allowlist from the resolved command; never copy LLM tool arguments. */
export function commandSummary(id: string, approved?: Command): CommandSummary {
  const summary: CommandSummary = { command: id, commandId: id };
  if (!approved) return summary;
  summary.executable = redactVisibleText(approved.executable);
  summary.args = redactCommandArgs(approved.args);
  summary.purpose = approved.purpose;
  return summary;
}
export function formatCommandLine(
  command: Pick<Command, "id" | "executable" | "args" | "purpose">,
): string {
  const safe = commandSummary(command.id, command as Command);
  return [safe.executable!, ...(safe.args ?? [])]
    .map((part) => (/[\s"']/.test(part) ? JSON.stringify(part) : part))
    .join(" ");
}
