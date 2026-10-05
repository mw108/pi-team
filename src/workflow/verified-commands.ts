import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Command } from "../config/schema.ts";
import type { CommandEvidence } from "../agents/commands.ts";
import { commandKey } from "../agents/discovery.ts";
import { redactVisibleText } from "../agents/redaction.ts";
import { roles, type Role } from "../agents/schemas.ts";
import { gateSnapshot, head } from "./git.ts";
import type { WorkflowState } from "./state.ts";

export const verifiedCommandResultSchema = z.object({
  executionId: z.string().uuid(),
  command: z.object({
    id: z.string(),
    executable: z.string(),
    args: z.array(z.string()),
    purpose: z.string(),
  }),
  commandIdentity: z.string(),
  agent: z.enum(roles),
  attempt: z.number().int().positive(),
  exitCode: z.number().int(),
  output: z.string(),
  stdoutTail: z.string().optional(),
  stderrTail: z.string().optional(),
  completedAt: z.string(),
  repoState: z.object({
    head: z.string().nullable(),
    gateHashes: z.record(z.string()),
  }),
});
export type VerifiedCommandResult = z.infer<typeof verifiedCommandResultSchema>;

export async function repositoryEvidenceState(state: WorkflowState) {
  return { head: await head(state.cwd), gateHashes: await gateSnapshot(state) };
}

export async function recordVerifiedCommandResult(
  state: WorkflowState,
  command: Command,
  evidence: CommandEvidence,
  agent: Role,
  attempt: number,
): Promise<VerifiedCommandResult | undefined> {
  if (
    evidence.timedOut ||
    evidence.aborted ||
    evidence.exitCode < 0 ||
    !Number.isInteger(evidence.exitCode)
  )
    return;
  const repoState = await repositoryEvidenceState(state);
  return {
    executionId: randomUUID(),
    command: {
      id: command.id,
      executable: command.executable,
      args: [...command.args],
      purpose: command.purpose,
    },
    commandIdentity: commandKey(command),
    agent,
    attempt,
    exitCode: evidence.exitCode,
    output: redactVisibleText(evidence.output.slice(-4000)),
    stdoutTail: evidence.stdout
      ? redactVisibleText(evidence.stdout.slice(-4000))
      : undefined,
    stderrTail: evidence.stderr
      ? redactVisibleText(evidence.stderr.slice(-4000))
      : undefined,
    completedAt: evidence.completedAt ?? new Date().toISOString(),
    repoState,
  };
}

export function isVerifiedCommandResultCurrent(
  result: VerifiedCommandResult,
  current: Awaited<ReturnType<typeof repositoryEvidenceState>>,
): boolean {
  return (
    result.commandIdentity === commandKey(result.command) &&
    Number.isInteger(result.exitCode) &&
    result.repoState.head === current.head &&
    JSON.stringify(result.repoState.gateHashes) ===
      JSON.stringify(current.gateHashes)
  );
}

/** The latest complete execution wins for an exact argv identity. */
export function currentVerifiedCommandResults(
  state: WorkflowState,
  current: Awaited<ReturnType<typeof repositoryEvidenceState>>,
): VerifiedCommandResult[] {
  const latest = new Map<string, VerifiedCommandResult>();
  for (const result of state.verifiedCommandResults) {
    if (
      isVerifiedCommandResultCurrent(result, current) &&
      (!latest.has(result.commandIdentity) ||
        latest.get(result.commandIdentity)!.completedAt <= result.completedAt)
    )
      latest.set(result.commandIdentity, result);
  }
  return [...latest.values()];
}
