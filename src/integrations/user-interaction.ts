import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { TeamConfig } from "../config/schema.ts";
import type { Question } from "../agents/schemas.ts";
import { redactVisibleText } from "../agents/redaction.ts";
import type { ApprovalRequest, WorkflowState } from "../workflow/state.ts";
import {
  askApproval as askTerminalApproval,
  askResearchQuestions as askTerminalResearchQuestions,
  askUser as askTerminalUser,
} from "./pi-ask.ts";

export const TELEGRAM_INTERACTION_DISCOVERY_CHANNEL =
  "pi-ask-user-telegram:interaction-service:v1";
export const TELEGRAM_INTERACTION_PROTOCOL_VERSION = 1;
const SELECT_NONE_OPTION_ID = "__pi_team_select_none__";

type TelegramRequest = {
  id: string;
  title: string;
  message: string;
  project?: string;
  options?: { id: string; label: string; description?: string }[];
  multiple?: boolean;
  allowText?: boolean;
  details?: string;
  timeoutMs?: number;
};
type TelegramResponse = {
  requestId: string;
  selectedOptionIds: string[];
  text?: string;
  cancelled: boolean;
};
export type TelegramService = {
  readonly protocolVersion: 1;
  readonly state: "STOPPED" | "STARTING" | "RUNNING" | "STOPPING" | "FAILED";
  readonly failure?: string;
  readonly pendingCount: number;
  request(
    request: TelegramRequest,
    options?: { signal?: AbortSignal },
  ): Promise<TelegramResponse>;
};

function discoverTelegramService(
  pi: ExtensionAPI,
): TelegramService | undefined {
  let service: TelegramService | undefined;
  pi.events.emit(TELEGRAM_INTERACTION_DISCOVERY_CHANNEL, {
    protocolVersion: TELEGRAM_INTERACTION_PROTOCOL_VERSION,
    accept(candidate: TelegramService) {
      if (
        !service &&
        candidate?.protocolVersion === TELEGRAM_INTERACTION_PROTOCOL_VERSION &&
        typeof candidate.request === "function"
      )
        service = candidate;
    },
  });
  return service;
}

function requireTelegramService(pi: ExtensionAPI) {
  const service = discoverTelegramService(pi);
  if (!service)
    throw new Error(
      "Pi-Team is configured for Telegram interaction, but pi-ask-user-telegram did not advertise the v1 shared interaction service. Install/enable a compatible pi-ask-user-telegram extension and restart Pi. No terminal approval was opened.",
    );
  if (service.state !== "RUNNING")
    throw new Error(
      `Pi-Team Telegram interaction is unavailable (${service.state})${service.failure ? `: ${service.failure}` : ". Check /telegram-status and restart Pi after correcting the configuration."} No terminal approval was opened.`,
    );
  return service;
}

function transport(config: TeamConfig) {
  return config.ui.approvals.transport;
}

function completeTelegramText(text: string, subject: string) {
  if (text.length > 65536)
    throw new Error(
      `Pi-Team ${subject} is too large to redact and represent completely in Telegram; nothing was sent`,
    );
  const redacted = redactVisibleText(text);
  if (redacted !== text)
    throw new Error(
      `Pi-Team ${subject} contains secret-like content that cannot be meaningfully reviewed through Telegram after redaction; nothing was sent`,
    );
  return redacted;
}

function fullApprovalDetails(request: ApprovalRequest) {
  if (
    request.prompt.length > 65536 ||
    request.options.some(
      (option) => option.label.length + option.description.length > 65536,
    )
  )
    throw new Error(
      "Pi-Team approval is too large to redact and represent completely in Telegram; no decision was requested",
    );
  return completeTelegramText(
    [
      `Pi-Team — ${request.title}`,
      "",
      request.prompt,
      "",
      "Decision options:",
      ...request.options.map(
        (option) =>
          `- ${option.label} [${option.value}] — ${option.description}`,
      ),
      "",
      "The displayed decision applies only to the pending Pi-Team request. Telegram does not execute commands or Git operations directly.",
    ].join("\n"),
    "approval",
  );
}

export class UserInteractionService {
  constructor(
    private readonly pi: ExtensionAPI,
    private readonly ctx: ExtensionContext,
    private readonly currentState: () => WorkflowState | undefined,
  ) {}

  private state() {
    const state = this.currentState();
    if (!state)
      throw new Error(
        "Pi-Team user interaction requested before workflow state was available",
      );
    return state;
  }

  async approve(
    request: ApprovalRequest,
    signal?: AbortSignal,
    state = this.state(),
  ) {
    if (transport(state.config) === "terminal")
      return askTerminalApproval(this.pi, this.ctx, request, signal);
    const interactionId = randomUUID();
    const multiple =
      request.kind === "commands" || request.kind === "dirtyPaths";
    const response = await requireTelegramService(this.pi).request(
      {
        id: interactionId,
        title: request.title,
        message: completeTelegramText(request.prompt, "approval"),
        project: basename(state.cwd),
        options: [
          ...request.options.map((option) => ({
            id: option.value,
            label: option.label,
            description: redactVisibleText(option.description),
          })),
          ...(multiple
            ? [
                {
                  id: SELECT_NONE_OPTION_ID,
                  label: "Select none / deny all",
                  description: "Submit without approving any listed item",
                },
              ]
            : []),
        ],
        multiple,
        allowText: true,
        details: fullApprovalDetails(request),
        timeoutMs: 0,
      },
      { signal },
    );
    if (response.requestId !== interactionId)
      throw new Error("Telegram interaction response correlation failed");
    if (response.cancelled) return undefined;
    if (response.text)
      throw new Error(
        "Approval requires selecting a listed decision; a custom Telegram response cannot grant permissions",
      );
    const rawSelected = [...new Set(response.selectedOptionIds)];
    if (rawSelected.includes(SELECT_NONE_OPTION_ID) && rawSelected.length !== 1)
      throw new Error(
        "Telegram returned a contradictory Pi-Team approval decision; no permission was granted",
      );
    const selected = rawSelected.includes(SELECT_NONE_OPTION_ID)
      ? []
      : rawSelected;
    if (
      (!multiple && selected.length !== 1) ||
      !selected.every((id) =>
        request.options.some((option) => option.value === id),
      )
    )
      throw new Error(
        "Telegram returned an invalid or stale Pi-Team approval decision; no permission was granted",
      );
    return selected;
  }

  async ask(question: Question, signal?: AbortSignal, state = this.state()) {
    if (transport(state.config) === "terminal")
      return askTerminalUser(this.pi, this.ctx, question, signal);
    const interactionId = randomUUID();
    const response = await requireTelegramService(this.pi).request(
      {
        id: interactionId,
        title: "Team requires input",
        message: completeTelegramText(
          `${question.question}\n\nReason:\n${question.reason}`,
          "question",
        ),
        project: basename(state.cwd),
        allowText: true,
        timeoutMs: 0,
      },
      { signal },
    );
    if (response.requestId !== interactionId)
      throw new Error("Telegram interaction response correlation failed");
    return !response.cancelled && response.text?.trim()
      ? response.text.trim()
      : undefined;
  }

  async askResearchQuestions(
    questions: string[],
    signal?: AbortSignal,
    state = this.state(),
  ): Promise<{ question: string; answer: string }[] | undefined> {
    if (transport(state.config) === "terminal")
      return askTerminalResearchQuestions(this.pi, this.ctx, questions, signal);
    const answers: { question: string; answer: string }[] = [];
    for (let index = 0; index < questions.length; index++) {
      const interactionId = randomUUID();
      const question = questions[index];
      const response = await requireTelegramService(this.pi).request(
        {
          id: interactionId,
          title: `Researcher clarification ${index + 1}/${questions.length}`,
          message: completeTelegramText(question, "research question"),
          project: basename(state.cwd),
          allowText: true,
          timeoutMs: 0,
        },
        { signal },
      );
      if (response.requestId !== interactionId)
        throw new Error("Telegram interaction response correlation failed");
      if (response.cancelled || !response.text?.trim()) return undefined;
      answers.push({ question, answer: response.text.trim() });
    }
    return answers;
  }

  status(config: TeamConfig) {
    if (transport(config) === "terminal")
      return "User interaction transport: terminal";
    const service = discoverTelegramService(this.pi);
    if (!service)
      return "User interaction transport: telegram\nTelegram service: UNAVAILABLE\nReason: compatible pi-ask-user-telegram shared service not found";
    return `User interaction transport: telegram\nTelegram service: ${service.state}${service.failure ? `\nReason: ${service.failure}` : ""}\nPending Telegram interactions: ${service.pendingCount}`;
  }
}
