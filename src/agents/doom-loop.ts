import { createHash } from "node:crypto";
import type { TeamConfig } from "../config/schema.ts";
import { serenaRead, serenaWrite } from "./permissions.ts";
import type { Role } from "./schemas.ts";
import { detectedCommandId } from "./discovery.ts";

export const DEFAULT_DOOM_LOOP_STEER = `You are repeating observational search/read operations without progress. Stop broad exploration. Summarize established facts, identify the next concrete action, and make the required change or finish with a structured result.

Stop repeating tool calls that you have already performed. Review the information already available in your context. If a specific fact is still missing, use a materially different tool or approach. Otherwise stop gathering information and produce the best valid final result now. Do not repeat the same tool-call pattern again.`;
export const DOOM_LOOP_FINALIZE = `Your tool-use loop has continued after multiple interventions.

You may not use additional tools. Using only the information already available in your context, produce your required final structured result now.`;
export const TOOL_BUDGET_FINALIZE = `You have reached the tool-call budget.

Do not call any more tools. Use the information already collected and produce your required final structured result now.`;
export const TOOL_BURST_STEER = `Too many tool calls were emitted in one response. Remaining calls were not executed. Reassess the task and make a small number of targeted calls.`;
export const TOOL_BURST_STREAM_STEER = `Your previous response emitted too many tool calls and was stopped before completion. No calls from that response were executed. Do not retry the batch. Reassess the task, summarize the intended action, and make only a small number of targeted calls.`;

export function resolveDoomLoop(config: TeamConfig, role: Role) {
  return {
    ...config.workflow.doomLoop,
    ...config.agents[role].doomLoop,
    steerPrompt:
      config.agents[role].doomLoop?.steerPrompt ??
      config.workflow.doomLoop.steerPrompt ??
      DEFAULT_DOOM_LOOP_STEER,
  };
}

const transient =
  /^(?:timestamp|time|request_?id|tool_?call_?id|call_?id|authorization|cookie|headers?|metadata|trace_?id|span_?id)$/i;
const sensitive = /(?:secret|password|token|api_?key|credential|auth)/i;

function canonical(value: unknown, key = ""): unknown {
  if (Array.isArray(value)) return value.map((item) => canonical(item, key));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !transient.test(key) && !sensitive.test(key))
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, canonical(child, key)]),
    );
  return typeof value === "string" &&
    /^(?:query|queries|pattern|search_query)$/.test(key)
    ? value.trim().replace(/\s+/g, " ")
    : value;
}

/** Only a SHA-256 digest is retained; raw arguments never enter logs or history. */
export function toolSignature(tool: string, input: unknown) {
  const args =
    input && typeof input === "object"
      ? (input as Record<string, unknown>)
      : {};
  let relevant: unknown = args;
  if (tool === "team_command")
    relevant =
      typeof args.id === "string"
        ? { id: args.id }
        : typeof args.executable === "string" &&
            Array.isArray(args.args) &&
            args.args.every((arg) => typeof arg === "string")
          ? {
              id: detectedCommandId({
                executable: args.executable,
                args: args.args,
              }),
            }
          : args;
  else if (/^(read|serena_read_file)$/i.test(tool))
    relevant = {
      path: args.path ?? args.relative_path ?? args.file_path,
      offset: args.offset ?? args.start_line,
      limit: args.limit ?? args.end_line,
    };
  else if (
    /serena_(?:find_symbol|find_referencing_symbols|get_symbols_overview)/i.test(
      tool,
    )
  )
    relevant = {
      name:
        args.name_path_pattern ?? args.name_path ?? args.symbol ?? args.name,
      path: args.relative_path ?? args.path,
      scope: args.search_scope ?? args.scope,
      depth: args.depth,
      includeBody: args.include_body,
      includeInfo: args.include_info,
      substringMatching: args.substring_matching,
      includeKinds: args.include_kinds,
      excludeKinds: args.exclude_kinds,
      maxMatches: args.max_matches,
    };
  const serialized = JSON.stringify([tool, canonical(relevant)]);
  return createHash("sha256").update(serialized).digest("hex");
}

/** The MCP gateway carries its actual tool arguments under `args`. */
export function toolInvocation(tool: string, input: unknown) {
  if (tool !== "mcp" || !input || typeof input !== "object")
    return { tool, input };
  const gateway = input as Record<string, unknown>;
  if (typeof gateway.tool !== "string") return { tool, input };
  let args = gateway.args;
  if (typeof args === "string") {
    try {
      args = JSON.parse(args);
    } catch {
      // Malformed JSON is itself the attempted operation.
    }
  }
  return { tool: gateway.tool, input: args ?? {} };
}

export type ToolBehavior =
  "observational" | "mutating" | "validation" | "unknown";

const mutatingTools = new Set(["write", "edit", "team_delete", ...serenaWrite]);
const observationalTools = new Set([
  "read",
  "grep",
  "find",
  "ls",
  "team_git_inspect",
  "web_search",
  "fetch_content",
  ...serenaRead,
  "resolve-library-id",
  "query-docs",
  "context7_resolve-library-id",
  "context7_query-docs",
]);

export function toolBehavior(tool: string): ToolBehavior {
  if (mutatingTools.has(tool)) return "mutating";
  if (tool === "team_command") return "validation";
  if (observationalTools.has(tool)) return "observational";
  return "unknown";
}

export interface LoopPattern {
  patternType: "identical" | "cycle" | "observational";
  tool: string;
  repeatCount: number;
  progressEpoch: number;
}

export type GuardEvent =
  | {
      type: "doom_loop_detected";
      patternType:
        | LoopPattern["patternType"]
        | "tool_call_burst"
        | "consecutive_tool_failures"
        | "no_progress_tool_calls";
      tool: string;
      repeatCount: number;
      progressEpoch: number;
      limit?: number;
    }
  | {
      type: "tool_call_burst_limited";
      emitted: number;
      allowed: number;
      discarded: number;
    }
  | { type: "doom_loop_progress_reset"; reason: string }
  | { type: "doom_loop_steer"; intervention: number; maxInterventions: number }
  | { type: "doom_loop_finalization" | "tool_budget_finalization" };

export class DoomLoopDetector {
  private history: {
    signature: string;
    tool: string;
    behavior: ToolBehavior;
    success?: boolean;
    progressEpoch: number;
  }[] = [];
  private successfulMutations = new Set<string>();
  private progressEpoch = 0;
  private sinceProgress: { behavior: ToolBehavior; target: string }[] = [];
  constructor(private readonly config: ReturnType<typeof resolveDoomLoop>) {}
  clear() {
    this.history = [];
    this.successfulMutations.clear();
    this.progressEpoch = 0;
    this.sinceProgress = [];
  }
  observe(tool: string, input: unknown): LoopPattern | undefined {
    if (!this.config.enabled) return;
    const signature = toolSignature(tool, input);
    const behavior = toolBehavior(tool);
    const args =
      input && typeof input === "object"
        ? (input as Record<string, unknown>)
        : {};
    const path = args.path ?? args.relative_path ?? args.file_path;
    const target =
      typeof path === "string" ? toolSignature("read", { path }) : signature;
    this.sinceProgress.push({ behavior, target });
    if (this.sinceProgress.length > 64) this.sinceProgress.shift();
    this.history.push({
      signature,
      tool,
      behavior,
      progressEpoch: this.progressEpoch,
    });
    if (this.history.length > Math.max(this.config.windowSize, 64))
      this.history.shift();
    const count = this.history
      .slice(-this.config.windowSize)
      .filter((item) => item.signature === signature).length;
    if (count >= this.config.maxIdenticalCalls)
      return {
        patternType: "identical",
        tool,
        repeatCount: count,
        progressEpoch: this.progressEpoch,
      };
    for (let length = 2; length <= 16; length++) {
      const signatures = (
        length <= 4 ? this.history.slice(-this.config.windowSize) : this.history
      ).map((item) => item.signature);
      const total = length * this.config.maxRepeatedPattern;
      if (signatures.length < total) continue;
      const tail = signatures.slice(-total);
      const pattern = tail.slice(0, length);
      if (new Set(pattern).size < 2) continue;
      if (tail.every((item, index) => item === pattern[index % length]))
        return {
          patternType: "cycle",
          tool,
          repeatCount: this.config.maxRepeatedPattern,
          progressEpoch: this.progressEpoch,
        };
    }
    const recent = this.sinceProgress.slice(-40);
    const observed = recent.filter((item) => item.behavior === "observational");
    if (
      recent.length >= 30 &&
      observed.length / recent.length >= 0.9 &&
      new Set(observed.map((item) => item.target)).size / observed.length <=
        0.65
    )
      return {
        patternType: "observational",
        tool,
        repeatCount: observed.length,
        progressEpoch: this.progressEpoch,
      };
  }

  /** Called only after execution; a repeated mutation signature is not new progress. */
  completeMutation(tool: string, signature: string, success: boolean) {
    if (!this.config.enabled || toolBehavior(tool) !== "mutating") return;
    const entry = this.history.findLast(
      (item) => item.signature === signature && item.success === undefined,
    );
    if (entry) entry.success = success;
    if (!success || this.successfulMutations.has(signature)) return;
    this.successfulMutations.add(signature);
    this.progressEpoch++;
    this.sinceProgress = [];
    // Retain the mutation itself so repeating it remains detectable.
    this.history = [
      {
        signature,
        tool,
        behavior: "mutating",
        success: true,
        progressEpoch: this.progressEpoch,
      },
    ];
  }
}

export class ToolUseGuard {
  readonly detector: DoomLoopDetector;
  private pendingMutations = new Map<
    string,
    { tool: string; signature: string }
  >();
  private readonly pendingCalls = new Map<
    string,
    { tool: string; input: unknown; observed: boolean }
  >();
  private readonly seenCallIds = new Set<string>();
  private readonly blockedByGuard = new Set<string>();
  private readonly observedTargets = new Set<string>();
  private responseBlocked = false;
  private responseActive = false;
  private lastStreamCutoffRequest?: number;
  private streamCutoffPending = false;
  consecutiveFailures = 0;
  noProgressToolCalls = 0;
  toolCalls = 0;
  interventions = 0;
  toolsDisabledForFinalization = false;
  finalizationReason?: "doom_loop" | "tool_budget";
  constructor(
    private readonly config: ReturnType<typeof resolveDoomLoop>,
    private readonly maxToolCalls: number,
    private readonly session: () => {
      steer(text: string): Promise<unknown>;
      setActiveToolsByName(names: string[]): void;
    },
    private readonly event?: (event: GuardEvent) => void,
  ) {
    this.detector = new DoomLoopDetector(config);
  }
  resetHistory() {
    this.detector.clear();
    this.pendingMutations.clear();
  }
  get streamToolCallLimit() {
    return this.config.enabled ? this.config.maxToolCallsPerResponse : 0;
  }
  async streamCutoff(providerRequest: number, observed: number, limit: number) {
    if (this.lastStreamCutoffRequest === providerRequest) return;
    this.lastStreamCutoffRequest = providerRequest;
    this.streamCutoffPending = true;
    if (!this.toolsDisabledForFinalization && limit > 0)
      await this.detect(
        "tool_call_burst",
        "provider_response",
        observed,
        false,
        0,
        true,
        limit,
      );
  }
  /** Pi emits this for every call, including invalid arguments and failed commands. */
  async start(toolCallId: string, tool: string, input: unknown) {
    if (this.seenCallIds.has(toolCallId)) return;
    this.seenCallIds.add(toolCallId);
    this.pendingCalls.set(toolCallId, { tool, input, observed: true });
    this.toolCalls++;
    if (this.maxToolCalls > 0 && this.toolCalls > this.maxToolCalls) {
      this.blockedByGuard.add(toolCallId);
      await this.finalizeBudget();
      return;
    }
    if (!this.responseBlocked && !this.toolsDisabledForFinalization) {
      const loop = this.detector.observe(tool, input);
      if (loop)
        await this.detect(
          loop.patternType,
          loop.tool,
          loop.repeatCount,
          true,
          loop.progressEpoch,
        );
    }
  }
  private progress(reason: string) {
    this.consecutiveFailures = 0;
    this.noProgressToolCalls = 0;
    if (reason === "file_mutation")
      this.event?.({ type: "doom_loop_progress_reset", reason });
  }
  private async finalizeBudget() {
    if (this.toolsDisabledForFinalization) return;
    this.finalizationReason = "tool_budget";
    this.toolsDisabledForFinalization = true;
    this.event?.({ type: "tool_budget_finalization" });
    await this.session().steer(TOOL_BUDGET_FINALIZE);
    this.session().setActiveToolsByName([]);
  }
  private async detect(
    reason:
      | "tool_call_burst"
      | "consecutive_tool_failures"
      | "no_progress_tool_calls"
      | LoopPattern["patternType"],
    tool: string,
    count: number,
    blockResponse = true,
    progressEpoch = 0,
    streaming = false,
    limit?: number,
  ) {
    if (!this.config.enabled || this.toolsDisabledForFinalization) return;
    this.event?.({
      type: "doom_loop_detected",
      patternType: reason,
      tool,
      repeatCount: count,
      progressEpoch,
      ...(limit === undefined ? {} : { limit }),
    });
    this.detector.clear();
    this.consecutiveFailures = 0;
    this.noProgressToolCalls = 0;
    if (blockResponse && this.responseActive) this.responseBlocked = true;
    if (this.interventions < this.config.maxInterventions) {
      this.interventions++;
      this.event?.({
        type: "doom_loop_steer",
        intervention: this.interventions,
        maxInterventions: this.config.maxInterventions,
      });
      await this.session().steer(
        reason === "tool_call_burst"
          ? streaming
            ? TOOL_BURST_STREAM_STEER
            : TOOL_BURST_STEER
          : this.config.steerPrompt,
      );
    } else {
      this.finalizationReason = "doom_loop";
      this.toolsDisabledForFinalization = true;
      this.event?.({ type: "doom_loop_finalization" });
      await this.session().steer(DOOM_LOOP_FINALIZE);
      this.session().setActiveToolsByName([]);
    }
  }
  /** Runs at Pi's completed assistant-message barrier, before tool execution. */
  async limitResponse<T extends { role: string; content?: unknown[] }>(
    message: T,
  ): Promise<T> {
    if (message.role !== "assistant") return message;
    this.responseActive = true;
    this.responseBlocked = false;
    if (this.streamCutoffPending) {
      this.streamCutoffPending = false;
      return {
        ...message,
        content: message.content?.filter(
          (item) =>
            !item ||
            typeof item !== "object" ||
            (item as { type?: string }).type !== "toolCall",
        ),
      };
    }
    if (this.toolsDisabledForFinalization)
      return {
        ...message,
        content: message.content?.filter(
          (item) =>
            !item ||
            typeof item !== "object" ||
            (item as { type?: string }).type !== "toolCall",
        ),
      };
    const calls =
      message.content?.filter(
        (item) =>
          !!item &&
          typeof item === "object" &&
          (item as { type?: string }).type === "toolCall",
      ) ?? [];
    const limit = this.config.enabled ? this.config.maxToolCallsPerResponse : 0;
    if (!limit || calls.length <= limit) return message;
    let retained = 0;
    const content = message.content!.filter((item) => {
      if (
        !item ||
        typeof item !== "object" ||
        (item as { type?: string }).type !== "toolCall"
      )
        return true;
      return ++retained <= limit;
    });
    await this.detect(
      "tool_call_burst",
      "provider_response",
      calls.length,
      false,
      0,
      false,
      limit,
    );
    this.event?.({
      type: "tool_call_burst_limited",
      emitted: calls.length,
      allowed: this.toolsDisabledForFinalization ? 0 : limit,
      discarded: calls.length - (this.toolsDisabledForFinalization ? 0 : limit),
    });
    return {
      ...message,
      content: this.toolsDisabledForFinalization
        ? content.filter(
            (item) =>
              !item ||
              typeof item !== "object" ||
              (item as { type?: string }).type !== "toolCall",
          )
        : content,
    };
  }
  async complete(
    toolCallId: string,
    success: boolean,
    result?: unknown,
    isError = !success,
  ) {
    const invocation = this.pendingCalls.get(toolCallId);
    this.pendingCalls.delete(toolCallId);
    if (this.blockedByGuard.delete(toolCallId)) return;
    const pending = this.pendingMutations.get(toolCallId);
    this.pendingMutations.delete(toolCallId);
    if (!invocation && !pending) return;
    const tool = invocation?.tool ?? pending!.tool;
    const details =
      result && typeof result === "object"
        ? (result as { details?: unknown }).details
        : undefined;
    const command =
      tool === "team_command" && details && typeof details === "object"
        ? (details as { exitCode?: number; code?: string; status?: string })
        : undefined;
    const approvalDenied =
      command?.code === "COMMAND_APPROVAL_DENIED" ||
      command?.code === "COMMAND_APPROVAL_PENDING";
    const worked =
      success &&
      !isError &&
      (command?.exitCode === undefined || command.exitCode === 0) &&
      !approvalDenied;
    if (pending)
      this.detector.completeMutation(pending.tool, pending.signature, worked);
    if (!this.config.enabled) return;
    this.noProgressToolCalls++;
    if (!worked) {
      if (!approvalDenied) this.consecutiveFailures++;
    } else {
      const behavior = toolBehavior(tool);
      if (
        behavior === "mutating" &&
        pending &&
        !this.observedTargets.has(pending.signature)
      ) {
        this.observedTargets.add(pending.signature);
        this.progress("file_mutation");
      } else if (behavior === "validation") {
        this.progress("successful_command");
      } else if (behavior === "observational" && invocation) {
        const args =
          invocation.input && typeof invocation.input === "object"
            ? (invocation.input as Record<string, unknown>)
            : {};
        const path = args.path ?? args.relative_path ?? args.file_path;
        const target =
          typeof path === "string"
            ? `${tool}:${path}`
            : toolSignature(tool, invocation.input);
        if (!this.observedTargets.has(target)) {
          this.observedTargets.add(target);
          this.progress("new_observation");
        }
      }
    }
    if (
      this.config.maxConsecutiveToolFailures > 0 &&
      this.consecutiveFailures >= this.config.maxConsecutiveToolFailures
    )
      await this.detect(
        "consecutive_tool_failures",
        tool,
        this.consecutiveFailures,
      );
    else if (
      this.config.maxNoProgressToolCalls > 0 &&
      this.noProgressToolCalls >= this.config.maxNoProgressToolCalls
    )
      await this.detect(
        "no_progress_tool_calls",
        tool,
        this.noProgressToolCalls,
      );
  }
  discard(toolCallId: string) {
    this.pendingMutations.delete(toolCallId);
  }
  async call(
    tool: string,
    input: unknown,
    aborted = false,
    toolCallId?: string,
  ) {
    if (!toolCallId || !this.pendingCalls.has(toolCallId)) {
      if (toolCallId) await this.start(toolCallId, tool, input);
      else this.toolCalls++;
    } else {
      const pending = this.pendingCalls.get(toolCallId)!;
      this.pendingCalls.set(toolCallId, { ...pending, tool, input });
    }
    if (aborted || this.toolsDisabledForFinalization) {
      if (toolCallId) this.blockedByGuard.add(toolCallId);
      return {
        block: true,
        reason:
          "Tools disabled for finalization; produce your final structured result now",
      };
    }
    if (this.responseBlocked) {
      if (toolCallId) this.blockedByGuard.add(toolCallId);
      return {
        block: true,
        reason:
          "Doom Loop intervention: remaining calls in this response were not executed",
      };
    }
    if (this.maxToolCalls > 0 && this.toolCalls > this.maxToolCalls) {
      await this.finalizeBudget();
      if (toolCallId) this.blockedByGuard.add(toolCallId);
      return {
        block: true,
        reason: "Agent tool-call limit reached; final response requested",
      };
    }
    const loop =
      toolCallId && this.pendingCalls.get(toolCallId)?.observed
        ? undefined
        : this.detector.observe(tool, input);
    if (!loop) {
      if (toolCallId && toolBehavior(tool) === "mutating")
        this.pendingMutations.set(toolCallId, {
          tool,
          signature: toolSignature(tool, input),
        });
      return;
    }
    await this.detect(
      loop.patternType,
      loop.tool,
      loop.repeatCount,
      true,
      loop.progressEpoch,
    );
    if (this.toolsDisabledForFinalization) {
      if (toolCallId) this.blockedByGuard.add(toolCallId);
      return {
        block: true,
        reason:
          "Tools disabled for finalization; produce your final structured result now",
      };
    }
    if (toolCallId && toolBehavior(tool) === "mutating")
      this.pendingMutations.set(toolCallId, {
        tool,
        signature: toolSignature(tool, input),
      });
  }
}
