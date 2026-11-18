import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "../src/config/loader.ts";
import { UserInteractionService } from "../src/integrations/user-interaction.ts";
import { withTerminalPrompt } from "../src/integrations/approval-presentation.ts";
import type { WorkflowState } from "../src/workflow/state.ts";

// Run with Pi 1.4: pi --no-extensions -e ./scripts/approval-fallback-ui-smoke.ts
// Then /approval-fallback-smoke. No real permission or command is executed.
export default function smoke(pi: ExtensionAPI) {
  pi.registerCommand("approval-fallback-smoke", {
    description:
      "Synthetic Telegram-to-terminal approval through the live SDK UI",
    handler: async (_args, ctx) => {
      const { config } = await loadConfig(ctx.cwd);
      config.ui.approvals.transport = "telegram";
      const state = { cwd: ctx.cwd, config } as WorkflowState;
      const interaction = new UserInteractionService(pi, ctx, () => state);
      // Like /team, return the command handler before opening background UI.
      setTimeout(() => {
        void (async () => {
          try {
            const values = await interaction.approve(
              withTerminalPrompt(
                {
                  kind: "runtimeCommand",
                  title: "Synthetic Pen-Tester approval fallback",
                  prompt:
                    "Synthetic php tinker --execute= $token=[REDACTED]. No command will execute.",
                  options: [
                    {
                      value: "allow_once",
                      label: "Allow once",
                      description: "Synthetic only; no execution",
                    },
                    {
                      value: "deny",
                      label: "Deny",
                      description: "Synthetic denial",
                    },
                  ],
                },
                "Synthetic local full argv: php tinker --execute= $token='synthetic-token'. No command will execute.",
              ),
            );
            await writeFile(
              join(tmpdir(), "pi-team-fallback-ui-validation.json"),
              JSON.stringify(
                {
                  sdk: "1.4.0",
                  mode: ctx.mode,
                  hasUI: ctx.hasUI,
                  values,
                  background: true,
                  synthetic: true,
                  noRealPermissionsGranted: true,
                },
                null,
                2,
              ) + "\n",
            );
          } catch (error) {
            await writeFile(
              join(tmpdir(), "pi-team-fallback-ui-validation.json"),
              JSON.stringify({ error: String(error) }),
            );
          } finally {
            ctx.shutdown();
          }
        })();
      }, 50);
    },
  });
}
