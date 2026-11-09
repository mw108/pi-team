import { test } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { WorkflowState } from "../src/workflow/state.ts";
import { TelegramNotifications } from "../src/integrations/telegram-notifications.ts";

test("terminal outcomes are deduplicated and send failures can be retried", async () => {
  const messages: string[] = [];
  let fail = true;
  const pi = {
    events: {
      emit(_channel: string, request: { accept: (service: unknown) => void }) {
        request.accept({
          protocolVersion: 1,
          async notify(text: string) {
            if (fail) throw new Error("offline");
            messages.push(text);
          },
        });
      },
    },
  } as unknown as ExtensionAPI;
  const notifications = new TelegramNotifications(pi);
  const state = {
    id: "workflow",
    cwd: "project",
    phase: "BLOCKED",
    blocker: "failed",
    history: [],
    config: { ui: { approvals: { transport: "telegram" } } },
  } as unknown as WorkflowState;
  await assert.rejects(notifications.outcome(state), /offline/);
  fail = false;
  await Promise.all([
    notifications.outcome(state),
    notifications.outcome(state),
  ]);
  await notifications.outcome(state);
  assert.equal(messages.length, 1);
  assert.match(messages[0], /Workflow: workflow/);
  state.phase = "ABORTED";
  await notifications.outcome(state);
  assert.equal(messages.length, 2);
});
