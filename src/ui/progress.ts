import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { WorkflowState } from "../workflow/state.ts";
export function progress(ctx: ExtensionContext, state: WorkflowState) {
  ctx.ui.setStatus(
    "pi-team",
    `Team: ${state.phase} | design ${state.fullCycle}/${state.config.workflow.maxFullCycles}`,
  );
  ctx.ui.setWidget("pi-team", [
    `Team ${state.id.slice(0, 8)} — ${state.phase}`,
    `Design ${state.fullCycle}/${state.config.workflow.maxFullCycles} · local fixes ${state.localFixCycle}/${state.config.workflow.maxLocalFixCycles} · pentest ${state.pentestCycle}/${state.config.workflow.maxPentestCycles}`,
    ...(state.blocker ? [state.blocker] : []),
  ]);
}
