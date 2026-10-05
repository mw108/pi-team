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
  const safeId = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(id)
    ? id
    : "[invalid command ID]";
  const summary: CommandSummary = {
    command: safeId,
    commandId: safeId,
  };
  if (!approved) return summary;
  summary.executable = redactVisibleText(approved.executable.slice(0, 512));
  summary.args = redactCommandArgs(
    approved.args.slice(0, 64).map((arg) => arg.slice(0, 512)),
  );
  summary.purpose = redactVisibleText(approved.purpose.slice(0, 128));
  return summary;
}

/** One safe representation for both resolved and malformed command attempts. */
export function sanitizeCommandForLog(
  input: unknown,
  approved?: Command,
): CommandSummary {
  if (approved) return commandSummary(approved.id, approved);
  const value =
    input && typeof input === "object"
      ? (input as Record<string, unknown>)
      : {};
  if (typeof value.id === "string") return commandSummary(value.id);
  return {
    command: "structured",
    commandId: "",
    ...(typeof value.executable === "string"
      ? { executable: redactVisibleText(value.executable.slice(0, 512)) }
      : {}),
    ...(Array.isArray(value.args)
      ? {
          args: redactCommandArgs(
            value.args
              .slice(0, 64)
              .map((arg) =>
                typeof arg === "string"
                  ? arg.slice(0, 512)
                  : "[invalid argument]",
              ),
          ),
        }
      : {}),
    ...(typeof value.purpose === "string"
      ? { purpose: redactVisibleText(value.purpose.slice(0, 128)) }
      : {}),
  };
}

export type CommandFailureCategory =
  | "validation"
  | "authorization"
  | "policy"
  | "sandbox_setup"
  | "execution"
  | "timeout"
  | "cancelled"
  | "internal";

/** Keep command outcomes compact while retaining the reason at summary level. */
export function commandOutcomeForLog(result: unknown, isError: boolean) {
  const envelope =
    result && typeof result === "object"
      ? (result as Record<string, unknown>)
      : {};
  const details =
    envelope.details && typeof envelope.details === "object"
      ? (envelope.details as Record<string, unknown>)
      : envelope;
  const content = Array.isArray(envelope.content) ? envelope.content : [];
  const firstText = content.find(
    (item) => item && typeof item === "object" && typeof item.text === "string",
  )?.text;
  const message = redactVisibleText(
    String(details.message ?? firstText ?? "Command failed").slice(0, 1000),
  );
  const status = details.status;
  if (status === "pending")
    return {
      success: null,
      authorization: { decision: "pending", source: "runtime" },
    };
  if (status === "denied")
    return {
      success: false,
      authorization: { decision: "denied", source: "runtime" },
      error: {
        category: "authorization" as const,
        code: "COMMAND_APPROVAL_DENIED",
        message: "Command approval denied",
      },
    };
  const exitCode =
    typeof details.exitCode === "number" ? details.exitCode : undefined;
  const timedOut = details.timedOut === true;
  const aborted = details.aborted === true;
  const output =
    typeof details.output === "string"
      ? redactVisibleText(details.output.slice(-2000))
      : undefined;
  if (exitCode !== undefined)
    return {
      success: exitCode === 0 && !timedOut && !aborted,
      processStarted: true,
      exitCode,
      ...(output ? { output } : {}),
      ...(details.authorization
        ? { authorization: details.authorization }
        : {}),
      ...(details.sandbox ? { sandbox: details.sandbox } : {}),
      ...(exitCode !== 0 || timedOut || aborted
        ? {
            error: {
              category: timedOut
                ? ("timeout" as const)
                : aborted
                  ? ("cancelled" as const)
                  : ("execution" as const),
              code: timedOut
                ? "COMMAND_TIMEOUT"
                : aborted
                  ? "COMMAND_CANCELLED"
                  : "NONZERO_EXIT",
              message: timedOut
                ? "Command timed out"
                : aborted
                  ? "Command cancelled"
                  : `Command exited with code ${exitCode}`,
            },
          }
        : {}),
    };
  if (!isError) return { success: true };
  const category: CommandFailureCategory = /sandbox|bubblewrap|seatbelt/i.test(
    message,
  )
    ? "sandbox_setup"
    : /abort|cancel/i.test(message)
      ? "cancelled"
      : /approv|denied|not allowed/i.test(message)
        ? "authorization"
        : /policy|not permitted/i.test(message)
          ? "policy"
          : /valid|argument|command id|executable|schema|parameters/i.test(
                message,
              )
            ? "validation"
            : /timed?\s*out/i.test(message)
              ? "timeout"
              : /spawn|ENOENT|EACCES|process/i.test(message)
                ? "execution"
                : "internal";
  const code =
    /unknown|not approved/i.test(message) && /command|id/i.test(message)
      ? "UNKNOWN_COMMAND_ID"
      : /executable|commandId|command id|missing/i.test(message)
        ? "INVALID_ARGUMENTS"
        : category.toUpperCase();
  return {
    success: false,
    processStarted: false,
    error: { category, code, message },
  };
}
export function formatCommandLine(
  command: Pick<Command, "id" | "executable" | "args" | "purpose">,
): string {
  const safe = commandSummary(command.id, command as Command);
  return [safe.executable!, ...(safe.args ?? [])]
    .map((part) => (/[\s"']/.test(part) ? JSON.stringify(part) : part))
    .join(" ");
}
