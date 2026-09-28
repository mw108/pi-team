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
import { progress, renderProgress } from "./ui/progress.ts";
import { ProgressRuntime } from "./ui/runtime.ts";
import type { WorkflowState } from "./workflow/state.ts";
import { initTeam } from "./config/init.ts";
import { projectRoot } from "./config/project.ts";
import { AgentLogStore } from "./workflow/agent-logs.ts";
import { roles, type Role } from "./agents/schemas.ts";
export default function teamExtension(pi: ExtensionAPI) {
  let active:
    | {
        controller: AbortController;
        runtime: ProgressRuntime;
        state?: WorkflowState;
      }
    | undefined;
  pi.on("session_start", async (_event, ctx) => {
    try {
      await checkAskCompatibility();
    } catch (error) {
      ctx.ui.notify(String(error), "error");
    }
  });
  pi.on("session_shutdown", () => {
    active?.controller.abort();
    active?.runtime.cancel();
    active?.runtime.dispose();
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
      active?.controller.abort();
      active?.runtime.cancel();
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
        const root = await projectRoot(ctx.cwd),
          store = new StateStore(root),
          live = active?.state?.cwd === root ? active : undefined,
          state = args.trim()
            ? await store.load(args.trim())
            : (live?.state ?? (await store.latest()));
        if (state) {
          const runtime =
            live?.state?.id === state.id ? live.runtime : undefined;
          if (runtime) progress(ctx, state, runtime);
          ctx.ui.notify(
            `${renderProgress(state, runtime).join("\n")}${runtime ? "" : "\nLive runtime details unavailable outside the active session."}`,
            "info",
          );
        } else ctx.ui.notify("No team workflow in this repository.", "info");
      } catch (e) {
        ctx.ui.notify(String(e), "error");
      }
    },
  });
  pi.registerCommand("team-log", {
    description:
      "Inspect per-agent attempt logs: /team-log [agent [--attempt N]]",
    handler: async (args, ctx) => {
      try {
        const root = await projectRoot(ctx.cwd);
        const state =
          active?.state?.cwd === root
            ? active.state
            : await new StateStore(root).latest();
        if (!state) {
          ctx.ui.notify("No team workflow in this repository.", "info");
          return;
        }
        const parts = args.trim().split(/\s+/).filter(Boolean);
        if (
          parts.length &&
          (!roles.includes(parts[0] as Role) ||
            (parts.length !== 1 &&
              (parts.length !== 3 ||
                parts[1] !== "--attempt" ||
                !/^[1-9]\d*$/.test(parts[2]))))
        )
          throw new Error("Usage: /team-log [agent [--attempt N]]");
        const logs = new AgentLogStore(root);
        ctx.ui.notify(
          parts.length
            ? await logs.timeline(
                state.id,
                parts[0] as Role,
                parts[2] ? Number(parts[2]) : undefined,
              )
            : await logs.overview(state.id),
          "info",
        );
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
      const controller = new AbortController();
      const runtime = new ProgressRuntime(() => {
        if (runtime.state) progress(ctx, runtime.state, runtime);
      });
      active = { controller, runtime };
      controller.signal.addEventListener("abort", () => runtime.cancel(), {
        once: true,
      });
      try {
        const engine = new WorkflowEngine(ctx.cwd, new PiRunner(), {
          progress: (s) => runtime.bind(s),
          ask: (q) => askUser(pi, ctx, q),
          approve: (request) => askApproval(pi, ctx, request),
          agentEvent: (event) => runtime.event(event),
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
        active.state = state;
        runtime.configure(
          state.config.ui.progress.refreshMs,
          state.config.ui.progress.enabled,
        );
        runtime.bind(state);
        const result = await engine.run(state, controller.signal);
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
        runtime.dispose();
        active = undefined;
      }
    },
  });
}
