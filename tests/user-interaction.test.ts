import { test } from "node:test";
import assert from "node:assert/strict";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { config } from "./helpers.ts";
import { configSchema } from "../src/config/schema.ts";
import {
  TELEGRAM_INTERACTION_DISCOVERY_CHANNEL,
  UserInteractionService,
  type TelegramService,
} from "../src/integrations/user-interaction.ts";
import type { WorkflowState } from "../src/workflow/state.ts";

function fixture(service?: TelegramService) {
  const handlers = new Map<string, ((value: unknown) => void)[]>();
  const pi = {
    events: {
      emit(channel: string, value: unknown) {
        for (const handler of handlers.get(channel) ?? []) handler(value);
      },
      on(channel: string, handler: (value: unknown) => void) {
        const values = handlers.get(channel) ?? [];
        values.push(handler);
        handlers.set(channel, values);
        return () => {};
      },
    },
  } as unknown as ExtensionAPI;
  if (service)
    pi.events.on(TELEGRAM_INTERACTION_DISCOVERY_CHANNEL, (value) =>
      (value as { accept(service: TelegramService): void }).accept(service),
    );
  const state = {
    id: "workflow-id",
    cwd: "C:/project",
    config: {
      ...config(),
      ui: {
        ...config().ui,
        approvals: { transport: "telegram" as const },
      },
    },
  } as WorkflowState;
  const interaction = new UserInteractionService(
    pi,
    {} as ExtensionContext,
    () => state,
  );
  return { interaction, state };
}

test("approval transport defaults to terminal and rejects invalid values", () => {
  const base = config();
  assert.equal(base.ui.approvals.transport, "terminal");
  assert.equal(
    configSchema.parse({
      ...base,
      ui: { ...base.ui, approvals: { transport: "telegram" } },
    }).ui.approvals.transport,
    "telegram",
  );
  assert.throws(() =>
    configSchema.parse({
      ...base,
      ui: { ...base.ui, approvals: { transport: "email" } },
    }),
  );
});

test("telegram approval validates internal decision ids and never treats text as authorization", async () => {
  const requests: any[] = [];
  let response: any = {
    requestId: "",
    selectedOptionIds: ["allow_once"],
    cancelled: false,
  };
  const service: TelegramService = {
    protocolVersion: 1,
    state: "RUNNING",
    pendingCount: 0,
    async request(request) {
      requests.push(request);
      return { ...response, requestId: request.id };
    },
  };
  const { interaction } = fixture(service);
  const approval = {
    kind: "runtimeCommand" as const,
    title: "Implementor requests command approval",
    prompt: "Command: node test.js",
    options: [
      {
        value: "allow_once",
        label: "Allow once",
        description: "One invocation",
      },
      { value: "deny", label: "Deny", description: "Do not run" },
    ],
  };
  assert.deepEqual(await interaction.approve(approval), ["allow_once"]);
  assert.deepEqual(
    requests[0].options.map((option: any) => option.id),
    ["allow_once", "deny"],
  );
  assert.match(requests[0].details, /Command: node test\.js/);

  await assert.rejects(
    interaction.approve({
      ...approval,
      prompt: "Command: node test.js\nTOKEN=secret-value",
    }),
    /secret-like content.*nothing was sent/,
  );
  assert.equal(requests.length, 1);

  response = { selectedOptionIds: ["invented"], cancelled: false };
  await assert.rejects(
    interaction.approve(approval),
    /invalid or stale.*no permission was granted/i,
  );
  response = {
    selectedOptionIds: [],
    text: "yes, always",
    cancelled: false,
  };
  await assert.rejects(
    interaction.approve(approval),
    /custom Telegram response cannot grant permissions/,
  );
});

test("missing or failed shared service is actionable and does not fall back to terminal", async () => {
  const missing = fixture();
  await assert.rejects(
    missing.interaction.approve({
      kind: "dirtyPaths",
      title: "Dirty paths",
      prompt: "Allow file?",
      options: [{ value: "allow", label: "Allow", description: "Exact file" }],
    }),
    /did not advertise.*No terminal approval was opened/,
  );
  const failed = fixture({
    protocolVersion: 1,
    state: "FAILED",
    failure: "Telegram API HTTP 409",
    pendingCount: 0,
    async request() {
      throw new Error("not called");
    },
  });
  await assert.rejects(
    failed.interaction.ask({
      type: "QUESTION_REQUEST",
      blocking: true,
      question: "What?",
      reason: "Needed",
    }),
    /HTTP 409.*No terminal approval was opened/,
  );
  assert.match(
    failed.interaction.status(failed.state.config),
    /Telegram service: FAILED[\s\S]*HTTP 409/,
  );
});

test("dirty-path approvals preserve multi-select and explicit select-none semantics", async () => {
  let selected = ["a.txt", "b.txt"];
  const service: TelegramService = {
    protocolVersion: 1,
    state: "RUNNING",
    pendingCount: 0,
    async request(request) {
      assert.equal(request.multiple, true);
      assert.ok(
        request.options?.some(
          (option) => option.id === "__pi_team_select_none__",
        ),
      );
      return {
        requestId: request.id,
        selectedOptionIds: selected,
        cancelled: false,
      };
    },
  };
  const { interaction } = fixture(service);
  const request = {
    kind: "dirtyPaths" as const,
    title: "Dirty paths",
    prompt: "Select exact paths",
    options: ["a.txt", "b.txt"].map((path) => ({
      value: path,
      label: path,
      description: "Allow editing only",
    })),
  };
  assert.deepEqual(await interaction.approve(request), ["a.txt", "b.txt"]);
  selected = ["__pi_team_select_none__"];
  assert.deepEqual(await interaction.approve(request), []);
});

test("ordinary and research questions use correlated free-text Telegram responses", async () => {
  const service: TelegramService = {
    protocolVersion: 1,
    state: "RUNNING",
    pendingCount: 0,
    async request(request) {
      return {
        requestId: request.id,
        selectedOptionIds: [],
        text: request.title.startsWith("Researcher")
          ? `answer:${request.message}`
          : "ordinary answer",
        cancelled: false,
      };
    },
  };
  const { interaction } = fixture(service);
  assert.equal(
    await interaction.ask({
      type: "QUESTION_REQUEST",
      blocking: true,
      question: "Question",
      reason: "Reason",
    }),
    "ordinary answer",
  );
  assert.deepEqual(await interaction.askResearchQuestions(["One", "Two"]), [
    { question: "One", answer: "answer:One" },
    { question: "Two", answer: "answer:Two" },
  ]);
});

test("workflow abort is forwarded to the shared Telegram request", async () => {
  let observedAbort = false;
  const service: TelegramService = {
    protocolVersion: 1,
    state: "RUNNING",
    pendingCount: 0,
    request(request, options) {
      return new Promise((resolve) => {
        options?.signal?.addEventListener(
          "abort",
          () => {
            observedAbort = true;
            resolve({
              requestId: request.id,
              selectedOptionIds: [],
              cancelled: true,
            });
          },
          { once: true },
        );
      });
    },
  };
  const { interaction } = fixture(service);
  const controller = new AbortController();
  const answer = interaction.ask(
    {
      type: "QUESTION_REQUEST",
      blocking: true,
      question: "Question",
      reason: "Reason",
    },
    controller.signal,
  );
  controller.abort();
  assert.equal(await answer, undefined);
  assert.equal(observedAbort, true);
});
