import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  firstErrorCode,
  serializeErrorDiagnostics,
  type ErrorDiagnostics,
} from "./error-diagnostics.ts";

export type ModelPreflightState =
  | "checking"
  | "unloaded"
  | "loading"
  | "downloading"
  | "downloaded"
  | "sleeping"
  | "ready";
export type ModelPreflightEvent = {
  type:
    | "model_preflight_started"
    | "model_preflight_loading"
    | "model_preflight_polling"
    | "model_preflight_transient_error"
    | "model_status"
    | "model_preflight_progress"
    | "model_load_requested"
    | "model_preflight_ready"
    | "model_preflight_timeout"
    | "model_preflight_cancelled"
    | "model_preflight_failed"
    | "model_preflight_unsupported"
    | "model_preflight_sse_unsupported"
    | "model_preflight_explicit_load_unsupported"
    | "model_preflight_warmup_started"
    | "model_preflight_warmup_completed"
    | "model_preflight_warmup_failed";
  provider: string;
  model: string;
  status?: string;
  progress?: number;
  durationMs?: number;
  exitCode?: number;
  httpStatus?: number;
  lastErrorCode?: string;
  elapsedMs?: number;
  attempts?: number;
  phase?: PreflightPhase;
  explicitLoadingSupported?: boolean;
  eventuallyReady?: boolean;
  classification?: "transient" | "uncertain" | "permanent";
  error?: ErrorDiagnostics;
  message?: string;
};
export type ModelPreflightConfig = {
  coldStartTimeoutMs: number;
  pollIntervalMs: number;
  maxPollIntervalMs: number;
};
type PreflightPhase =
  | "inventory"
  | "explicit_load"
  | "warmup"
  | "readiness_poll"
  | "progress_stream";
export type ModelPreflightUpdate =
  | {
      kind: "model_preflight";
      model: string;
      state: ModelPreflightState;
      progress?: number;
      startedAt: number;
    }
  | { kind: "model_preflight_end" };

type Snapshot = {
  state: ModelPreflightState;
  progress?: number;
  exitCode?: number;
};
type Listener = (
  snapshot:
    | Snapshot
    | "load_requested"
    | Omit<ModelPreflightEvent, "provider" | "model">,
) => void;
type Shared = {
  controller: AbortController;
  listeners: Set<Listener>;
  promise: Promise<boolean>;
  latest?: Snapshot;
  waiters: number;
  deadline: number;
  attempts: number;
  phase: PreflightPhase;
  explicitLoadingSupported?: boolean;
  lastError?: unknown;
};
type RouterOptions = {
  fetch: typeof fetch;
  headers: Headers;
  signal?: AbortSignal;
  onEvent?: (event: ModelPreflightEvent) => void;
  onUpdate?: (update: ModelPreflightUpdate) => void;
  pollIntervalMs?: number;
  maxPollIntervalMs?: number;
  coldStartTimeoutMs?: number;
  /** Test seam and safety cap; workflow configuration intentionally does not expose it. */
  requestTimeoutMs?: number;
  now?: () => number;
};
type EndpointCapabilities = {
  modelsSse: "unknown" | "supported" | "unsupported";
  explicitModelLoad: "unknown" | "supported" | "unsupported";
};
const capabilities = new Map<string, boolean>();
const endpointCapabilities = new Map<string, EndpointCapabilities>();
const inFlight = new Map<string, Shared>();
const states = new Set([
  "unloaded",
  "loading",
  "loaded",
  "sleeping",
  "downloading",
  "downloaded",
]);
const defaultColdStartTimeoutMs = 600_000;
const defaultPollIntervalMs = 3_000;
const defaultMaxPollIntervalMs = 10_000;
const defaultRequestTimeoutMs = 300_000;

class PreflightHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "PreflightHttpError";
  }
}

class ModelPreflightTimeoutError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ModelPreflightTimeoutError";
  }
}

function errorEvidence(error: unknown): {
  classification: "transient" | "uncertain" | "permanent";
  code?: string;
  status?: number;
  diagnostic: ErrorDiagnostics;
} {
  const diagnostic = serializeErrorDiagnostics(error);
  let current: ErrorDiagnostics | undefined = diagnostic;
  let status: number | undefined;
  for (let depth = 0; current && depth < 5; depth++) {
    status ??= current.status ?? current.statusCode;
    current = current.cause;
  }
  if (error instanceof PreflightHttpError) status = error.status;
  const code = firstErrorCode(diagnostic);
  if (status === 429 || status === 502 || status === 503 || status === 504)
    return { classification: "transient", status, code, diagnostic };
  if (typeof status === "number")
    return { classification: "permanent", status, code, diagnostic };
  if (
    code &&
    /^(?:ECONNRESET|ECONNREFUSED|ECONNABORTED|EPIPE|ENETUNREACH|EHOSTUNREACH|ETIMEDOUT|EAI_AGAIN|UND_ERR_(?:CONNECT_TIMEOUT|SOCKET|HEADERS_TIMEOUT|BODY_TIMEOUT))$/.test(
      code,
    )
  )
    return { classification: "transient", code, diagnostic };
  const message = diagnostic.message ?? "";
  if (
    /socket hang up|connection reset|connection closed unexpectedly|network unreachable|temporary DNS/i.test(
      message,
    )
  )
    return { classification: "transient", code, diagnostic };
  if (/^fetch failed$/i.test(message.trim()))
    return {
      classification: "uncertain",
      code,
      diagnostic,
    };
  if (
    /AbortError|TimeoutError|timed out/i.test(`${diagnostic.name} ${message}`)
  )
    return { classification: "transient", code, diagnostic };
  return { classification: "permanent", code, diagnostic };
}

/** Router sends one JSON envelope per plain SSE data frame (no SSE event name). */
function sseStatus(
  data: string,
  model: string,
): { progress?: number; terminal: boolean } | undefined {
  let envelope: unknown;
  try {
    envelope = JSON.parse(data);
  } catch {
    return;
  }
  if (!envelope || typeof envelope !== "object") return;
  const event = envelope as Record<string, unknown>;
  if (event.model !== model || event.event !== "model_status") return;
  const payload = event.data;
  if (!payload || typeof payload !== "object") return;
  const status = payload as Record<string, unknown>;
  if (status.status !== "loading")
    return {
      terminal: status.status === "loaded" || status.status === "unloaded",
    };
  const progress = status.progress;
  if (!progress || typeof progress !== "object") return { terminal: false };
  const value = progress as Record<string, unknown>;
  if (typeof value.value !== "number" || !Number.isFinite(value.value))
    return { terminal: false };
  const fraction = Math.max(0, Math.min(1, value.value));
  const stages = Array.isArray(value.stages) ? value.stages : [];
  const index = stages.indexOf(value.current);
  return {
    progress: index >= 0 ? (index + fraction) / stages.length : fraction,
    terminal: false,
  };
}

/** Telemetry is deliberately fail-open; the caller continues polling /models. */
async function listenSse(
  response: Response,
  model: string,
  signal: AbortSignal,
  onStatus: (status: { progress?: number; terminal: boolean }) => void,
): Promise<void> {
  if (
    !response.ok ||
    !response.body ||
    !response.headers.get("content-type")?.includes("text/event-stream")
  ) {
    await response.body?.cancel().catch(() => {});
    return;
  }
  const reader = response.body.getReader();
  const cancel = () => void reader.cancel().catch(() => {});
  signal.addEventListener("abort", cancel, { once: true });
  if (signal.aborted) cancel();
  const decoder = new TextDecoder();
  let buffer = "";
  let fields: string[] = [];
  const dispatch = () => {
    if (fields.length) {
      const status = sseStatus(fields.join("\n"), model);
      if (status) onStatus(status);
      fields = [];
    }
  };
  try {
    while (!signal.aborted) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      if (buffer.length > 1024 * 1024) {
        buffer = "";
        fields = [];
        continue;
      }
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end).replace(/\r$/, "");
        buffer = buffer.slice(end + 1);
        if (!line) dispatch();
        else if (line.startsWith("data:"))
          fields.push(line.slice(5).trimStart());
      }
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}

/** Only the root and a final /v1 have a known Router management root. */
export function routerBaseUrl(baseUrl: string): URL | undefined {
  try {
    const url = new URL(baseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return;
    if (url.search || url.hash || url.username || url.password) return;
    const path = url.pathname.replace(/\/+$/, "");
    if (path !== "" && path !== "/v1") return;
    url.pathname = "/";
    return url;
  } catch {
    return;
  }
}

/** Pi's OpenAI client appends /chat/completions to its effective base URL. */
export function completionUrl(baseUrl: string): URL {
  const url = new URL(baseUrl);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/chat/completions`;
  return url;
}

type CatalogEntry = { id: string; status?: Record<string, unknown> };
function parseCatalog(value: unknown): CatalogEntry[] | undefined {
  if (!value || typeof value !== "object") return;
  const data = (value as { data?: unknown }).data;
  if (!Array.isArray(data)) return;
  if (
    !data.every(
      (entry) =>
        entry && typeof entry === "object" && typeof entry.id === "string",
    )
  )
    return;
  return data.map((entry) => ({
    id: entry.id,
    ...(entry.status &&
    typeof entry.status === "object" &&
    states.has(entry.status.value)
      ? { status: entry.status }
      : {}),
  }));
}

function progressOf(status: Record<string, unknown>): number | undefined {
  const progress = status.progress;
  if (!progress || typeof progress !== "object") return;
  const value = progress as Record<string, unknown>;
  if (
    typeof value.value === "number" &&
    Number.isFinite(value.value) &&
    value.value >= 0 &&
    value.value <= 1
  ) {
    const stages = Array.isArray(value.stages) ? value.stages : [];
    const index = stages.indexOf(value.current);
    return index >= 0 ? (index + value.value) / stages.length : value.value;
  }
  let done = 0;
  let total = 0;
  for (const file of Object.values(value)) {
    if (!file || typeof file !== "object") continue;
    const { done: part, total: size } = file as Record<string, unknown>;
    if (
      typeof part !== "number" ||
      typeof size !== "number" ||
      !Number.isFinite(part) ||
      !Number.isFinite(size) ||
      size <= 0
    )
      continue;
    done += part;
    total += size;
  }
  return total > 0 ? Math.max(0, Math.min(1, done / total)) : undefined;
}

function notify(shared: Shared, snapshot: Parameters<Listener>[0]) {
  if (typeof snapshot === "object" && "state" in snapshot)
    shared.latest = snapshot;
  for (const listener of shared.listeners) listener(snapshot);
}

function now(options: RouterOptions): number {
  return options.now ? options.now() : performance.now();
}

function elapsed(options: RouterOptions, shared: Shared): number {
  return Math.max(
    0,
    Math.round(
      (options.coldStartTimeoutMs ?? defaultColdStartTimeoutMs) -
        (shared.deadline - now(options)),
    ),
  );
}

function assertActive(
  options: RouterOptions,
  shared: Shared,
  model: string,
  cause?: unknown,
) {
  shared.controller.signal.throwIfAborted();
  if (now(options) >= shared.deadline)
    throw new ModelPreflightTimeoutError(
      `Model preflight cold-start deadline exceeded for ${model} after ${elapsed(options, shared)} ms`,
      cause === undefined ? undefined : { cause },
    );
}

type OpenBoundedResponse = {
  response: Response;
  signal: AbortSignal;
  release: () => void;
  assertWithinDeadline: () => void;
};

async function openBoundedResponse(
  input: URL,
  init: RequestInit,
  options: RouterOptions,
  shared: Shared,
  model: string,
): Promise<OpenBoundedResponse> {
  assertActive(options, shared, model);
  const parent = shared.controller.signal;
  const controller = new AbortController();
  const requestStartedAt = now(options);
  const remaining = Math.max(1, Math.floor(shared.deadline - requestStartedAt));
  const requestTimeout = Math.max(
    1,
    Math.min(remaining, options.requestTimeoutMs ?? defaultRequestTimeoutMs),
  );
  const requestDeadline = Math.min(
    shared.deadline,
    requestStartedAt + requestTimeout,
  );
  const abort = () => controller.abort(parent.reason);
  parent.addEventListener("abort", abort, { once: true });
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    clearTimeout(timer);
    parent.removeEventListener("abort", abort);
  };
  const timeoutError = () => {
    const timeout = new Error(
      `Model preflight HTTP request timed out after ${requestTimeout} ms`,
    );
    timeout.name = "TimeoutError";
    return timeout;
  };
  const timer = setTimeout(() => {
    controller.abort(timeoutError());
  }, requestTimeout);
  if (parent.aborted) abort();
  try {
    const response = await options.fetch(input, {
      ...init,
      signal: controller.signal,
    });
    return {
      response,
      signal: controller.signal,
      release,
      assertWithinDeadline: () => {
        if (controller.signal.aborted) controller.signal.throwIfAborted();
        if (now(options) >= requestDeadline) {
          const timeout = timeoutError();
          controller.abort(timeout);
          throw timeout;
        }
      },
    };
  } catch (error) {
    release();
    if (controller.signal.aborted) controller.signal.throwIfAborted();
    throw error;
  }
}

/** Owns one finite HTTP response until its required body has been consumed. */
async function boundedFetch<T>(
  input: URL,
  init: RequestInit,
  consume: (response: Response, signal: AbortSignal) => Promise<T>,
  options: RouterOptions,
  shared: Shared,
  model: string,
): Promise<T> {
  const request = await openBoundedResponse(
    input,
    init,
    options,
    shared,
    model,
  );
  try {
    const result = await consume(request.response, request.signal);
    request.assertWithinDeadline();
    return result;
  } catch (error) {
    if (request.signal.aborted) request.signal.throwIfAborted();
    throw error;
  } finally {
    if (request.response.body && !request.response.bodyUsed) {
      try {
        void request.response.body.cancel().catch(() => {});
      } catch {
        // A concurrently acquired reader already owns cleanup.
      }
    }
    request.release();
  }
}

async function jsonBody(
  response: Response,
  signal: AbortSignal,
  endpoint: string,
): Promise<unknown> {
  const text = await response.text();
  signal.throwIfAborted();
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Provider ${endpoint} returned malformed JSON`, {
      cause: error,
    });
  }
}

async function catalog(
  root: URL,
  options: RouterOptions,
  shared: Shared,
  model: string,
) {
  return boundedFetch(
    new URL("models", root),
    { headers: options.headers },
    async (response, signal) => {
      if (response.status === 404) return { supported: false as const };
      if (!response.ok)
        throw new PreflightHttpError(
          `Provider /models returned HTTP ${response.status}`,
          response.status,
        );
      const parsed = parseCatalog(await jsonBody(response, signal, "/models"));
      return parsed
        ? { supported: true as const, models: parsed }
        : { supported: false as const };
    },
    options,
    shared,
    model,
  );
}

async function warmup(
  url: URL,
  model: string,
  maxTokensField: "max_tokens" | "max_completion_tokens",
  options: RouterOptions,
  shared: Shared,
): Promise<void> {
  const startedAt = now(options);
  let httpStatus: number | undefined;
  notify(shared, {
    type: "model_preflight_warmup_started",
    phase: "warmup",
    elapsedMs: elapsed(options, shared),
  });
  try {
    httpStatus = await boundedFetch(
      url,
      {
        method: "POST",
        headers: new Headers({
          ...Object.fromEntries(options.headers),
          "Content-Type": "application/json",
        }),
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: "Hello" }],
          [maxTokensField]: 1,
          temperature: 0,
        }),
      },
      async (response, signal) => {
        if (response.status !== 200)
          throw new PreflightHttpError(
            `Fallback chat-completion warmup failed at ${url.pathname}: HTTP ${response.status}`,
            response.status,
          );
        const body = await jsonBody(response, signal, url.pathname);
        if (
          !body ||
          typeof body !== "object" ||
          !Array.isArray((body as { choices?: unknown }).choices) ||
          (body as { choices: unknown[] }).choices.length === 0
        )
          throw new Error(
            `Model warmup returned HTTP 200 but no chat-completion choices at ${url.pathname}`,
          );
        return response.status;
      },
      options,
      shared,
      model,
    );
    notify(shared, {
      type: "model_preflight_warmup_completed",
      durationMs: Math.max(0, Math.round(now(options) - startedAt)),
      elapsedMs: elapsed(options, shared),
      phase: "warmup",
      httpStatus: 200,
    });
  } catch (error) {
    const evidence = errorEvidence(error);
    notify(shared, {
      type: "model_preflight_warmup_failed",
      durationMs: Math.max(0, Math.round(now(options) - startedAt)),
      elapsedMs: elapsed(options, shared),
      phase: "warmup",
      httpStatus: httpStatus ?? evidence.status,
      lastErrorCode: evidence.code,
      classification: evidence.classification,
      error: evidence.diagnostic,
      message: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

async function runShared(
  root: URL,
  model: string,
  options: RouterOptions,
  shared: Shared,
  capabilityKey: string,
  completionUrl: URL,
  maxTokensField: "max_tokens" | "max_completion_tokens",
): Promise<boolean> {
  const signal = shared.controller.signal;
  const knownRouter = capabilities.get(capabilityKey) === true;
  const endpoints = endpointCapabilities.get(capabilityKey) ?? {
    modelsSse: "unknown",
    explicitModelLoad: "unknown",
  };
  endpointCapabilities.set(capabilityKey, endpoints);
  let models: CatalogEntry[] | undefined;
  let loadRequested = false;
  let latestPolled: Snapshot | undefined;
  let liveProgress: number | undefined;
  const sseController = new AbortController();
  let sseTask: Promise<void> | undefined;
  let sseAttempted = false;
  let wakePoll: (() => void) | undefined;
  let terminalObserved = false;
  let checks = 0;
  let pollInterval = options.pollIntervalMs ?? defaultPollIntervalMs;
  const maxPollInterval = Math.max(
    pollInterval,
    options.maxPollIntervalMs ?? defaultMaxPollIntervalMs,
  );
  let lastError: unknown;
  const transient = (error: unknown, phase: PreflightPhase) => {
    const evidence = errorEvidence(error);
    lastError = error;
    shared.lastError = error;
    shared.phase = phase;
    notify(shared, {
      type: "model_preflight_transient_error",
      phase,
      elapsedMs: elapsed(options, shared),
      attempts: checks,
      httpStatus: evidence.status,
      lastErrorCode: evidence.code,
      classification: evidence.classification,
      error: evidence.diagnostic,
      explicitLoadingSupported:
        endpoints.explicitModelLoad === "unknown"
          ? undefined
          : endpoints.explicitModelLoad === "supported",
      message: error instanceof Error ? error.message : String(error),
    });
  };
  const recoverable = (error: unknown) => {
    const classification = errorEvidence(error).classification;
    return classification === "transient" || classification === "uncertain";
  };
  const waitForPoll = () =>
    new Promise<void>((resolve, reject) => {
      const finish = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        wakePoll = undefined;
        resolve();
      };
      const abort = () => {
        clearTimeout(timer);
        wakePoll = undefined;
        reject(signal.reason ?? new Error("Request aborted"));
      };
      const delay = Math.max(
        1,
        Math.min(pollInterval, Math.ceil(shared.deadline - now(options))),
      );
      const timer = setTimeout(finish, delay);
      wakePoll = finish;
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
  try {
    for (;;) {
      assertActive(options, shared, model, lastError);
      if (!models) {
        shared.phase = checks ? "readiness_poll" : "inventory";
        try {
          const result = await catalog(root, options, shared, model);
          if (!result.supported) {
            if (knownRouter || capabilities.get(capabilityKey) === true)
              throw new Error(
                `Provider /models no longer exposes a valid inventory for ${model}`,
              );
            capabilities.set(capabilityKey, false);
            return false;
          }
          capabilities.set(capabilityKey, true);
          models = result.models;
          checks++;
          shared.attempts = checks;
        } catch (error) {
          assertActive(options, shared, model, error);
          if (!recoverable(error)) throw error;
          transient(error, checks ? "readiness_poll" : "inventory");
          await waitForPoll();
          pollInterval = Math.min(
            maxPollInterval,
            Math.ceil(pollInterval * 1.5),
          );
          continue;
        }
      }
      const entry = models.find((candidate) => candidate.id === model);
      if (!entry)
        throw new Error(
          `Configured model is not available in provider inventory: ${model}. Check the provider model ID and inventory.`,
        );
      const status = entry.status;
      const value = status?.value as string | undefined;
      const exitCode =
        typeof status?.exit_code === "number" ? status.exit_code : undefined;
      if (value === "loaded" || value === "sleeping" || status?.failed === true)
        liveProgress = undefined;
      latestPolled = {
        state:
          value === "loaded"
            ? "ready"
            : ((value ?? "checking") as ModelPreflightState),
        progress: status ? progressOf(status) : 0,
        exitCode,
      };
      notify(shared, {
        ...latestPolled,
        progress:
          value === "loading" || value === "unloaded"
            ? (liveProgress ?? latestPolled.progress)
            : latestPolled.progress,
      });
      // Router keeps a sleeping child routable; its next inference wakes it.
      // POST /models/load only starts an unloaded instance.
      if (value === "loaded" || value === "sleeping") return true;
      if (status?.failed === true)
        throw new Error(
          `Model failed to load: ${model}${exitCode === undefined ? "" : ` (llama.cpp exit code: ${exitCode})`}`,
        );
      if (!sseTask && !sseAttempted && endpoints.modelsSse !== "unsupported") {
        shared.phase = "progress_stream";
        sseAttempted = true;
        // GET /models has established Router capability and the model is not ready.
        try {
          const request = await openBoundedResponse(
            new URL("models/sse", root),
            {
              headers: new Headers({
                ...Object.fromEntries(options.headers),
                Accept: "text/event-stream",
              }),
            },
            options,
            shared,
            model,
          );
          const response = request.response;
          try {
            if (response.status === 404) {
              endpoints.modelsSse = "unsupported";
              notify(shared, {
                type: "model_preflight_sse_unsupported",
                phase: "progress_stream",
                httpStatus: 404,
              });
              await response.body?.cancel();
            } else if (!response.ok) {
              await response.body?.cancel();
              throw new PreflightHttpError(
                `Provider /models/sse returned HTTP ${response.status}`,
                response.status,
              );
            } else {
              endpoints.modelsSse = "supported";
              sseTask = listenSse(
                response,
                model,
                sseController.signal,
                (event) => {
                  if (signal.aborted) return;
                  if (event.terminal) {
                    terminalObserved = true;
                    wakePoll?.();
                  }
                  if (
                    event.progress === undefined ||
                    (latestPolled?.state !== "loading" &&
                      latestPolled?.state !== "unloaded")
                  )
                    return;
                  liveProgress = event.progress;
                  if (shared.latest?.progress !== event.progress)
                    notify(shared, {
                      ...latestPolled,
                      progress: event.progress,
                    });
                },
              )
                .catch((error) => {
                  if (!sseController.signal.aborted)
                    transient(error, "progress_stream");
                })
                .finally(() => {
                  if (sseController.signal.aborted) return;
                  liveProgress = undefined;
                  if (
                    (latestPolled?.state === "loading" ||
                      latestPolled?.state === "unloaded") &&
                    shared.latest?.progress !== latestPolled.progress
                  )
                    notify(shared, latestPolled);
                });
            }
          } catch (error) {
            if (request.signal.aborted) request.signal.throwIfAborted();
            throw error;
          } finally {
            request.release();
          }
        } catch (error) {
          assertActive(options, shared, model, error);
          if (!recoverable(error)) throw error;
          transient(error, "progress_stream");
        }
      }
      let shouldProbe = false;
      if ((value === "unloaded" || value === undefined) && !loadRequested) {
        shared.phase = "explicit_load";
        notify(shared, {
          type: "model_preflight_loading",
          phase: "explicit_load",
          elapsedMs: elapsed(options, shared),
          attempts: checks,
          explicitLoadingSupported:
            endpoints.explicitModelLoad === "unknown"
              ? undefined
              : endpoints.explicitModelLoad === "supported",
        });
        if (endpoints.explicitModelLoad === "unsupported") {
          loadRequested = true;
          shouldProbe = true;
          shared.explicitLoadingSupported = false;
        } else {
          // A transport failure may occur after the server accepted the load.
          // Mark it initiated before I/O so recovery never duplicates the request.
          loadRequested = true;
          try {
            const status = await boundedFetch(
              new URL("models/load", root),
              {
                method: "POST",
                headers: new Headers({
                  ...Object.fromEntries(options.headers),
                  "Content-Type": "application/json",
                }),
                body: JSON.stringify({ model }),
              },
              async (response) => response.status,
              options,
              shared,
              model,
            );
            if (status === 404) {
              endpoints.explicitModelLoad = "unsupported";
              shared.explicitLoadingSupported = false;
              notify(shared, {
                type: "model_preflight_explicit_load_unsupported",
                phase: "explicit_load",
                httpStatus: 404,
              });
              shouldProbe = true;
            } else if (status < 200 || status >= 300) {
              throw new PreflightHttpError(
                `Provider could not load ${model}: HTTP ${status}`,
                status,
              );
            } else {
              endpoints.explicitModelLoad = "supported";
              shared.explicitLoadingSupported = true;
              notify(shared, "load_requested");
              // A successful load endpoint means loading was requested. It does
              // not prove readiness when inventory has no model-level status.
              shouldProbe = !status;
            }
          } catch (error) {
            assertActive(options, shared, model, error);
            if (!recoverable(error)) throw error;
            // A transient HTTP response proves that the server rejected this
            // request, so retrying after a readiness check is safe. A transport
            // failure is ambiguous and must not duplicate a load that may still
            // be running server-side.
            if (errorEvidence(error).status !== undefined)
              loadRequested = false;
            transient(error, "explicit_load");
            shouldProbe = !status;
          }
        }
      }
      if (
        value === undefined ||
        (value === "unloaded" && endpoints.explicitModelLoad === "unsupported")
      )
        shouldProbe = true;
      if (shouldProbe) {
        shared.phase = "warmup";
        try {
          await warmup(completionUrl, model, maxTokensField, options, shared);
          return true;
        } catch (error) {
          assertActive(options, shared, model, error);
          if (!recoverable(error))
            throw new Error(
              `Model preflight failed for ${model}: no valid automatic-loading fallback became ready: ${error instanceof Error ? error.message : String(error)}`,
              { cause: error },
            );
          transient(error, "warmup");
        }
      }
      notify(shared, {
        type: "model_preflight_polling",
        phase: "readiness_poll",
        elapsedMs: elapsed(options, shared),
        attempts: checks,
        explicitLoadingSupported:
          endpoints.explicitModelLoad === "unknown"
            ? undefined
            : endpoints.explicitModelLoad === "supported",
      });
      shared.phase = "readiness_poll";
      if (!terminalObserved) await waitForPoll();
      terminalObserved = false;
      pollInterval = Math.min(maxPollInterval, Math.ceil(pollInterval * 1.5));
      models = undefined;
    }
  } finally {
    sseController.abort();
    // The listener owns its reader. Aborting the fetch also cancels the reader.
    void sseTask?.catch(() => {});
  }
}

/** Called inside the stream wrapper, before request numbering and request_start. */
export async function ensureRouterModelReady(
  runtime: ModelRuntime,
  model: Model<Api>,
  requestOptions: Parameters<ModelRuntime["streamSimple"]>[2],
  options: Omit<RouterOptions, "fetch" | "headers">,
): Promise<void> {
  if (
    model.api !== "openai-completions" ||
    model.provider === "openai" ||
    model.provider === "openai-codex"
  )
    return;
  const auth = await runtime.getAuth(model, {
    apiKey: requestOptions?.apiKey,
    env: requestOptions?.env,
    signal: options.signal,
  });
  if (!auth) return;
  const root = routerBaseUrl(auth.auth.baseUrl ?? model.baseUrl);
  if (!root) return;
  const effectiveBaseUrl = new URL(auth.auth.baseUrl ?? model.baseUrl).href;
  const capabilityKey = `${model.provider}\0${effectiveBaseUrl}`;
  if (capabilities.get(capabilityKey) === false) return;
  const headers = new Headers();
  for (const source of [
    model.headers,
    auth.auth.headers,
    requestOptions?.headers,
  ])
    for (const [name, value] of Object.entries(source ?? {}))
      if (typeof value === "string") headers.set(name, value);
  const apiKey = requestOptions?.apiKey ?? auth.auth.apiKey;
  if (apiKey && !headers.has("Authorization"))
    headers.set("Authorization", `Bearer ${apiKey}`);
  const input: RouterOptions = {
    ...options,
    headers,
    fetch: requestOptions?.fetch ?? globalThis.fetch,
  };
  const warmupUrl = completionUrl(effectiveBaseUrl);
  const maxTokensField =
    (model as Model<"openai-completions">).compat?.maxTokensField ===
    "max_completion_tokens"
      ? "max_completion_tokens"
      : "max_tokens";
  const startedAt = Date.now();
  const emit = (event: Omit<ModelPreflightEvent, "provider" | "model">) =>
    options.onEvent?.({ ...event, provider: model.provider, model: model.id });
  const update = (snapshot: Snapshot) =>
    options.onUpdate?.({
      kind: "model_preflight",
      model: model.id,
      state: snapshot.state,
      progress: snapshot.progress,
      startedAt,
    });
  let lastStatus: string | undefined;
  let lastProgress: number | undefined;
  let loggedProgress: number | undefined;
  let lastSnapshot: Snapshot | undefined;
  const listener: Listener = (change) => {
    if (change === "load_requested") {
      emit({ type: "model_load_requested" });
      return;
    }
    if ("type" in change) {
      emit(change);
      return;
    }
    lastSnapshot = change;
    const statusChanged = change.state !== lastStatus;
    if (statusChanged) {
      emit({
        type: "model_status",
        status: change.state === "ready" ? "loaded" : change.state,
      });
      lastStatus = change.state;
    }
    if (statusChanged || change.progress !== lastProgress) update(change);
    if (
      (change.state === "loading" || change.state === "unloaded") &&
      change.progress !== undefined &&
      (loggedProgress === undefined ||
        Math.abs(change.progress - loggedProgress) >= 0.05)
    ) {
      emit({ type: "model_preflight_progress", progress: change.progress });
      loggedProgress = change.progress;
    }
    lastProgress = change.progress;
  };
  emit({
    type: "model_preflight_started",
    phase: "inventory",
    elapsedMs: 0,
    attempts: 0,
  });
  update({ state: "checking" });
  if (options.signal?.aborted) {
    const reason = options.signal.reason ?? new Error("Request aborted");
    const evidence = errorEvidence(reason);
    emit({
      type: "model_preflight_cancelled",
      phase: "inventory",
      durationMs: Date.now() - startedAt,
      elapsedMs: Date.now() - startedAt,
      attempts: 0,
      eventuallyReady: false,
      lastErrorCode: evidence.code,
      httpStatus: evidence.status,
      error: evidence.diagnostic,
      message: reason instanceof Error ? reason.message : String(reason),
    });
    options.onUpdate?.({ kind: "model_preflight_end" });
    throw new Error(
      `Model preflight cancelled for ${model.id}: ${reason instanceof Error ? reason.message : String(reason)}`,
      { cause: reason },
    );
  }
  const key = `${capabilityKey}\0${model.id}`;
  let shared = inFlight.get(key);
  if (!shared) {
    shared = {
      controller: new AbortController(),
      listeners: new Set(),
      promise: undefined!,
      waiters: 0,
      deadline:
        now(input) + (input.coldStartTimeoutMs ?? defaultColdStartTimeoutMs),
      attempts: 0,
      phase: "inventory",
    };
    const current = shared;
    inFlight.set(key, current);
    current.promise = Promise.resolve()
      .then(() =>
        runShared(
          root,
          model.id,
          input,
          current,
          capabilityKey,
          warmupUrl,
          maxTokensField,
        ),
      )
      .finally(() => {
        if (inFlight.get(key) === current) inFlight.delete(key);
      });
    void current.promise.catch(() => {});
  }
  shared.waiters++;
  shared.listeners.add(listener);
  if (shared.latest) listener(shared.latest);
  try {
    const ready = await new Promise<boolean>((resolve, reject) => {
      if (options.signal?.aborted) {
        reject(options.signal.reason ?? new Error("Request aborted"));
        return;
      }
      const abort = () =>
        reject(options.signal?.reason ?? new Error("Request aborted"));
      options.signal?.addEventListener("abort", abort, { once: true });
      shared!.promise
        .then(resolve, reject)
        .finally(() => options.signal?.removeEventListener("abort", abort));
    });
    if (ready)
      emit({
        type: "model_preflight_ready",
        durationMs: Date.now() - startedAt,
        elapsedMs: Date.now() - startedAt,
        attempts: shared.attempts,
        phase: shared.phase,
        explicitLoadingSupported: shared.explicitLoadingSupported,
        eventuallyReady: true,
      });
    else emit({ type: "model_preflight_unsupported" });
  } catch (error) {
    const cancelled = options.signal?.aborted === true;
    const timedOut = error instanceof ModelPreflightTimeoutError;
    const evidence = errorEvidence(error);
    emit({
      type: cancelled
        ? "model_preflight_cancelled"
        : timedOut
          ? "model_preflight_timeout"
          : "model_preflight_failed",
      status: lastSnapshot?.state,
      exitCode: lastSnapshot?.exitCode,
      durationMs: Date.now() - startedAt,
      elapsedMs: Date.now() - startedAt,
      attempts: shared.attempts,
      phase: shared.phase,
      explicitLoadingSupported: shared.explicitLoadingSupported,
      lastErrorCode: evidence.code,
      httpStatus: evidence.status,
      classification: timedOut ? "transient" : evidence.classification,
      error: evidence.diagnostic,
      eventuallyReady: false,
      message: error instanceof Error ? error.message : String(error),
    });
    if (cancelled)
      throw new Error(
        `Model preflight cancelled for ${model.id}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    throw error;
  } finally {
    shared.listeners.delete(listener);
    shared.waiters--;
    if (shared.waiters === 0) {
      if (inFlight.get(key) === shared) inFlight.delete(key);
      shared.controller.abort(options.signal?.reason);
    }
    options.onUpdate?.({ kind: "model_preflight_end" });
  }
}
