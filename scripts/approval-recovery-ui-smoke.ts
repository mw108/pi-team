import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import teamExtension from "../src/index.ts";
import { PiRunner } from "../src/agents/runner.ts";
import { StateStore } from "../src/workflow/persistence.ts";
import { FixtureRunner } from "../tests/helpers.ts";

// Use only in a synthetic fixture repository created by approvalRecoveryFixture.
// Actual /team command handlers and SDK 1.4 TUI; deterministic agents, no model
// calls or replay of the fixture's php command. See README for the procedure.
export default function smoke(pi: ExtensionAPI) {
  const runner = new FixtureRunner();
  PiRunner.prototype.run = runner.run.bind(
    runner,
  ) as typeof PiRunner.prototype.run;
  teamExtension(pi);
  pi.registerCommand("approval-recovery-result", {
    description: "Record synthetic approval recovery results and exit",
    handler: async (_args, ctx) => {
      const state = await new StateStore(ctx.cwd).latest();
      await writeFile(
        join(tmpdir(), "pi-team-recovery-ui-validation.json"),
        JSON.stringify(
          {
            mode: ctx.mode,
            hasUI: ctx.hasUI,
            phase: state?.phase,
            pending: state?.pendingRuntimeCommands.length,
            calls: runner.counts,
            pentesterExecutions: state?.executions
              .filter((e) => e.agent === "pentester")
              .map((e) => ({ id: e.id, attempt: e.attempt, status: e.status })),
            reconciliationCount: state?.history.filter(
              (e) => e.event === "command_approval_recovery_required",
            ).length,
            synthetic: true,
            deterministicAgents: true,
            noStoredCommandReplayed: true,
          },
          null,
          2,
        ) + "\n",
      );
      ctx.shutdown();
    },
  });
}
