import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import YAML from "yaml";
import { initTeam } from "../src/config/init.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configSchema } from "../src/config/schema.ts";
import { roles, type Role } from "../src/agents/schemas.ts";
import { git } from "../src/workflow/git.ts";
import { execute } from "../src/agents/commands.ts";
import type { WorkflowState } from "../src/workflow/state.ts";
import type { AgentRunner } from "../src/agents/runner.ts";
import type { MutationObserver } from "../src/agents/mutation-attribution.ts";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { effectiveConfig } from "../src/agents/discovery.ts";
export function config() {
  const defaults = YAML.parse(
    readFileSync(new URL("../templates/team.yaml", import.meta.url), "utf8"),
  );
  return configSchema.parse({
    agents: Object.fromEntries(
      roles
        .filter((r) => defaults.agents[r])
        .map((r) => [
          r,
          { ...defaults.agents[r], provider: "fixture", model: "fixture" },
        ]),
    ),
    integrations: {
      serena: { enabled: false },
      context7: { enabled: false },
      web: { enabled: false },
    },
    commands: [
      {
        id: "test",
        executable: process.execPath,
        args: ["--test", "tests/math.test.mjs"],
        purpose: "test",
      },
    ],
  });
}
export const research = {
  affectedFiles: ["math.js"],
  relevantSymbols: ["add"],
  architectureSummary: "Small ESM fixture",
  existingPatterns: [],
  dependencies: [],
  constraints: [],
  regressionRisks: [],
  externalSources: [],
  assumptions: [],
  unresolvedQuestions: [],
};
export const contract = {
  goal: "Fix addition",
  filesToModify: ["math.js"],
  filesToCreate: [],
  filesToDelete: [],
  requiredChanges: ["Use addition"],
  technicalDecisions: [],
  constraints: [],
  requiredTests: [
    {
      description: "addition remains covered",
      action: "existing" as const,
      file: "tests/math.test.mjs",
      scope: "unit" as const,
    },
  ],
  acceptanceCriteria: ["2 + 3 = 5"],
  knownRisks: [],
};
export const finding = {
  severity: "medium" as const,
  file: "math.js",
  line: 1,
  problem: "Incorrect operation",
  suggestedFix: "Use addition",
  requiresRedesign: false,
};
export function output(role: Role): any {
  if (role.startsWith("solver"))
    return {
      solverId: role,
      title: "Addition",
      approach: "Use +",
      filesToChange: ["math.js"],
      implementationPlan: ["Change operator"],
      advantages: [],
      disadvantages: [],
      risks: [],
      assumptions: [],
      requiredTests: ["test"],
    };
  switch (role) {
    case "orchestrator":
      return { requirements: ["Fix addition"], summary: "Fix arithmetic" };
    case "researcher":
      return research;
    case "critic":
      return {
        proposalCritiques: ["solver1", "solver2", "solver3"].map(
          (solverId) => ({ solverId, weaknesses: [], tradeoffs: [] }),
        ),
        crossProposalObservations: [],
        recommendedElements: ["Addition"],
        rejectedElements: [],
        unresolvedRisks: [],
      };
    case "reviewer":
      return contract;
    case "implementor":
      return {
        status: "IMPLEMENTED",
        summary: "Fixed addition",
        changedFiles: ["math.js"],
        checks: [],
      };
    case "codeReviewer":
      return { status: "APPROVED", findings: [] };
    case "pentester":
      return {
        status: "PASS",
        findings: [],
        coverage: ["Arithmetic only"],
        limitations: [],
      };
    case "securityReviewer":
      return { findings: [], summary: "No findings" };
    case "tester":
      return {
        status: "PASS",
        commands: [{ id: "test", exitCode: 0, output: "pass" }],
        failedAreas: [],
      };
    case "commitAgent":
      return { message: "fix(math): correct addition", files: ["math.js"] };
    case "reporter":
      return {
        summary: "Fixed addition",
        implemented: ["Fixed addition"],
        changedFiles: [],
        validation: [],
        notes: [],
        unresolvedIssues: [],
        commit: { created: false },
      };
  }
}
export async function repository() {
  const cwd = await mkdtemp(join(tmpdir(), "pi-team-test-"));
  await mkdir(join(cwd, "tests"));
  await writeFile(
    join(cwd, "package.json"),
    JSON.stringify({ type: "module" }),
  );
  await writeFile(
    join(cwd, "math.js"),
    "export const add = (a, b) => a - b;\n",
  );
  await writeFile(
    join(cwd, "tests/math.test.mjs"),
    "import assert from 'node:assert/strict';import {test} from 'node:test';import {add} from '../math.js';test('addition',()=>assert.equal(add(2,3),5));\n",
  );
  await git(cwd, ["init"]);
  await initTeam(cwd);
  await git(cwd, ["config", "user.name", "Pi Team Test"]);
  await git(cwd, ["config", "user.email", "pi-team-test@example.invalid"]);
  await git(cwd, ["add", "."]);
  await git(cwd, [
    "-c",
    "core.hooksPath=/dev/null",
    "commit",
    "-m",
    "test: fixture baseline",
  ]);
  return cwd;
}

/** Shut down Serena before Pi invalidates extension handlers or the project disappears. */
export async function disposeSerenaTestRuntime(
  cwd: string,
  session?: Pick<AgentSession, "extensionRunner" | "dispose">,
) {
  try {
    await session?.extensionRunner.emit({
      type: "session_shutdown",
      reason: "quit",
    });
  } finally {
    try {
      session?.dispose();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }
}

/** Keep temporary projects out of Serena's persistent user project registry. */
export async function isolateSerenaTestHome() {
  const home = await mkdtemp(join(tmpdir(), "pi-team-serena-home-"));
  const priorHome = process.env.SERENA_HOME;
  const priorDashboard = process.env.SERENA_BRIDGE_WEB_DASHBOARD;
  process.env.SERENA_HOME = home;
  process.env.SERENA_BRIDGE_WEB_DASHBOARD = "false";
  return {
    home,
    async dispose() {
      if (priorHome === undefined) delete process.env.SERENA_HOME;
      else process.env.SERENA_HOME = priorHome;
      if (priorDashboard === undefined)
        delete process.env.SERENA_BRIDGE_WEB_DASHBOARD;
      else process.env.SERENA_BRIDGE_WEB_DASHBOARD = priorDashboard;
      await rm(home, { recursive: true, force: true });
    },
  };
}
export class FixtureRunner implements AgentRunner {
  calls: Role[] = [];
  counts: Partial<Record<Role, number>> = {};
  constructor(
    readonly custom?: (
      role: Role,
      s: WorkflowState,
      count: number,
      mutationObserver?: MutationObserver,
    ) => Promise<any | undefined>,
  ) {}
  async run(role: Role, s: WorkflowState, ...extras: any[]) {
    this.calls.push(role);
    const count = (this.counts[role] = (this.counts[role] ?? 0) + 1);
    const mutationObserver = extras.at(-1) as MutationObserver | undefined;
    const value = await this.custom?.(role, s, count, mutationObserver);
    if (value !== undefined) return value;
    if (role === "implementor")
      await writeFile(
        join(s.cwd, "math.js"),
        "export const add = (a, b) => a + b;\n",
      );
    if (role === "tester") {
      const commands = await Promise.all(
        effectiveConfig(s)
          .commands.filter((c) => ["test", "static"].includes(c.purpose))
          .map((c) => execute(c, s.cwd)),
      );
      return {
        status: commands.every((c) => c.exitCode === 0) ? "PASS" : "FAIL",
        commands,
        failedAreas: commands.filter((c) => c.exitCode).map((c) => c.id),
        classification: "FIX_LOCAL",
      };
    }
    return output(role);
  }
}
