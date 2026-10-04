import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
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
  interruptedMutationRecovery,
  recoveryAction,
} from "./workflow/recovery.ts";
import { roles, completionReportSchema, type Role } from "./agents/schemas.ts";
import { getAgentDisplayName } from "./ui/agent-name.ts";
import { inactiveSolverError } from "./config/solvers.ts";
import { formatErrorForPiNotification } from "./agents/error-message.ts";
import { redactVisibleText } from "./agents/redaction.ts";
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
  if (state.pendingRuntimeCommands?.length)
    return `Waiting for command approval (${state.pendingRuntimeCommands.length} request${state.pendingRuntimeCommands.length === 1 ? "" : "s"}). Run /team resume ${state.id} to review.`;
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
  type ActiveWorkflow = {
    controller: AbortController;
    runtime: ProgressRuntime;
    state?: WorkflowState;
    engine?: WorkflowEngine;
    task?: Promise<void>;
  };
  let active: ActiveWorkflow | undefined;
  let continuationPending = false;
  function launch(
    entry: ActiveWorkflow,
    run: () => Promise<WorkflowState>,
    ctx: ExtensionCommandContext,
    append = false,
  ) {
    const task = Promise.resolve()
      .then(run)
      .then(async (finished) => {
        if (append)
          pi.appendEntry("pi-team:workflow", {
            id: finished.id,
            phase: finished.phase,
          });
        ctx.ui.notify(
          await finalText(finished),
          finished.phase === "DONE"
            ? "info"
            : finished.phase === "BLOCKED"
              ? "error"
              : "warning",
        );
      })
      .catch((error) => {
        try {
          ctx.ui.notify(formatErrorForPiNotification(error), "error");
        } catch {
          // A closed UI must not leave the background task unhandled.
        }
      })
      .finally(() => {
        if (active === entry) active = undefined;
        try {
          entry.runtime.dispose();
        } catch {
          // Cleanup remains best effort after the workflow has settled.
        }
      });
    entry.task = task;
  }
  pi.on("session_start", async (_event, ctx) => {
    try {
      await checkAskCompatibility();
    } catch (error) {
      ctx.ui.notify(formatErrorForPiNotification(error), "error");
    }
  });
  pi.on("session_shutdown", async () => {
    const stopping = active;
    stopping?.controller.abort();
    stopping?.runtime.cancel();
    await stopping?.task;
    stopping?.runtime.dispose();
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
        ctx.ui.notify(formatErrorForPiNotification(error), "error");
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
        ctx.ui.notify(formatErrorForPiNotification(e), "error");
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
        if (
          active?.state &&
          active.state.cwd === root &&
          active.engine &&
          active.state.phase !== "BLOCKED"
        ) {
          await active.engine.abortAgent(active.state, role);
          ctx.ui.notify(
            `${getAgentDisplayName(active.state.config, role)} (${role}) abort requested.`,
            "info",
          );
        } else {
          const state = await new StateStore(root).latest();
          if (!state || interruptedMutationRecovery(state)?.agent !== role)
            throw new Error(
              `Agent "${role}" (${role}) is not currently running.`,
            );
          await new WorkflowEngine(root, new PiRunner(), {
            progress: () => {},
            ask: async () => undefined,
          }).abortInterruptedRecovery(state, role);
          ctx.ui.notify(
            `${getAgentDisplayName(state.config, role)} (${role}) recovery aborted; repository changes preserved.`,
            "info",
          );
        }
      } catch (e) {
        ctx.ui.notify(formatErrorForPiNotification(e), "error");
      }
    },
  });
  pi.registerCommand("team-retry", {
    description:
      "Retry an agent: /team-retry <agent-id> [keep|discard|override]",
    handler: async (args, ctx) => {
      let ownedRuntime: ProgressRuntime | undefined;
      try {
        const parts = args.trim().split(/\s+/).filter(Boolean);
        if (
          parts.length < 1 ||
          parts.length > 2 ||
          !roles.includes(parts[0] as Role) ||
          (parts[1] !== undefined &&
            parts[1] !== "keep" &&
            parts[1] !== "discard" &&
            parts[1] !== "override")
        )
          throw new Error(
            "Usage: /team-retry <agent-id> [keep|discard|override]",
          );
        const role = parts[0] as Role;
        const mode = parts[1] as "keep" | "discard" | "override" | undefined;
        if (continuationPending)
          throw new Error("Workflow continuation is in progress.");
        if (active && !active.state)
          throw new Error("Team workflow startup is still in progress.");
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
        runtime.bindSessions(engine.sessions);
        if (!active) ownedRuntime = runtime;
        const message = mode
          ? undefined
          : engine.retryConfirmation(state, role);
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
        const result = await engine.retryAgent(state, role, confirmed, mode);
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
          launch(active, () => engine.run(state, controller.signal), ctx);
          ownedRuntime = undefined;
        } catch (error) {
          runtime.dispose();
          active = undefined;
          throw error;
        }
      } catch (e) {
        ctx.ui.notify(formatErrorForPiNotification(e), "error");
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
      let launched = false;
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
        runtime.bindSessions(engine.sessions);
        active = { controller, runtime, state, engine };
        runtime.configure(
          state.config.ui.progress.refreshMs,
          state.config.ui.progress.enabled,
        );
        runtime.bind(state);
        launch(
          active,
          () => engine.continueBlocked(state, controller.signal),
          ctx,
        );
        launched = true;
      } catch (error) {
        ctx.ui.notify(formatErrorForPiNotification(error), "error");
      } finally {
        if (!launched) {
          runtime?.dispose();
          if (runtime && active?.runtime === runtime) active = undefined;
        }
        continuationPending = false;
      }
    },
  });
  pi.registerCommand("team-status", {
    description: "Show the latest persisted team workflow",
    handler: async (args, ctx) => {
      try {
        if (!args.trim() && active && !active.state) {
          ctx.ui.notify(
            "Team workflow is starting; no workflow state has been created yet.",
            "info",
          );
          return;
        }
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
            redactVisibleText(
              `${renderProgress(state, runtime, true).join("\n")}${runtime ? "" : "\nLive runtime details unavailable outside the active session."}${recovery ? `\n${recovery.reason}\nNext safe action: ${recoveryAction(recovery)}` : ""}\nCommands: /team-steer <agent-id> <message> · /team-abort <agent-id> · /team-retry <agent-id> [keep|discard|override] · /team-continue`,
            ),
            "info",
          );
        } else ctx.ui.notify("No team workflow in this repository.", "info");
      } catch (e) {
        ctx.ui.notify(formatErrorForPiNotification(e), "error");
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
        ctx.ui.notify(formatErrorForPiNotification(error), "error");
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
        if (parts.length) {
          const inactive = inactiveSolverError(state.config, parts[0]);
          if (inactive) throw new Error(inactive);
          if (
            parts[0].startsWith("solver") &&
            !state.config.agents[parts[0] as Role]
          )
            throw new Error(`Unknown agent ${parts[0]}`);
        }
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
        ctx.ui.notify(formatErrorForPiNotification(e), "error");
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
      if (active || continuationPending) {
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
      const controller = new AbortController();
      const runtime = new ProgressRuntime(() => {
        if (runtime.state) progress(ctx, runtime.state, runtime);
      });
      // Reserve ownership synchronously, before waitForIdle can yield to a
      // second /team invocation. The background task releases this same entry.
      const entry: ActiveWorkflow = { controller, runtime };
      active = entry;
      controller.signal.addEventListener("abort", () => runtime.cancel(), {
        once: true,
      });
      try {
        await ctx.waitForIdle();
        if (controller.signal.aborted)
          throw new Error("Team startup was stopped before workflow creation.");
        const engine = new WorkflowEngine(ctx.cwd, new PiRunner(), {
          progress: (s) => runtime.bind(s),
          ask: (q) => askUser(pi, ctx, q),
          askResearchQuestions: (questions) =>
            askResearchQuestions(pi, ctx, questions),
          approve: (request) => askApproval(pi, ctx, request),
          agentEvent: (event) => runtime.event(event),
        });
        runtime.bindSessions(engine.sessions);
        entry.engine = engine;
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
        entry.state = state;
        runtime.configure(
          state.config.ui.progress.refreshMs,
          state.config.ui.progress.enabled,
        );
        runtime.bind(state);
        launch(entry, () => engine.run(state, controller.signal), ctx, true);
      } catch (e) {
        ctx.ui.notify(formatErrorForPiNotification(e), "error");
        runtime.dispose();
        if (active === entry) active = undefined;
      }
    },
  });
}
