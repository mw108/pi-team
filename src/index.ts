import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config/loader.ts";
import { PiRunner } from "./agents/runner.ts";
import { WorkflowEngine } from "./workflow/engine.ts";
import { StateStore } from "./workflow/persistence.ts";
import {
  askUser,
  askApproval,
  askResearchQuestions,
  checkAskCompatibility,
} from "./integrations/pi-ask.ts";
import { doctor } from "./integrations/doctor.ts";
import { progress, renderProgress } from "./ui/progress.ts";
import { ProgressRuntime } from "./ui/runtime.ts";
import type { WorkflowState } from "./workflow/state.ts";
import { initTeam } from "./config/init.ts";
import { projectRoot } from "./config/project.ts";
import { AgentLogStore } from "./workflow/agent-logs.ts";
import {
  getWorkflowRecoveryPlan,
  recoveryAction,
} from "./workflow/recovery.ts";
import { roles, completionReportSchema, type Role } from "./agents/schemas.ts";
import { getAgentDisplayName } from "./ui/agent-name.ts";
import {
  buildCompletionReportInput,
  fallbackReport,
  renderReport,
  renderBlocked,
  type CompletionReportInput,
} from "./workflow/report.ts";
async function completionText(state: WorkflowState) {
  const report = state.results.reporter
    ? completionReportSchema.parse(state.results.reporter)
    : fallbackReport(
        (state.reportInput as CompletionReportInput | undefined) ??
          (await buildCompletionReportInput(state, true)),
      );
  return renderReport(report, state.reportFailure);
}
async function finalText(state: WorkflowState) {
  if (state.phase === "DONE") return completionText(state);
  if (state.phase === "BLOCKED")
    return renderBlocked(
      state,
      await getWorkflowRecoveryPlan(state, state.cwd),
    );
  if (state.phase === "WAITING_USER" && state.pendingResearchQuestions?.length)
    return `Researcher waiting for user clarification (${state.pendingResearchQuestions.length} questions). Run /team resume ${state.id} to answer them.`;
  return `Team ${state.phase}\nCurrent phase: ${state.phase}`;
}
export default function teamExtension(pi: ExtensionAPI) {
  let active:
    | {
        controller: AbortController;
        runtime: ProgressRuntime;
        state?: WorkflowState;
        engine?: WorkflowEngine;
      }
    | undefined;
  let continuationPending = false;
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
  const target = (args: string, command: string): Role => {
    const role = args.trim();
    if (!roles.includes(role as Role))
      throw new Error(`Usage: /${command} <agent-id>`);
    return role as Role;
  };
  pi.registerCommand("team-steer", {
    description:
      "Guide one running agent in its current session: /team-steer <agent-id> <message>",
    handler: async (args, ctx) => {
      try {
        const match = /^\s*(\S+)\s+/.exec(args);
        const message = match ? args.slice(match[0].length) : "";
        if (!match || !roles.includes(match[1] as Role) || !message.trim())
          throw new Error("Usage: /team-steer <agent-id> <message>");
        const root = await projectRoot(ctx.cwd);
        if (!active?.state || active.state.cwd !== root || !active.engine)
          throw new Error(
            `Agent "${active?.state ? getAgentDisplayName(active.state.config, match[1] as Role) : match[1]}" (${match[1]}) is not currently running.`,
          );
        await active.engine.steer(active.state, match[1] as Role, message);
        ctx.ui.notify(
          `Steering message queued for ${getAgentDisplayName(active.state.config, match[1] as Role)} (${match[1]}).`,
          "info",
        );
      } catch (e) {
        ctx.ui.notify(String(e), "error");
      }
    },
  });
  pi.registerCommand("team-abort", {
    description:
      "Stop one running agent without replacement: /team-abort <agent-id>",
    handler: async (args, ctx) => {
      try {
        const role = target(args, "team-abort");
        const root = await projectRoot(ctx.cwd);
        if (!active?.state || active.state.cwd !== root || !active.engine)
          throw new Error(
            `Agent "${active?.state ? getAgentDisplayName(active.state.config, role) : role}" (${role}) is not currently running.`,
          );
        await active.engine.abortAgent(active.state, role);
        ctx.ui.notify(
          `${getAgentDisplayName(active.state.config, role)} (${role}) abort requested.`,
          "info",
        );
      } catch (e) {
        ctx.ui.notify(String(e), "error");
      }
    },
  });
  pi.registerCommand("team-retry", {
    description: "Start a fresh attempt for one agent: /team-retry <agent-id>",
    handler: async (args, ctx) => {
      let ownedRuntime: ProgressRuntime | undefined;
      try {
        const role = target(args, "team-retry");
        const root = await projectRoot(ctx.cwd);
        if (active?.state && active.state.cwd !== root)
          throw new Error("Another repository has an active team workflow.");
        const state = active?.state ?? (await new StateStore(root).latest());
        if (!state) throw new Error("No team workflow in this repository.");
        const runtime =
          active?.runtime ??
          new ProgressRuntime(() => {
            if (runtime.state) progress(ctx, runtime.state, runtime);
          });
        const engine =
          active?.engine ??
          new WorkflowEngine(root, new PiRunner(), {
            progress: (s) => runtime.bind(s),
            ask: (q) => askUser(pi, ctx, q),
            askResearchQuestions: (questions) =>
              askResearchQuestions(pi, ctx, questions),
            approve: (request) => askApproval(pi, ctx, request),
            agentEvent: (event) => runtime.event(event),
          });
        if (!active) ownedRuntime = runtime;
        const message = engine.retryConfirmation(state, role);
        let confirmed = false;
        if (message) {
          const selected = await askApproval(pi, ctx, {
            kind: "manualRetry",
            title: `Retry ${getAgentDisplayName(state.config, role)}?`,
            prompt: message,
            options: [
              {
                value: "retry",
                label: "Retry",
                description: "Start a fresh agent attempt",
              },
              {
                value: "cancel",
                label: "Cancel",
                description: "Keep the current result",
              },
            ],
          });
          if (!selected?.includes("retry")) {
            ctx.ui.notify("Retry cancelled.", "info");
            return;
          }
          confirmed = true;
        }
        const result = await engine.retryAgent(state, role, confirmed);
        ctx.ui.notify(
          `${getAgentDisplayName(state.config, role)} (${role}) ${result === "prepared" ? "fresh attempt starting" : result === "queued" ? "retry queued" : "restarting"}.`,
          "info",
        );
        if (result !== "prepared") return;
        const controller = new AbortController();
        active = { controller, runtime, state, engine };
        runtime.configure(
          state.config.ui.progress.refreshMs,
          state.config.ui.progress.enabled,
        );
        runtime.bind(state);
        try {
          const finished = await engine.run(state, controller.signal);
          ctx.ui.notify(
            await finalText(finished),
            finished.phase === "BLOCKED" ? "error" : "info",
          );
        } finally {
          runtime.dispose();
          active = undefined;
        }
      } catch (e) {
        ctx.ui.notify(String(e), "error");
      } finally {
        ownedRuntime?.dispose();
      }
    },
  });
  pi.registerCommand("team-continue", {
    description:
      "Continue a blocked workflow from the next safe incomplete phase.",
    handler: async (args, ctx) => {
      if (args.trim()) {
        ctx.ui.notify("Usage: /team-continue", "error");
        return;
      }
      if (continuationPending || active) {
        ctx.ui.notify("Workflow is already continuing/running.", "warning");
        return;
      }
      continuationPending = true;
      let runtime: ProgressRuntime | undefined;
      try {
        const root = await projectRoot(ctx.cwd);
        const state = await new StateStore(root).latest();
        if (!state) throw new Error("No team workflow in this repository.");
        const plan = await getWorkflowRecoveryPlan(state, root);
        if (plan.kind !== "continue") throw new Error(plan.reason);
        await ctx.waitForIdle();
        runtime = new ProgressRuntime(() => {
          if (runtime?.state) progress(ctx, runtime.state, runtime);
        });
        const controller = new AbortController();
        const engine = new WorkflowEngine(root, new PiRunner(), {
          progress: (s) => runtime!.bind(s),
          ask: (q) => askUser(pi, ctx, q),
          askResearchQuestions: (questions) =>
            askResearchQuestions(pi, ctx, questions),
          approve: (request) => askApproval(pi, ctx, request),
          agentEvent: (event) => runtime!.event(event),
        });
        active = { controller, runtime, state, engine };
        runtime.configure(
          state.config.ui.progress.refreshMs,
          state.config.ui.progress.enabled,
        );
        runtime.bind(state);
        const finished = await engine.continueBlocked(state, controller.signal);
        ctx.ui.notify(
          await finalText(finished),
          finished.phase === "BLOCKED" ? "error" : "info",
        );
      } catch (error) {
        ctx.ui.notify(String(error), "error");
      } finally {
        runtime?.dispose();
        active = undefined;
        continuationPending = false;
      }
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
          const recovery =
            state.phase === "BLOCKED"
              ? await getWorkflowRecoveryPlan(
                  state,
                  root,
                  Boolean(live?.state?.id === state.id && live.engine),
                )
              : undefined;
          const runtime =
            live?.state?.id === state.id ? live.runtime : undefined;
          if (runtime) progress(ctx, state, runtime);
          ctx.ui.notify(
            `${renderProgress(state, runtime, true).join("\n")}${runtime ? "" : "\nLive runtime details unavailable outside the active session."}${recovery ? `\nNext safe action: ${recoveryAction(recovery)}` : ""}\nCommands: /team-steer <agent-id> <message> · /team-abort <agent-id> · /team-retry <agent-id> · /team-continue`,
            "info",
          );
        } else ctx.ui.notify("No team workflow in this repository.", "info");
      } catch (e) {
        ctx.ui.notify(String(e), "error");
      }
    },
  });
  pi.registerCommand("team-report", {
    description:
      "Show the latest completion report: /team-report [workflow-id]",
    handler: async (args, ctx) => {
      try {
        const id = args.trim();
        if (id && !/^[a-f0-9-]{36}$/.test(id))
          throw new Error("Usage: /team-report [workflow-id]");
        const root = await projectRoot(ctx.cwd);
        const store = new StateStore(root);
        const state = id
          ? await store.load(id)
          : active?.state?.cwd === root
            ? active.state
            : await store.latest();
        if (!state) {
          ctx.ui.notify("No team workflow in this repository.", "info");
          return;
        }
        ctx.ui.notify(
          state.phase === "DONE"
            ? await completionText(state)
            : state.phase === "BLOCKED"
              ? renderBlocked(state, await getWorkflowRecoveryPlan(state, root))
              : `Report is not final yet.\nCurrent phase: ${state.phase}`,
          "info",
        );
      } catch (error) {
        ctx.ui.notify(String(error), "error");
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
                state.config,
              )
            : await logs.overview(state.id, state.config),
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
          askResearchQuestions: (questions) =>
            askResearchQuestions(pi, ctx, questions),
          approve: (request) => askApproval(pi, ctx, request),
          agentEvent: (event) => runtime.event(event),
        });
        active.engine = engine;
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
          await finalText(result),
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
