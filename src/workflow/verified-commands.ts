import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
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
    packageJsonHash: z.string().optional(),
  }),
});
export type VerifiedCommandResult = z.infer<typeof verifiedCommandResultSchema>;

export async function repositoryEvidenceState(state: WorkflowState) {
  const packageJsonHash = await readFile(join(state.cwd, "package.json"))
    .then((content) => createHash("sha256").update(content).digest("hex"))
    .catch(() => undefined);
  return {
    head: await head(state.cwd),
    gateHashes: await gateSnapshot(state),
    packageJsonHash,
  };
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
    (result.repoState.packageJsonHash === undefined ||
      result.repoState.packageJsonHash === current.packageJsonHash) &&
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

export type CommandOutcomeCategory =
  | "PASS"
  | "TEST_FAILURE"
  | "INVOCATION_ERROR"
  | "INFRASTRUCTURE_ERROR"
  | "INDETERMINATE";

export function classifyVerifiedCommand(result: VerifiedCommandResult): {
  category: CommandOutcomeCategory;
  reason: string;
} {
  if (result.exitCode === 0)
    return { category: "PASS", reason: "Command completed successfully" };
  const output = [result.output, result.stdoutTail, result.stderrTail].join(
    "\n",
  );
  if (
    /no tests found matching|unknown option:|invalid cli argument|unknown argument:/i.test(
      output,
    )
  )
    return {
      category: "INVOCATION_ERROR",
      reason:
        "Test runner rejected the invocation before running the requested tests",
    };
  if (
    /command timed out|test runner failed to initialize|connection refused|ECONNREFUSED/i.test(
      output,
    )
  )
    return {
      category: "INFRASTRUCTURE_ERROR",
      reason: "Validation environment or runner failed",
    };
  if (
    result.command.purpose === "test" &&
    /(?:\b\d+\s+(?:tests?|test files?)\s+failed\b|\btests?:\s*\d+\s+failed\b|AssertionError:)/i.test(
      output,
    )
  )
    return {
      category: "TEST_FAILURE",
      reason: "Test runner reported failing tests or assertions",
    };
  if (
    result.command.purpose === "test" &&
    result.command.args.includes("--test") &&
    /(?:^|\n)\s*(?:#|ℹ)\s*fail\s+[1-9]\d*\b/i.test(output)
  )
    return {
      category: "TEST_FAILURE",
      reason: "Node test runner reported failing tests",
    };
  if (result.command.purpose === "static" && /\berror TS\d+:/i.test(output))
    return {
      category: "TEST_FAILURE",
      reason: "Static validation reported source diagnostics",
    };
  return {
    category: "INDETERMINATE",
    reason: "Nonzero exit without a recognized validation outcome",
  };
}

type TestScope = {
  runner: "angular" | "vitest";
  files: string[];
  full: boolean;
};

async function testScope(
  result: VerifiedCommandResult,
  cwd: string,
): Promise<TestScope | undefined> {
  const { executable, args } = result.command;
  let invocation = [executable, ...args];
  if (
    executable === "npm" &&
    (args[0] === "test" || (args[0] === "run" && args[1] === "test"))
  ) {
    if (args.some((arg) => arg === "--")) return;
    try {
      const pkg = JSON.parse(await readFile(join(cwd, "package.json"), "utf8"));
      const script = pkg.scripts?.test;
      if (typeof script !== "string" || /[;&|`$]/.test(script)) return;
      invocation = script.trim().split(/\s+/);
    } catch {
      return;
    }
  }
  const joined = invocation.join(" ");
  const runner = /(?:^|\s)(?:ng|npx ng) test(?:\s|$)/.test(joined)
    ? "angular"
    : /(?:^|\s)(?:vitest|npx vitest)(?:\s+(?:run|watch))?(?:\s|$)/.test(joined)
      ? "vitest"
      : undefined;
  if (!runner) return;
  const includes = invocation.flatMap((arg, index) =>
    arg.startsWith("--include=")
      ? arg.slice(10).split(",")
      : arg === "--include"
        ? (invocation[index + 1] ?? "").split(",")
        : [],
  );
  if (
    invocation.some((arg) =>
      /^(?:--exclude|--testNamePattern|--project|--grep|--filter)(?:=|$)/.test(
        arg,
      ),
    )
  )
    return;
  const files = includes.filter(Boolean);
  const full =
    !files.length &&
    !invocation.some((arg) => /\.(?:spec|test)\.[cm]?[jt]sx?$/.test(arg));
  return { runner, files, full };
}

/** Only a later, current full-suite execution of the same runner can cover an invalid include. */
export async function supersedingInvocation(
  failed: VerifiedCommandResult,
  candidates: VerifiedCommandResult[],
  cwd: string,
): Promise<VerifiedCommandResult | undefined> {
  if (classifyVerifiedCommand(failed).category !== "INVOCATION_ERROR") return;
  const scope = await testScope(failed, cwd);
  if (
    !scope?.files.length ||
    scope.files.some(
      (file) => !/^[\w./-]+\.(?:spec|test)\.[cm]?[jt]sx?$/.test(file),
    )
  )
    return;
  for (const candidate of candidates) {
    // npm's script is part of the verification scope; older records without
    // its hash cannot establish what the command ran.
    if (candidate.command.executable === "npm") {
      const packageJsonHash = await readFile(join(cwd, "package.json"))
        .then((content) => createHash("sha256").update(content).digest("hex"))
        .catch(() => undefined);
      if (
        !packageJsonHash ||
        candidate.repoState.packageJsonHash !== packageJsonHash
      )
        continue;
    }
    if (
      candidate.agent !== "tester" ||
      candidate.exitCode !== 0 ||
      candidate.completedAt < failed.completedAt ||
      candidate.repoState.head !== failed.repoState.head ||
      JSON.stringify(candidate.repoState.gateHashes) !==
        JSON.stringify(failed.repoState.gateHashes)
    )
      continue;
    const coverage = await testScope(candidate, cwd);
    if (
      coverage?.runner === scope.runner &&
      coverage.full &&
      /(?:\bTests?\s+\d+\s+passed\b|\bTest Files?\s+\d+\s+passed\b)/i.test(
        candidate.output,
      )
    )
      return candidate;
  }
}
