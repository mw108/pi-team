import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

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
    | "model_preflight_start"
    | "model_status"
    | "model_preflight_progress"
    | "model_load_requested"
    | "model_preflight_ready"
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
  message?: string;
};
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
    | Pick<
        ModelPreflightEvent,
        "type" | "durationMs" | "httpStatus" | "message"
      >,
) => void;
type Shared = {
  controller: AbortController;
  listeners: Set<Listener>;
  promise: Promise<boolean>;
  latest?: Snapshot;
  waiters: number;
};
type RouterOptions = {
  fetch: typeof fetch;
  headers: Headers;
  signal?: AbortSignal;
  onEvent?: (event: ModelPreflightEvent) => void;
  onUpdate?: (update: ModelPreflightUpdate) => void;
  pollIntervalMs?: number;
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

async function catalog(root: URL, options: RouterOptions, signal: AbortSignal) {
  const response = await options.fetch(new URL("models", root), {
    headers: options.headers,
    signal,
  });
  if (response.status === 404) return { supported: false as const };
  if (!response.ok)
    throw new Error(`Provider /models returned HTTP ${response.status}`);
  const parsed = parseCatalog(await response.json().catch(() => undefined));
  return parsed
    ? { supported: true as const, models: parsed }
    : { supported: false as const };
}

async function warmup(
  url: URL,
  model: string,
  maxTokensField: "max_tokens" | "max_completion_tokens",
  options: RouterOptions,
  signal: AbortSignal,
  shared: Shared,
): Promise<void> {
  const startedAt = Date.now();
  let httpStatus: number | undefined;
  notify(shared, { type: "model_preflight_warmup_started" });
  try {
    // This is a separate preflight request. It has no agent context or inference
    // timeout; the caller's model/agent load signal governs cold startup.
    const response = await options.fetch(url, {
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
      signal,
    });
    httpStatus = response.status;
    if (response.status !== 200)
      throw new Error(
        `fallback chat-completion warmup failed at ${url.pathname}: HTTP ${response.status}`,
      );
    const body: unknown = await response.json().catch(() => undefined);
    if (
      !body ||
      typeof body !== "object" ||
      !Array.isArray((body as { choices?: unknown }).choices) ||
      (body as { choices: unknown[] }).choices.length === 0
    )
      throw new Error(
        `Model warmup returned HTTP 200 but no chat-completion choices at ${url.pathname}`,
      );
    notify(shared, {
      type: "model_preflight_warmup_completed",
      durationMs: Date.now() - startedAt,
      httpStatus: 200,
    });
  } catch (error) {
    const message = signal.aborted
      ? `Model preflight ${signal.reason?.name === "TimeoutError" ? "timed out" : "interrupted"} while warming up ${model}`
      : `Model preflight failed for ${model}: explicit model loading is unsupported; ${error instanceof Error ? error.message : String(error)}`;
    notify(shared, {
      type: "model_preflight_warmup_failed",
      durationMs: Date.now() - startedAt,
      httpStatus,
      message,
    });
    throw new Error(message, { cause: error });
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
  const first = await catalog(root, options, signal);
  if (!first.supported) {
    if (knownRouter)
      throw new Error(
        `Provider /models no longer exposes a valid inventory for ${model}`,
      );
    capabilities.set(capabilityKey, false);
    return false;
  }
  capabilities.set(capabilityKey, true);
  const endpoints = endpointCapabilities.get(capabilityKey) ?? {
    modelsSse: "unknown",
    explicitModelLoad: "unknown",
  };
  endpointCapabilities.set(capabilityKey, endpoints);
  let models = first.models;
  let loadRequested = false;
  let latestPolled: Snapshot | undefined;
  let liveProgress: number | undefined;
  const sseController = new AbortController();
  let sseTask: Promise<void> | undefined;
  let sseError: unknown;
  let wakePoll: (() => void) | undefined;
  let terminalObserved = false;
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
      const timer = setTimeout(finish, options.pollIntervalMs ?? 1500);
      wakePoll = finish;
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
  try {
    for (;;) {
      signal.throwIfAborted();
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
      if (!sseTask && endpoints.modelsSse !== "unsupported") {
        // GET /models has established Router capability and the model is not ready.
        const response = await options.fetch(new URL("models/sse", root), {
          headers: new Headers({
            ...Object.fromEntries(options.headers),
            Accept: "text/event-stream",
          }),
          signal,
        });
        if (response.status === 404) {
          endpoints.modelsSse = "unsupported";
          notify(shared, {
            type: "model_preflight_sse_unsupported",
            httpStatus: 404,
          });
          await response.body?.cancel();
        } else if (!response.ok) {
          await response.body?.cancel();
          throw new Error(
            `Provider /models/sse returned HTTP ${response.status}`,
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
                notify(shared, { ...latestPolled, progress: event.progress });
            },
          )
            .catch((error) => {
              if (!sseController.signal.aborted) sseError = error;
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
      }
      if ((value === "unloaded" || value === undefined) && !loadRequested) {
        if (endpoints.explicitModelLoad === "unsupported") {
          await warmup(
            completionUrl,
            model,
            maxTokensField,
            options,
            signal,
            shared,
          );
          return true;
        }
        const response = await options.fetch(new URL("models/load", root), {
          method: "POST",
          headers: new Headers({
            ...Object.fromEntries(options.headers),
            "Content-Type": "application/json",
          }),
          body: JSON.stringify({ model }),
          signal,
        });
        if (response.status === 404) {
          endpoints.explicitModelLoad = "unsupported";
          notify(shared, {
            type: "model_preflight_explicit_load_unsupported",
            httpStatus: 404,
          });
          await warmup(
            completionUrl,
            model,
            maxTokensField,
            options,
            signal,
            shared,
          );
          return true;
        }
        if (!response.ok)
          throw new Error(
            `Provider could not load ${model}: HTTP ${response.status}`,
          );
        endpoints.explicitModelLoad = "supported";
        loadRequested = true;
        notify(shared, "load_requested");
        if (!status) return true;
      }
      if (sseError) throw sseError;
      if (!terminalObserved) await waitForPoll();
      terminalObserved = false;
      const next = await catalog(root, options, signal);
      if (!next.supported)
        throw new Error(
          `Provider /models stopped returning a valid inventory for ${model}`,
        );
      models = next.models;
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
  let warmingUp = false;
  const listener: Listener = (change) => {
    if (change === "load_requested") {
      emit({ type: "model_load_requested" });
      return;
    }
    if ("type" in change) {
      if (change.type === "model_preflight_warmup_started") warmingUp = true;
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
  emit({ type: "model_preflight_start" });
  update({ state: "checking" });
  const key = `${capabilityKey}\0${model.id}`;
  let shared = inFlight.get(key);
  if (!shared) {
    shared = {
      controller: new AbortController(),
      listeners: new Set(),
      promise: undefined!,
      waiters: 0,
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
        reject(
          warmingUp && options.signal?.reason?.name === "TimeoutError"
            ? new Error(
                `Model preflight timed out while warming up ${model.id}`,
              )
            : (options.signal?.reason ?? new Error("Request aborted")),
        );
      options.signal?.addEventListener("abort", abort, { once: true });
      shared!.promise
        .then(resolve, reject)
        .finally(() => options.signal?.removeEventListener("abort", abort));
    });
    if (ready)
      emit({
        type: "model_preflight_ready",
        durationMs: Date.now() - startedAt,
      });
    else emit({ type: "model_preflight_unsupported" });
  } catch (error) {
    emit({
      type: "model_preflight_failed",
      status: lastSnapshot?.state,
      exitCode: lastSnapshot?.exitCode,
      message: error instanceof Error ? error.message : String(error),
    });
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
