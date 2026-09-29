import { setTimeout as delay } from "node:timers/promises";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AssistantMessageEvent, Api, Model } from "@earendil-works/pi-ai";
import type { Role } from "./schemas.ts";
import type { TeamConfig } from "../config/schema.ts";
import {
  serializeErrorDiagnostics,
  type ErrorDiagnostics,
} from "./error-diagnostics.ts";

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

export type ProviderRequestEvent = {
  type:
    | "provider_request_start"
    | "provider_request_end"
    | "provider_request_failure";
  providerRequest: number;
  provider: string;
  model: string;
  api: string;
  networkRetry: number;
  requestStartedAt: string;
  requestDurationMs?: number;
  timeToFirstEventMs?: number;
  timeSinceLastActivityMs?: number;
  success?: boolean;
  error?: ErrorDiagnostics;
  classification?: NetworkRetryCategory | "other";
  matchedRule?: string | null;
  providerTimeouts?: {
    requestTimeoutMs?: number;
    maxRetries?: number;
    httpIdleTimeoutMs?: { value: number; source: string };
  };
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

/** Explain a classification without changing the retry classifier's decision. */
export function explainRequestFailure(error: unknown): {
  classification: NetworkRetryCategory | "other";
  matchedRule: string | null;
} {
  const category = classifyRequestFailure(error);
  if (!category) return { classification: "other", matchedRule: null };
  const walk = (value: unknown, depth = 0): string | null => {
    if (depth >= 5 || !value || typeof value !== "object") return null;
    const item = value as {
      code?: string;
      cause?: unknown;
      status?: number;
      statusCode?: number;
    };
    if (item.status === 429 || item.statusCode === 429) return "status=429";
    if ([502, 503, 504].includes(item.status ?? item.statusCode ?? 0))
      return `status=${item.status ?? item.statusCode}`;
    if (item.code && transportCodes.has(item.code))
      return `${depth ? "cause." : ""}code=${item.code}`;
    return walk(item.cause, depth + 1);
  };
  const message =
    typeof error === "string"
      ? error
      : (error as { message?: string })?.message;
  const rule =
    walk(error) ?? (typeof message === "string" ? `message=${category}` : null);
  return { classification: category, matchedRule: rule };
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
  observeRequest?: (event: ProviderRequestEvent) => void,
  now: () => number = Date.now,
): void {
  const original = runtime.streamSimple.bind(runtime);
  let requestNumber = 0;
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
        const providerRequest = ++requestNumber;
        const requestStarted = now();
        const requestStartedAt = new Date(requestStarted).toISOString();
        const identity = {
          providerRequest,
          provider: model.provider,
          model: model.id,
          api: model.api,
          networkRetry: retry,
          requestStartedAt,
        };
        const providerTimeouts = {
          ...(typeof options?.timeoutMs === "number"
            ? { requestTimeoutMs: options.timeoutMs }
            : {}),
          maxRetries: 0,
        };
        observeRequest?.({
          type: "provider_request_start",
          ...identity,
          providerTimeouts,
        });
        let rawError: unknown;
        let firstEventAt: number | undefined;
        let lastActivityAt: number | undefined;
        const requestOptions = {
          ...options,
          signal,
          maxRetries: 0,
          fetch: async (...args: Parameters<typeof fetch>) => {
            let response: Response;
            try {
              response = await (options?.fetch ?? globalThis.fetch)(...args);
            } catch (error) {
              rawError = error;
              throw error;
            }
            if (response.status === 429)
              retryAfter = retryAfterMs(response.headers.get("retry-after"));
            if (!response.ok || !response.body) return response;
            const reader = response.body.getReader();
            const body = new ReadableStream<Uint8Array>({
              async pull(controller) {
                try {
                  const next = await reader.read();
                  if (next.done) controller.close();
                  else controller.enqueue(next.value);
                } catch (error) {
                  rawError = error;
                  controller.error(error);
                }
              },
              cancel(reason) {
                return reader.cancel(reason);
              },
            });
            return new Response(body, {
              status: response.status,
              statusText: response.statusText,
              headers: response.headers,
            });
          },
        };
        let events: AssistantMessageEvent[] = [];
        try {
          for await (const event of original(model, context, requestOptions)) {
            const at = now();
            // Pi's "start" is emitted before an HTTP response. Terminal
            // "error"/"done" events are outcomes, not stream activity.
            if (
              event.type !== "start" &&
              event.type !== "error" &&
              event.type !== "done"
            ) {
              firstEventAt ??= at;
              lastActivityAt = at;
            }
            events.push(event);
          }
        } catch (error) {
          rawError ??= error;
          // A synchronous provider failure has no assistant event to forward.
          const category = classifyRequestFailure(error);
          if (!category || signal?.aborted) {
            events = [
              providerErrorEvent(model, String(error), signal?.aborted),
            ];
          } else {
            events = [providerErrorEvent(model, String(error))];
          }
        }
        const terminal = events.at(-1);
        const failed = terminal?.type === "error";
        const requestDurationMs = now() - requestStarted;
        const timing = {
          requestDurationMs,
          ...(firstEventAt === undefined
            ? {}
            : { timeToFirstEventMs: firstEventAt - requestStarted }),
          ...(lastActivityAt === undefined
            ? {}
            : { timeSinceLastActivityMs: now() - lastActivityAt }),
        };
        const diagnosticError = failed
          ? serializeErrorDiagnostics(
              rawError ??
                new Error(terminal.error.errorMessage ?? "Provider error"),
            )
          : undefined;
        // The retry decision below sees Pi's terminal errorMessage, which may
        // have already lost a transport cause. Report that exact decision input.
        const classification = failed
          ? explainRequestFailure(terminal.error.errorMessage)
          : undefined;
        if (failed)
          observeRequest?.({
            type: "provider_request_failure",
            ...identity,
            ...timing,
            error: diagnosticError,
            ...classification,
            providerTimeouts,
          });
        observeRequest?.({
          type: "provider_request_end",
          ...identity,
          ...timing,
          success: !failed,
        });
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
