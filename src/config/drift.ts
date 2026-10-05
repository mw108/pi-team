import { digest } from "../agents/registry.ts";
import type { WorkflowState } from "../workflow/state.ts";
import type { TeamConfig } from "./schema.ts";
import type { TeamDefinition } from "./loader.ts";
import { getActiveSolverIds } from "./solvers.ts";
import { solverIds } from "../agents/schemas.ts";

export type ConfigDriftClass =
  "semantic" | "runtime" | "presentation" | "future-agent";
export interface ConfigDriftAnalysis {
  changed: boolean;
  blocking: boolean;
  semanticChanges: string[];
  runtimeChanges: string[];
  presentationChanges: string[];
  futureAgentChanges: string[];
}

const runtimeWorkflow = new Set([
  "maxLocalFixCycles",
  "maxPentestCycles",
  "maxAgentFailures",
  "maxResearchClarifications",
  "maxToolCalls",
  "agentTimeoutMs",
  "requestTimeoutMs",
  "networkRetry",
  "doomLoop",
]);
const runtimeAgent = new Set([
  "thinking",
  "temperature",
  "timeoutMs",
  "requestTimeoutMs",
  "networkRetry",
  "doomLoop",
  "maxToolCalls",
]);
const presentationRoots = new Set(["ui", "logging", "toolActivity"]);

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, normalize(child)]),
    );
  return value;
}

function semanticConfig(config: TeamConfig) {
  return {
    ...Object.fromEntries(
      Object.entries(config).filter(
        ([key]) =>
          !presentationRoots.has(key) &&
          key !== "agents" &&
          key !== "workflow" &&
          key !== "permissions" &&
          key !== "execution",
      ),
    ),
    workflow: Object.fromEntries(
      Object.entries(config.workflow).filter(
        ([key]) => !runtimeWorkflow.has(key),
      ),
    ),
    agents: Object.fromEntries(
      Object.entries(config.agents)
        .filter(
          ([role]) =>
            !solverIds.includes(role as any) ||
            getActiveSolverIds(config).includes(role as any),
        )
        .map(([role, agent]) => [
          role,
          Object.fromEntries(
            Object.entries(agent).filter(
              ([key]) => key !== "name" && !runtimeAgent.has(key),
            ),
          ),
        ]),
    ),
  };
}

export function semanticConfigHash(config: TeamConfig): string {
  return digest(JSON.stringify(normalize(semanticConfig(config))));
}

function differences(
  previous: unknown,
  current: unknown,
  prefix = "",
): string[] {
  if (
    JSON.stringify(normalize(previous)) === JSON.stringify(normalize(current))
  )
    return [];
  if (
    previous &&
    current &&
    typeof previous === "object" &&
    typeof current === "object" &&
    !Array.isArray(previous) &&
    !Array.isArray(current)
  ) {
    const a = previous as Record<string, unknown>;
    const b = current as Record<string, unknown>;
    return [...new Set([...Object.keys(a), ...Object.keys(b)])]
      .sort()
      .flatMap((key) =>
        differences(a[key], b[key], prefix ? `${prefix}.${key}` : key),
      );
  }
  return [prefix];
}

function hasRun(state: WorkflowState, role: string): boolean {
  return (
    Boolean(state.results[role]) ||
    state.history.some(
      (event) =>
        event.meta?.agent === role && event.event === "agent_attempt_started",
    )
  );
}

export function analyzeConfigDrift(
  state: WorkflowState,
  current: TeamDefinition,
): ConfigDriftAnalysis {
  const result: ConfigDriftAnalysis = {
    changed: false,
    blocking: false,
    semanticChanges: [],
    runtimeChanges: [],
    presentationChanges: [],
    futureAgentChanges: [],
  };
  const add = (category: ConfigDriftClass, path: string) => {
    const field =
      category === "semantic"
        ? "semanticChanges"
        : category === "runtime"
          ? "runtimeChanges"
          : category === "presentation"
            ? "presentationChanges"
            : "futureAgentChanges";
    result[field].push(path);
  };
  const fullChanged =
    current.path !== state.teamConfigPath ||
    current.configHash !== state.teamConfigHash;
  const promptChanged = Object.entries(current.agentPromptHashes).filter(
    ([role, hash]) => state.agentPromptHashes?.[role] !== hash,
  );
  result.changed = fullChanged || promptChanged.length > 0;
  if (!result.changed) return result;
  if (current.path !== state.teamConfigPath) add("semantic", "teamConfigPath");
  if (!state.driftConfigSnapshot || !state.semanticConfigHash) {
    if (fullChanged)
      add(
        "semantic",
        "team.yaml (legacy state: field-level drift unavailable)",
      );
  } else {
    const active = new Set([
      ...getActiveSolverIds(state.config),
      ...getActiveSolverIds(current.config),
    ]);
    const solveStarted =
      state.history.some(
        (event) =>
          (event.phase === "SOLVE" && event.event === "phase_started") ||
          (event.event === "agent_attempt_started" &&
            !!event.meta?.agent &&
            solverIds.includes(event.meta.agent as any)),
      ) ||
      solverIds.some((id) => !!state.results[id]) ||
      !!state.results.critic;
    for (const path of differences(state.driftConfigSnapshot, current.config)) {
      const parts = path.split(".");
      if (
        parts[0] === "agents" &&
        solverIds.includes(parts[1] as any) &&
        !active.has(parts[1] as any)
      )
        continue;
      if (
        presentationRoots.has(parts[0]) ||
        (parts[0] === "agents" && parts[2] === "name")
      )
        add("presentation", path);
      else if (parts[0] === "execution") add("runtime", path);
      else if (parts[0] === "permissions") add("runtime", path);
      else if (parts[0] === "workflow" && runtimeWorkflow.has(parts[1]))
        add("runtime", path);
      else if (
        state.results.pentester?.status === "BLOCKED" &&
        ["pentest.localHttp.allowedOrigins", "pentest.localUrls"].includes(path)
      )
        add("runtime", path);
      else if (path === "workflow.solverCount")
        add(solveStarted ? "semantic" : "future-agent", path);
      else if (parts[0] === "agents") {
        if (runtimeAgent.has(parts[2])) add("runtime", path);
        else add(hasRun(state, parts[1]) ? "semantic" : "future-agent", path);
      } else add("semantic", path);
    }
  }
  for (const [role] of promptChanged)
    if (
      !solverIds.includes(role as any) ||
      getActiveSolverIds(current.config).includes(role as any)
    )
      add(
        hasRun(state, role) ? "semantic" : "future-agent",
        `agents.${role}.prompt`,
      );
  for (const key of [
    "semanticChanges",
    "runtimeChanges",
    "presentationChanges",
    "futureAgentChanges",
  ] as const)
    result[key] = [...new Set(result[key])].sort();
  result.blocking = result.semanticChanges.length > 0;
  return result;
}

export function driftSummary(analysis: ConfigDriftAnalysis): string {
  return [
    `Blocking semantic changes: ${analysis.semanticChanges.join(", ") || "none"}`,
    `Non-blocking runtime changes: ${analysis.runtimeChanges.join(", ") || "none"}`,
    `Non-blocking presentation changes: ${analysis.presentationChanges.join(", ") || "none"}`,
    `Future-agent changes: ${analysis.futureAgentChanges.join(", ") || "none"}`,
  ].join("\n");
}

export function acceptConfigDrift(
  state: WorkflowState,
  current: TeamDefinition,
  analysis: ConfigDriftAnalysis,
) {
  if (analysis.blocking)
    throw new Error("Cannot accept blocking configuration drift");
  const previous = state.driftConfigSnapshot;
  if (previous) {
    const merged = structuredClone(state.config) as Record<string, any>;
    const source = current.config as Record<string, any>;
    for (const path of differences(previous, current.config)) {
      const keys = path.split(".");
      let target = merged,
        next = source;
      for (const key of keys.slice(0, -1)) {
        target = target[key];
        next = next[key];
      }
      const leaf = keys.at(-1)!;
      if (next[leaf] === undefined) delete target[leaf];
      else target[leaf] = structuredClone(next[leaf]);
    }
    state.config = merged as TeamConfig;
  }
  state.teamConfigPath = current.path;
  state.teamConfigHash = current.configHash;
  state.semanticConfigHash = current.semanticConfigHash;
  state.driftConfigSnapshot = current.config;
  state.agentPromptHashes = current.agentPromptHashes;
  if (analysis.changed)
    state.history.push({
      at: new Date().toISOString(),
      phase: state.phase,
      event: "config_drift_accepted",
      detail: JSON.stringify({
        classification: [
          ...new Set([
            ...(analysis.runtimeChanges.length ? ["runtime"] : []),
            ...(analysis.presentationChanges.length ? ["presentation"] : []),
            ...(analysis.futureAgentChanges.length ? ["future-agent"] : []),
          ]),
        ],
        paths: [
          ...analysis.runtimeChanges,
          ...analysis.presentationChanges,
          ...analysis.futureAgentChanges,
        ],
      }),
    });
}
