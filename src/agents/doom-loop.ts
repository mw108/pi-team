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
      patternType: LoopPattern["patternType"];
      tool: string;
      repeatCount: number;
      progressEpoch: number;
    }
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
  complete(toolCallId: string, success: boolean) {
    const pending = this.pendingMutations.get(toolCallId);
    if (!pending) return;
    this.pendingMutations.delete(toolCallId);
    this.detector.completeMutation(pending.tool, pending.signature, success);
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
    this.toolCalls++;
    if (aborted || this.toolsDisabledForFinalization)
      return {
        block: true,
        reason:
          "Tools disabled for finalization; produce your final structured result now",
      };
    if (this.maxToolCalls > 0 && this.toolCalls > this.maxToolCalls) {
      this.finalizationReason = "tool_budget";
      this.toolsDisabledForFinalization = true;
      this.event?.({ type: "tool_budget_finalization" });
      // AgentSession.steer() queues a role=user message.
      await this.session().steer(TOOL_BUDGET_FINALIZE);
      this.session().setActiveToolsByName([]);
      return {
        block: true,
        reason: "Agent tool-call limit reached; final response requested",
      };
    }
    const loop = this.detector.observe(tool, input);
    if (!loop) {
      if (toolCallId && toolBehavior(tool) === "mutating")
        this.pendingMutations.set(toolCallId, {
          tool,
          signature: toolSignature(tool, input),
        });
      return;
    }
    this.event?.({ type: "doom_loop_detected", ...loop });
    this.resetHistory();
    if (this.interventions < this.config.maxInterventions) {
      this.interventions++;
      this.event?.({
        type: "doom_loop_steer",
        intervention: this.interventions,
        maxInterventions: this.config.maxInterventions,
      });
      await this.session().steer(this.config.steerPrompt);
      if (toolCallId && toolBehavior(tool) === "mutating")
        this.pendingMutations.set(toolCallId, {
          tool,
          signature: toolSignature(tool, input),
        });
    } else {
      this.finalizationReason = "doom_loop";
      this.toolsDisabledForFinalization = true;
      this.event?.({ type: "doom_loop_finalization" });
      await this.session().steer(DOOM_LOOP_FINALIZE);
      this.session().setActiveToolsByName([]);
      return {
        block: true,
        reason:
          "Tools disabled for finalization; produce your final structured result now",
      };
    }
  }
}
