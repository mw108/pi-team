import { setTimeout as delay } from "node:timers/promises";
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
    | "model_load_requested"
    | "model_preflight_ready"
    | "model_preflight_failed"
    | "model_preflight_unsupported";
  provider: string;
  model: string;
  status?: string;
  progress?: number;
  durationMs?: number;
  exitCode?: number;
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
type Listener = (snapshot: Snapshot | "load_requested") => void;
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
const capabilities = new Map<string, boolean>();
const inFlight = new Map<string, Shared>();
const states = new Set([
  "unloaded",
  "loading",
  "loaded",
  "sleeping",
  "downloading",
  "downloaded",
]);

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

function parseCatalog(
  value: unknown,
): Array<{ id: string; status: Record<string, unknown> }> | undefined {
  if (!value || typeof value !== "object") return;
  const data = (value as { data?: unknown }).data;
  if (!Array.isArray(data) || data.length === 0) return;
  if (
    !data.every(
      (entry) =>
        entry &&
        typeof entry === "object" &&
        typeof entry.id === "string" &&
        entry.status &&
        typeof entry.status === "object" &&
        states.has(entry.status.value),
    )
  )
    return;
  return data;
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

function notify(shared: Shared, snapshot: Snapshot | "load_requested") {
  if (snapshot !== "load_requested") shared.latest = snapshot;
  for (const listener of shared.listeners) listener(snapshot);
}

async function catalog(root: URL, options: RouterOptions, signal: AbortSignal) {
  const response = await options.fetch(new URL("models", root), {
    headers: options.headers,
    signal,
  });
  if (response.status === 404) return { supported: false as const };
  if (!response.ok)
    throw new Error(
      `llama.cpp Router /models returned HTTP ${response.status}`,
    );
  const parsed = parseCatalog(await response.json().catch(() => undefined));
  return parsed
    ? { supported: true as const, models: parsed }
    : { supported: false as const };
}

async function runShared(
  root: URL,
  model: string,
  options: RouterOptions,
  shared: Shared,
  capabilityKey: string,
): Promise<boolean> {
  const signal = shared.controller.signal;
  const knownRouter = capabilities.get(capabilityKey) === true;
  let first: Awaited<ReturnType<typeof catalog>>;
  try {
    first = await catalog(root, options, signal);
  } catch (error) {
    // Before capability is established, let the normal provider path own
    // transport/auth failures and retain its existing diagnostics and retries.
    if (!knownRouter && !signal.aborted) return false;
    throw error;
  }
  if (!first.supported) {
    if (knownRouter)
      throw new Error(
        `llama.cpp Router /models no longer exposes model status for ${model}`,
      );
    capabilities.set(capabilityKey, false);
    return false;
  }
  capabilities.set(capabilityKey, true);
  let models = first.models;
  let loadRequested = false;
  for (;;) {
    signal.throwIfAborted();
    const entry = models.find((candidate) => candidate.id === model);
    if (!entry)
      throw new Error(
        `Configured model is not available in llama.cpp Router: ${model}. Check the provider model ID and Router inventory.`,
      );
    const status = entry.status;
    const value = status.value as string;
    const exitCode =
      typeof status.exit_code === "number" ? status.exit_code : undefined;
    notify(shared, {
      state: value === "loaded" ? "ready" : (value as ModelPreflightState),
      progress: progressOf(status),
      exitCode,
    });
    // Router keeps a sleeping child routable; its next inference wakes it.
    // POST /models/load only starts an unloaded instance.
    if (value === "loaded" || value === "sleeping") return true;
    if (status.failed === true)
      throw new Error(
        `Model failed to load: ${model}${exitCode === undefined ? "" : ` (llama.cpp exit code: ${exitCode})`}`,
      );
    if (value === "unloaded" && !loadRequested) {
      const response = await options.fetch(new URL("models/load", root), {
        method: "POST",
        headers: new Headers({
          ...Object.fromEntries(options.headers),
          "Content-Type": "application/json",
        }),
        body: JSON.stringify({ model }),
        signal,
      });
      if (!response.ok)
        throw new Error(
          `llama.cpp Router could not load ${model}: HTTP ${response.status}`,
        );
      loadRequested = true;
      notify(shared, "load_requested");
    }
    await delay(options.pollIntervalMs ?? 1500, undefined, { signal });
    const next = await catalog(root, options, signal);
    if (!next.supported)
      throw new Error(
        `llama.cpp Router /models stopped returning model status for ${model}`,
      );
    models = next.models;
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
  const capabilityKey = `${model.provider}\0${root.href}`;
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
  let lastSnapshot: Snapshot | undefined;
  const listener: Listener = (change) => {
    if (change === "load_requested") {
      emit({ type: "model_load_requested" });
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
      .then(() => runShared(root, model.id, input, current, capabilityKey))
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
      shared.controller.abort();
    }
    options.onUpdate?.({ kind: "model_preflight_end" });
  }
}
