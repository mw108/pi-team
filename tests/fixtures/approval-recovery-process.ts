import teamExtension from "../../src/index.ts";
import { StateStore } from "../../src/workflow/persistence.ts";

const [cwd, workflowId, boundary] = process.argv.slice(2);
process.on("message", () => {}); // Keep the interrupted host alive until SIGKILL.
const commands = new Map<string, any>();
const save = StateStore.prototype.save;
const stop = async () => {
  process.send?.({ boundary });
  await new Promise(() => {});
};
StateStore.prototype.save = async function (state) {
  const reconciling =
    state.history.at(-1)?.event === "command_approval_recovery_required";
  if (reconciling && boundary === "during-reconciliation") await stop();
  await save.call(this, state);
  if (reconciling && boundary === "after-decision") await stop();
};
teamExtension({
  on() {},
  events: { emit() {} },
  appendEntry() {},
  registerCommand(name: string, definition: any) {
    commands.set(name, definition);
  },
} as any);
let finishing = false;
const ctx = {
  cwd,
  mode: "tui",
  hasUI: true,
  waitForIdle: async () => {},
  ui: {
    setStatus() {},
    setWidget() {},
    setWorkingVisible() {},
    async custom() {
      if (boundary === "before-decision") await stop();
      return {
        mode: "submit",
        cancelled: false,
        questions: [],
        answers: { approval: { values: ["allow_workflow"] } },
      };
    },
    notify(message: string) {
      if (finishing) return;
      finishing = true;
      void (async () => {
        const state = await new StateStore(cwd).load(workflowId);
        process.send?.({
          done: true,
          phase: state.phase,
          pending: state.pendingRuntimeCommands.length,
          grants: state.runtimeCommandApprovals.length,
          executions: state.executions.length,
          reconciled: state.history.filter(
            (e) => e.event === "command_approval_recovery_required",
          ).length,
          actionable: message.includes("/team-retry pentester recover"),
        });
        setImmediate(() => process.exit(0));
      })();
    },
  },
};
await commands.get("team").handler(`resume ${workflowId}`, ctx);
