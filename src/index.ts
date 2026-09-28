import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config/loader.ts";
import { PiRunner } from "./agents/runner.ts";
import { WorkflowEngine } from "./workflow/engine.ts";
import { StateStore } from "./workflow/persistence.ts";
import {
  askUser,
  askApproval,
  checkAskCompatibility,
} from "./integrations/pi-ask.ts";
import { doctor } from "./integrations/doctor.ts";
import { progress } from "./ui/progress.ts";
import { initTeam } from "./config/init.ts";
import { projectRoot } from "./config/project.ts";
export default function teamExtension(pi: ExtensionAPI) {
  let active: AbortController | undefined;
  pi.on("session_start", async (_event, ctx) => {
    try {
      await checkAskCompatibility();
    } catch (error) {
      ctx.ui.notify(String(error), "error");
    }
  });
  pi.on("session_shutdown", () => {
    active?.abort();
  });
  pi.registerCommand("team-init", {
    description:
      "Create project-local Pi Team configuration and agent prompts; --repair adds missing files; --from-global copies compatible legacy settings",
    handler: async (args, ctx) => {
      try {
        const option = args.trim();
        if (!["", "--repair", "--from-global"].includes(option))
          throw new Error("Usage: /team-init [--repair|--from-global]");
        const result = await initTeam(
          ctx.cwd,
          option === "--repair"
            ? "repair"
            : option === "--from-global"
              ? "from-global"
              : "default",
        );
        ctx.ui.notify(
          `${result.message}\nProject: ${result.root}\nCreated:\n${result.created.join("\n") || "(none)"}\nExisting:\n${result.existing.join("\n") || "(none)"}`,
          "info",
        );
      } catch (error) {
        ctx.ui.notify(String(error), "error");
      }
    },
  });
  pi.registerCommand("team-stop", {
    description: "Interrupt the active team and preserve its state",
    handler: async (_args, ctx) => {
      active?.abort();
      ctx.ui.notify(
        "Team interruption requested; state will be saved.",
        "info",
      );
    },
  });
  pi.registerCommand("team-status", {
    description: "Show the latest persisted team workflow",
    handler: async (args, ctx) => {
      try {
        const store = new StateStore(await projectRoot(ctx.cwd)),
          state = args.trim()
            ? await store.load(args.trim())
            : await store.latest();
        if (state) {
          progress(ctx, state);
          ctx.ui.notify(
            `Workflow ${state.id}: ${state.phase}${state.blocker ? ` — ${state.blocker}` : ""}`,
            "info",
          );
        } else ctx.ui.notify("No team workflow in this repository.", "info");
      } catch (e) {
        ctx.ui.notify(String(e), "error");
      }
    },
  });
  pi.registerCommand("team", {
    description:
      "Start a deterministic team task; /team resume [workflow-id] to continue",
    handler: async (args, ctx) => {
      if (args.trim() === "doctor") {
        const result = await doctor(ctx.cwd);
        ctx.ui.notify(result.lines.join("\n"), result.ok ? "info" : "error");
        return;
      }
      if (active) {
        ctx.ui.notify("A team workflow is already active.", "warning");
        return;
      }
      if (!args.trim()) {
        ctx.ui.notify(
          "Usage: /team <task> or /team resume [workflow-id]",
          "info",
        );
        return;
      }
      await ctx.waitForIdle();
      active = new AbortController();
      try {
        const engine = new WorkflowEngine(ctx.cwd, new PiRunner(), {
          progress: (s) => progress(ctx, s),
          ask: (q) => askUser(pi, ctx, q),
          approve: (request) => askApproval(pi, ctx, request),
        });
        const [verb, id] = args.trim().split(/\s+/);
        let state;
        if (verb === "resume") {
          state = id
            ? await engine.store.load(id)
            : await engine.store.latest();
          if (!state) throw new Error("No persisted workflow");
          await engine.resumeReadonly(state);
        } else {
          const definition = await loadConfig(ctx.cwd);
          state = await engine.start(
            args.trim(),
            definition.config,
            definition,
          );
        }
        const result = await engine.run(state, active.signal);
        pi.appendEntry("pi-team:workflow", {
          id: result.id,
          phase: result.phase,
        });
        ctx.ui.notify(
          `Team ${result.phase}${result.commit ? ` · commit ${result.commit.hash.slice(0, 12)}` : ""}${result.blocker ? ` · ${result.blocker}` : ""}\nState: ${engine.store.path(result.id)}`,
          result.phase === "DONE"
            ? "info"
            : result.phase === "BLOCKED"
              ? "error"
              : "warning",
        );
      } catch (e) {
        ctx.ui.notify(String(e), "error");
      } finally {
        active = undefined;
      }
    },
  });
}
