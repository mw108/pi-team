import { setTimeout as delay } from "node:timers/promises";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AssistantMessageEvent, Api, Model } from "@earendil-works/pi-ai";
import type { Role } from "./schemas.ts";
import type { TeamConfig } from "../config/schema.ts";

export interface ResolvedNetworkRetry {
  maxRetries: number; // 0 means unlimited.
  delayMs: number;
}

export function resolveNetworkRetry(
  config: TeamConfig,
  role: Role,
): ResolvedNetworkRetry {
  return {
    maxRetries:
      config.agents[role].networkRetry?.maxRetries ??
      config.workflow.networkRetry.maxRetries,
    delayMs:
      config.agents[role].networkRetry?.delayMs ??
      config.workflow.networkRetry.delayMs,
  };
}

export type NetworkRetryCategory = "transport" | "provider" | "rate_limit";
export type NetworkRetryEvent = {
  type:
    | "network_error"
    | "network_retry_scheduled"
    | "network_retry_started"
    | "network_recovered"
    | "network_retries_exhausted";
  retry: number;
  category: NetworkRetryCategory;
  message: string;
  delayMs?: number;
  maxRetries: number;
};

const transportCodes = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "EPIPE",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);

export function classifyRequestFailure(
  error: unknown,
): NetworkRetryCategory | undefined {
  const value = error as {
    status?: number;
    statusCode?: number;
    code?: string;
    cause?: unknown;
    message?: string;
  } | null;
  const status = value?.status ?? value?.statusCode;
  if (status === 429) return "rate_limit";
  if (status === 502 || status === 503 || status === 504) return "provider";
  if (typeof status === "number") return undefined;
  if (value?.code && transportCodes.has(value.code)) return "transport";
  if (value?.cause && classifyRequestFailure(value.cause) === "transport")
    return "transport";
  const message = value?.message ?? String(error);
  const http = /^(?:HTTP\s+)?(\d{3})\b/i.exec(message);
  if (http) {
    const code = Number(http[1]);
    if (code === 429) return "rate_limit";
    if ([502, 503, 504].includes(code)) return "provider";
    return undefined;
  }
  // Pi's provider adapters flatten SDK exceptions into assistant.errorMessage.
  // These exact SDK/adapter messages retain the transport meaning after codes are lost.
  if (
    /^(?:Connection error\.?|Network error\.?|Request timed out\.?|Provider finish_reason: network_error|Stream ended without finish_reason)$/i.test(
      message.trim(),
    )
  )
    return "transport";
  if (
    /\b(?:ECONNRESET|ECONNREFUSED|ECONNABORTED|EPIPE|ENETUNREACH|EHOSTUNREACH|ETIMEDOUT|EAI_AGAIN|UND_ERR_(?:CONNECT_TIMEOUT|SOCKET|HEADERS_TIMEOUT|BODY_TIMEOUT))\b|socket hang up|connection reset|connection closed unexpectedly|network unreachable|fetch failed|websocket (?:disconnect|closed)|SSE connection interrupted|temporary DNS/i.test(
      message,
    )
  )
    return "transport";
  return undefined;
}

function retryAfterMs(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  const ms = Number.isFinite(seconds)
    ? seconds * 1000
    : Date.parse(value) - Date.now();
  return Number.isFinite(ms) && ms > 0 ? ms : undefined;
}

function providerErrorEvent(
  model: Model<Api>,
  message: string,
  aborted = false,
): AssistantMessageEvent {
  const error = {
    role: "assistant" as const,
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: aborted ? ("aborted" as const) : ("error" as const),
    errorMessage: message,
    timestamp: Date.now(),
  };
  return { type: "error", reason: error.stopReason, error };
}

/** One retry owner for model requests. Pi session retry stays disabled and provider retries are set to zero. */
export function configureNetworkRetry(
  runtime: ModelRuntime,
  policy: ResolvedNetworkRetry,
  getSignal: () => AbortSignal | undefined,
  observe?: (event: NetworkRetryEvent) => void,
): void {
  const original = runtime.streamSimple.bind(runtime);
  runtime.streamSimple = (model, context, options) => {
    const result = createAssistantMessageEventStream();
    void (async () => {
      let retry = 0;
      let priorCategory: NetworkRetryCategory | undefined;
      for (;;) {
        const signal = getSignal();
        if (signal?.aborted) {
          result.push(providerErrorEvent(model, "Request aborted", true));
          return;
        }
        let retryAfter: number | undefined;
        const requestOptions = {
          ...options,
          signal,
          maxRetries: 0,
          fetch: async (...args: Parameters<typeof fetch>) => {
            const response = await (options?.fetch ?? globalThis.fetch)(
              ...args,
            );
            if (response.status === 429)
              retryAfter = retryAfterMs(response.headers.get("retry-after"));
            return response;
          },
        };
        let events: AssistantMessageEvent[] = [];
        try {
          for await (const event of original(model, context, requestOptions))
            events.push(event);
        } catch (error) {
          // A synchronous provider failure has no assistant event to forward.
          const category = classifyRequestFailure(error);
          if (!category || signal?.aborted) {
            result.push(
              providerErrorEvent(model, String(error), signal?.aborted),
            );
            return;
          }
          events = [providerErrorEvent(model, String(error))];
        }
        const terminal = events.at(-1);
        const category =
          terminal?.type === "error" && !signal?.aborted
            ? classifyRequestFailure(terminal.error?.errorMessage)
            : undefined;
        if (!category) {
          for (const event of events) result.push(event);
          result.end();
          if (retry > 0 && terminal?.type === "done")
            observe?.({
              type: "network_recovered",
              retry,
              category: priorCategory!,
              message: "connection recovered",
              maxRetries: policy.maxRetries,
            });
          return;
        }
        retry++;
        const message = String(
          terminal?.type === "error"
            ? terminal.error.errorMessage
            : "connection interrupted",
        ).slice(0, 300);
        observe?.({
          type: "network_error",
          retry,
          category,
          message,
          maxRetries: policy.maxRetries,
        });
        if (policy.maxRetries !== 0 && retry > policy.maxRetries) {
          observe?.({
            type: "network_retries_exhausted",
            retry: retry - 1,
            category,
            message,
            maxRetries: policy.maxRetries,
          });
          for (const event of events) result.push(event);
          result.end();
          return;
        }
        priorCategory = category;
        const delayMs =
          category === "rate_limit"
            ? (retryAfter ?? policy.delayMs)
            : policy.delayMs;
        observe?.({
          type: "network_retry_scheduled",
          retry,
          category,
          message,
          delayMs,
          maxRetries: policy.maxRetries,
        });
        try {
          await delay(delayMs, undefined, { signal });
        } catch {
          result.push(providerErrorEvent(model, "Request aborted", true));
          return;
        }
        observe?.({
          type: "network_retry_started",
          retry,
          category,
          message,
          maxRetries: policy.maxRetries,
        });
      }
    })();
    return result;
  };
}
