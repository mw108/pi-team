import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { writeFile } from "node:fs/promises";
import { askApproval } from "../src/integrations/pi-ask.ts";
export default function smoke(pi: ExtensionAPI) {
  pi.registerCommand("ask-approval-smoke", {
    description:
      "Synthetic multi-select adapter check; no repository permissions granted",
    handler: async (_args, ctx) => {
      const values = await askApproval(pi, ctx, {
        kind: "commands",
        title: "Synthetic approval adapter test",
        prompt:
          "Synthetic test only: select both options. No real commands or permissions are approved.",
        options: [
          {
            value: "synthetic-test",
            label: "Synthetic test option",
            description: "No executable is associated with this option",
          },
          {
            value: "synthetic-lint",
            label: "Synthetic lint option",
            description: "No executable is associated with this option",
          },
        ],
      });
      const passed = Boolean(
        values?.includes("synthetic-test") &&
        values?.includes("synthetic-lint"),
      );
      await writeFile(
        "/private/tmp/pi-team-approval-ui-validation.json",
        JSON.stringify(
          {
            at: new Date().toISOString(),
            mode: ctx.mode,
            values,
            passed,
            synthetic: true,
            noRealPermissionsGranted: true,
          },
          null,
          2,
        ) + "\n",
      );
      ctx.ui.notify(
        passed
          ? "pi-ask approval adapter PASS"
          : "pi-ask approval adapter FAIL",
        passed ? "info" : "error",
      );
      ctx.shutdown();
    },
  });
}
