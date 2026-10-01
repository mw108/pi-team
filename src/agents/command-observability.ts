import type { Command } from "../config/schema.ts";
import { redactVisibleText } from "./redaction.ts";

export interface CommandSummary {
  command: string;
  commandId: string;
  executable?: string;
  args?: string[];
  purpose?: string;
}

const sensitiveFlag =
  /^(?:(?:--?|\/)[\w-]*(?:password|token|secret|authorization|api[-_]?key|credential)[\w-]*|(?:Authorization|API_KEY|TOKEN|SECRET|PASSWORD))$/i;

/** Explicit allowlist from the resolved command; never copy LLM tool arguments. */
export function commandSummary(id: string, approved?: Command): CommandSummary {
  const summary: CommandSummary = { command: id, commandId: id };
  if (!approved) return summary;
  summary.executable = redactVisibleText(approved.executable);
  summary.args = approved.args.map((arg, index) =>
    (index > 0 && sensitiveFlag.test(approved.args[index - 1])) ||
    (index > 1 &&
      sensitiveFlag.test(approved.args[index - 2]) &&
      /^Bearer$/i.test(approved.args[index - 1]))
      ? "[REDACTED]"
      : redactVisibleText(arg),
  );
  summary.purpose = approved.purpose;
  return summary;
}
