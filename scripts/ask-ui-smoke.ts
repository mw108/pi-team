import type {
  ExtensionAPI,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { packagePath } from "../src/integrations/resources.ts";
export default async function smoke(pi: ExtensionAPI) {
  let tool: ToolDefinition | undefined;
  const entry = pathToFileURL(
    packagePath("@eko24ive/pi-ask", "src/index.ts"),
  ).href;
  const factory = (await import(entry)).default;
  const wrapped = new Proxy(pi, {
    get(target, key) {
      if (key === "registerTool")
        return (definition: ToolDefinition) => {
          if (definition.name === "ask_user") tool = definition;
          target.registerTool(definition);
        };
      return Reflect.get(target, key);
    },
  });
  await factory(wrapped);
  const unsubscribe = pi.events.on("@eko24ive/pi-ask:started", (event: any) => {
    if (event.title !== "Synthetic integration test") return;
    setTimeout(
      () =>
        pi.events.emit("@eko24ive/pi-ask:submit", {
          version: 1,
          requestId: "synthetic-smoke-answer",
          flowId: event.flowId,
          response: {
            kind: "answer",
            mode: "submit",
            answers: {
              smoke: {
                values: ["tested"],
                note: "Synthetic test only; not a real user approval.",
              },
            },
          },
        }),
      300,
    );
  });
  pi.on("session_shutdown", () => {
    unsubscribe();
  });
  pi.registerCommand("ask-ui-smoke", {
    description:
      "Open a synthetic pi-ask form and submit through the documented in-process bridge",
    handler: async (_args, ctx) => {
      if (!tool) throw new Error("ask_user missing");
      const result = await tool.execute(
        "synthetic-smoke",
        {
          title: "Synthetic integration test",
          questions: [
            {
              id: "smoke",
              prompt: "Synthetic package validation only",
              options: [{ value: "tested", label: "Tested" }],
            },
          ],
        },
        undefined,
        undefined,
        ctx,
      );
      const details = result.details as any;
      const passed =
        !details.cancelled && details.answers?.smoke?.values?.[0] === "tested";
      await writeFile(
        "/private/tmp/pi-team-ask-validation.json",
        JSON.stringify(
          {
            at: new Date().toISOString(),
            mode: ctx.mode,
            passed,
            uiOpened: true,
            syntheticAnswer: true,
          },
          null,
          2,
        ) + "\n",
      );
      ctx.ui.notify(
        passed ? "pi-ask TUI smoke PASS" : "pi-ask TUI smoke FAIL",
        passed ? "info" : "error",
      );
      ctx.shutdown();
    },
  });
}
