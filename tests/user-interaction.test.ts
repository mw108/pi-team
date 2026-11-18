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
import { withTerminalPrompt } from "../src/integrations/approval-presentation.ts";

const commandApproval = {
  kind: "runtimeCommand" as const,
  title: "Pen-Tester requests command approval",
  prompt: "Command: node test.js",
  options: [
    { value: "allow_once", label: "Allow once", description: "One invocation" },
    { value: "deny", label: "Deny", description: "Do not run" },
  ],
};

function fixture(service?: TelegramService, terminal = true) {
  const handlers = new Map<string, ((value: unknown) => void)[]>();
  const localRequests: any[] = [];
  const notifications: string[] = [];
  let decision: string[] | undefined = ["deny"];
  const pi = {
    appendEntry(_type: string, data: unknown) {
      localRequests.push(data);
    },
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
  pi.events.on("pi-ask-user-telegram:notification-service:v1", (value) =>
    (value as any).accept({
      protocolVersion: 1,
      async notify(text: string) {
        notifications.push(text);
      },
    }),
  );
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
  const ctx = {
    mode: terminal ? "tui" : "print",
    hasUI: terminal,
    cwd: state.cwd,
    ui: {
      setWorkingVisible() {},
      custom: async () =>
        decision === undefined
          ? { cancelled: true }
          : {
              mode: "submit",
              cancelled: false,
              questions: [],
              answers: { approval: { values: decision } },
            },
    },
  } as unknown as ExtensionContext;
  const interaction = new UserInteractionService(pi, ctx, () => state);
  return {
    interaction,
    state,
    pi,
    ctx,
    localRequests,
    notifications,
    decide(values: string[] | undefined) {
      decision = values;
    },
  };
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

  assert.deepEqual(
    await interaction.approve({
      ...approval,
      prompt: "Command: node test.js\nTOKEN=secret-value",
    }),
    ["deny"],
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

test("missing shared approval service falls back; questions retain existing behavior", async () => {
  const missing = fixture();
  missing.decide([]);
  assert.deepEqual(
    await missing.interaction.approve({
      kind: "dirtyPaths",
      title: "Dirty paths",
      prompt: "Allow file?",
      options: [{ value: "allow", label: "Allow", description: "Exact file" }],
    }),
    [],
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

for (const prompt of [
  "Command: php tinker --execute=\"$user = App\\Models\\User::factory()->create(); $token='synthetic-token';\"",
  "Command: node --token=[REDACTED]",
  "x".repeat(65537),
])
  test("unsuitable Telegram payload uses real pi-ask adapter and sends only a generic notification", async () => {
    let remote = 0;
    const f = fixture({
      protocolVersion: 1,
      state: "RUNNING",
      pendingCount: 0,
      async request() {
        remote++;
        throw new Error("must not dispatch");
      },
    });
    f.decide(["allow_once"]);
    const approval = { ...commandApproval, prompt };
    assert.deepEqual(await f.interaction.approve(approval), ["allow_once"]);
    assert.equal(remote, 0);
    assert.equal(f.localRequests.length, 1);
    assert.equal(f.localRequests[0].params.questions[0].prompt, prompt);
    assert.deepEqual(f.notifications, [
      "Pi-Team requires local terminal approval",
    ]);
  });

test("memory-only local command details cannot be dispatched to Telegram or serialized", async () => {
  const f = fixture();
  const request = withTerminalPrompt(
    { ...commandApproval },
    "Full command: --token=synthetic-secret",
  );
  assert.doesNotMatch(JSON.stringify(request), /synthetic-secret/);
  await f.interaction.approve(request);
  assert.match(
    f.localRequests[0].params.questions[0].prompt,
    /synthetic-secret/,
  );
});

test("delivery failure revokes remote signal before local decision; late responses cannot change it", async () => {
  let remoteSignal: AbortSignal | undefined;
  let late!: (value: any) => void;
  const f = fixture({
    protocolVersion: 1,
    state: "RUNNING",
    pendingCount: 1,
    request(request, options) {
      remoteSignal = options?.signal;
      return new Promise((resolve, reject) => {
        late = () =>
          resolve({
            requestId: request.id,
            selectedOptionIds: ["allow_once"],
            cancelled: false,
          });
        reject(new Error("Could not send Telegram question"));
      });
    },
  });
  f.decide(["deny"]);
  assert.deepEqual(await f.interaction.approve(commandApproval), ["deny"]);
  assert.equal(remoteSignal?.aborted, true);
  late(undefined);
  assert.equal(f.localRequests.length, 1);
});

for (const selected of ["deny", "allow_once", "cancelled", "mismatched"]) {
  test(`returned Telegram ${selected} never opens a second channel`, async () => {
    const f = fixture({
      protocolVersion: 1,
      state: "RUNNING",
      pendingCount: 0,
      async request(request) {
        return {
          requestId: selected === "mismatched" ? "other-execution" : request.id,
          selectedOptionIds: [selected],
          cancelled: selected === "cancelled",
        };
      },
    });
    if (selected === "mismatched")
      await assert.rejects(
        f.interaction.approve(commandApproval),
        /correlation failed/,
      );
    else
      assert.deepEqual(
        await f.interaction.approve(commandApproval),
        selected === "cancelled" ? undefined : [selected],
      );
    assert.equal(f.localRequests.length, 0);
  });
}

test("unavailable terminal fails closed with actionable recovery guidance", async () => {
  const f = fixture(undefined, false);
  await assert.rejects(
    f.interaction.approve(commandApproval),
    /Local terminal approval unavailable.*\/team resume/,
  );
  assert.equal(f.localRequests.length, 0);
});

for (const state of ["STOPPED", "STARTING", "STOPPING", "FAILED"] as const) {
  test(`Telegram ${state} routes approval to terminal without dispatch`, async () => {
    const f = fixture({
      protocolVersion: 1,
      state,
      pendingCount: 0,
      async request() {
        assert.fail("unavailable service must not dispatch");
      },
    });
    f.decide(["allow_once"]);
    assert.deepEqual(await f.interaction.approve(commandApproval), [
      "allow_once",
    ]);
    assert.equal(f.localRequests.length, 1);
  });
}

test("a usable unanswered Telegram approval retains ownership until an explicit decision", async () => {
  let respond!: (value: any) => void;
  let requestId = "";
  const f = fixture({
    protocolVersion: 1,
    state: "RUNNING",
    pendingCount: 1,
    request(request) {
      requestId = request.id;
      return new Promise((resolve) => {
        respond = resolve;
      });
    },
  });
  const waiting = f.interaction.approve(commandApproval);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.localRequests.length, 0);
  respond({ requestId, selectedOptionIds: ["deny"], cancelled: false });
  assert.deepEqual(await waiting, ["deny"]);
  assert.equal(f.localRequests.length, 0);
});

test("terminal cancellation closes the SDK dialog and ignores subsequent approval", async () => {
  const f = fixture();
  const controller = new AbortController();
  let done!: (value: any) => void;
  let opened!: () => void;
  const ready = new Promise<void>((resolve) => {
    opened = resolve;
  });
  f.ctx.ui.custom = (async (factory: any) =>
    new Promise((resolve) => {
      done = resolve;
      factory({}, {}, {}, resolve);
      opened();
    })) as any;
  const result = f.interaction.approve(commandApproval, controller.signal);
  await ready;
  controller.abort();
  assert.equal(await result, undefined);
  done({ mode: "submit", answers: { approval: { values: ["allow_once"] } } });
  assert.equal(f.localRequests.length, 1);
});
