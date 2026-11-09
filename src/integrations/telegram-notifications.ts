import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { basename } from "node:path";
import { createHash } from "node:crypto";
import { redactVisibleText } from "../agents/redaction.ts";
import type { WorkflowState } from "../workflow/state.ts";

const channel = "pi-ask-user-telegram:notification-service:v1";
type Service = { protocolVersion: 1; notify(text: string): Promise<void> };

/** Deduplicate within a session. A restart can cause a best-effort duplicate. */
export class TelegramNotifications {
  private sent = new Set<string>();
  private pending = new Set<string>();
  constructor(private readonly pi: ExtensionAPI) {}

  async outcome(state: WorkflowState): Promise<void> {
    if (
      state.config.ui.approvals.transport !== "telegram" ||
      !["BLOCKED", "ABORTED"].includes(state.phase)
    )
      return;
    const event = state.history.findLast(
      (e) =>
        e.event ===
        (state.phase === "BLOCKED" ? "blocked" : "workflow_aborted"),
    );
    const key = createHash("sha256")
      .update(JSON.stringify([state.id, state.phase, event, state.blocker]))
      .digest("hex");
    if (this.sent.has(key) || this.pending.has(key)) return;
    this.pending.add(key);
    try {
      let service: Service | undefined;
      this.pi.events.emit(channel, {
        protocolVersion: 1,
        accept(candidate: Service) {
          if (
            candidate?.protocolVersion === 1 &&
            typeof candidate.notify === "function"
          )
            service = candidate;
        },
      });
      if (!service)
        throw new Error(
          "Telegram notification service unavailable; update pi-ask-user-telegram and restart Pi.",
        );
      const reason = state.blocker ? `\n\nReason:\n${state.blocker}` : "";
      const guidance =
        state.phase === "BLOCKED"
          ? `\n\nReview the workflow with /team-status and use the recommended recovery command.`
          : "\n\nThe workflow was aborted; repository changes are preserved.";
      const message = redactVisibleText(
        `Pi-Team — Workflow ${state.phase.toLowerCase()}\n\nProject: ${basename(state.cwd)}\nWorkflow: ${state.id}\nPhase: ${state.phase}${reason}${guidance}`,
      );
      await service.notify(
        message.length > 4000
          ? `${message.slice(0, 3970)}\n\n[Message shortened.]`
          : message,
      );
      this.sent.add(key);
    } finally {
      this.pending.delete(key);
    }
  }
}
