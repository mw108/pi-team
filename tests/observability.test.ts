import test from "node:test";
import assert from "node:assert/strict";
import { stat, readFile, realpath, appendFile } from "node:fs/promises";
import { join } from "node:path";
import { config, repository, FixtureRunner, output } from "./helpers.ts";
import { configSchema } from "../src/config/schema.ts";
import {
  AgentTimeoutError,
  getAgentTimeoutMs,
  classifyFailure,
} from "../src/agents/errors.ts";
import {
  PiRunner,
  type ActivityObserver,
  type OutputObserver,
} from "../src/agents/runner.ts";
import { WorkflowEngine } from "../src/workflow/engine.ts";
import { AgentLogStore } from "../src/workflow/agent-logs.ts";
import {
  classifyToolActivity,
  formatToolActivity,
} from "../src/ui/activity.ts";
import { ProgressRuntime } from "../src/ui/runtime.ts";
import { renderProgress } from "../src/ui/progress.ts";
import teamExtension from "../src/index.ts";
import type { Role } from "../src/agents/schemas.ts";
import type { WorkflowState } from "../src/workflow/state.ts";

const ui = { progress: () => {}, ask: async () => undefined };

test("role timeout takes precedence and invalid budgets are rejected", () => {
  const cfg = config();
  cfg.workflow.agentTimeoutMs = 300000;
  cfg.agents.researcher.timeoutMs = 900000;
  assert.equal(getAgentTimeoutMs(cfg, "researcher"), 900000);
  assert.equal(getAgentTimeoutMs(cfg, "critic"), 300000);
  for (const timeoutMs of [0, -1, 999, 3600001, 1.5])
    assert.equal(
      configSchema.safeParse({
        ...cfg,
        agents: {
          ...cfg.agents,
          researcher: { ...cfg.agents.researcher, timeoutMs },
        },
      }).success,
      false,
    );
  const error = new AgentTimeoutError("researcher", 1000, 2);
  assert.deepEqual(
    [error.agentId, error.timeoutMs, error.attempt, classifyFailure(error)],
    ["researcher", 1000, 2, "timeout"],
  );
});

test("provider abort rejection caused by the timer remains a typed timeout", async () => {
  const cwd = await repository();
  const cfg = config();
  cfg.agents.researcher.timeoutMs = 1000;
  const engine = new WorkflowEngine(cwd, new FixtureRunner(), ui);
  const state = await engine.start("Fix", cfg);
  const runner = new PiRunner();
  runner.createSession = async () => {
    let rejectPrompt: ((error: Error) => void) | undefined;
    return {
      messages: [],
      prompt: () =>
        new Promise((_resolve, reject) => {
          rejectPrompt = reject;
        }),
      abort: async () => rejectPrompt?.(new Error("provider aborted")),
      getLastAssistantText: () => "visible partial response",
      extensionRunner: { emit: async () => {} },
      dispose: () => {},
    } as any;
  };
  const visible: string[] = [];
  await assert.rejects(
    () =>
      runner.run("researcher", state, undefined, undefined, 3, (text) =>
        visible.push(text),
      ),
    (error: unknown) =>
      error instanceof AgentTimeoutError &&
      error.attempt === 3 &&
      error.timeoutMs === 1000,
  );
  assert.deepEqual(visible, ["visible partial response"]);
});

test("configured and installed tool classification is provider-neutral", () => {
  const cfg = config();
  cfg.toolActivity.mappings = {
    "exa_*": { category: "web-search", provider: "Exa" },
    google_search: { category: "web-search", provider: "Google" },
    "custom_*": { category: "web-search", provider: "Custom" },
    custom_exact: { category: "documentation", provider: "Docs" },
  };
  for (const name of [
    "exa_search",
    "google_search",
    "custom_search",
    "web_search",
  ])
    assert.equal(formatToolActivity(name, cfg), "Web search");
  assert.equal(
    classifyToolActivity("mcp", cfg, "context7_query-docs").label,
    "Context7",
  );
  assert.equal(formatToolActivity("mcp_unknown_tool", cfg), "MCP tool");
  assert.equal(formatToolActivity("mcp", cfg, "unknown_tool"), "MCP tool");
  assert.equal(formatToolActivity("weird_token?secret"), "Using tool");
  assert.equal(formatToolActivity("custom_exact", cfg), "Documentation");
  cfg.ui.progress.showToolProvider = true;
  assert.equal(formatToolActivity("exa_search", cfg), "Web search · Exa");
  assert.equal(formatToolActivity("google_search", cfg), "Web search · Google");
  assert.equal(
    configSchema.safeParse({
      ...cfg,
      toolActivity: { mappings: { "bad/secret*": { category: "web-search" } } },
    }).success,
    false,
  );
  assert.equal(
    configSchema.safeParse({
      ...cfg,
      toolActivity: {
        mappings: { x: { category: "web-search", provider: "Bearer secret" } },
      },
    }).success,
    false,
  );
});

test("timed out read-only attempts persist history, logs, output and retry UI", async () => {
  const cwd = await repository();
  const cfg = config();
  cfg.qualityGates.commit.enabled = false;
  cfg.workflow.maxAgentFailures = 2;
  cfg.agents.researcher.timeoutMs = 1000;
  const pi = new PiRunner();
  pi.createSession = async () =>
    ({
      messages: [],
      prompt: async () => {
        await new Promise((resolve) => setTimeout(resolve, 1050));
      },
      getLastAssistantText: () => "partial visible API_KEY=topsecret",
      abort: async () => {},
      extensionRunner: { emit: async () => {} },
      dispose: () => {},
    }) as any;
  class TimedFixture extends FixtureRunner {
    override async run(
      role: Role,
      state: WorkflowState,
      signal?: AbortSignal,
      activity?: ActivityObserver,
      attempt?: number,
      visible?: OutputObserver,
    ) {
      if (role === "researcher")
        return pi.run(role, state, signal, activity, attempt, visible);
      return super.run(role, state);
    }
  }
  let runtime!: ProgressRuntime;
  const snapshots: string[] = [];
  runtime = new ProgressRuntime(() => {}, 2000, Date.now, false);
  const engine = new WorkflowEngine(cwd, new TimedFixture(), {
    ...ui,
    progress: (state) => runtime.bind(state),
    agentEvent: (event) => {
      runtime.event(event);
      if (runtime.state)
        snapshots.push(renderProgress(runtime.state, runtime).join("\n"));
    },
  });
  const state = await engine.start("Fix", cfg);
  await engine.run(state);
  assert.equal(state.phase, "BLOCKED");
  assert.equal(state.agentFailures, 2);
  assert.deepEqual(
    state.history
      .filter(
        (h) =>
          h.meta?.agent === "researcher" &&
          [
            "agent_attempt_started",
            "agent_attempt_failed",
            "agent_retry",
          ].includes(h.event),
      )
      .map((h) => h.event),
    [
      "agent_attempt_started",
      "agent_attempt_failed",
      "agent_retry",
      "agent_attempt_started",
      "agent_attempt_failed",
    ],
  );
  assert.equal(
    state.history
      .filter(
        (h) =>
          h.event === "agent_attempt_failed" && h.meta?.agent === "researcher",
      )
      .every((h) => h.meta?.reason === "timeout" && h.meta.timeoutMs === 1000),
    true,
  );
  assert.match(
    snapshots.join("\n"),
    /Previous attempt failed: timeout after 00:01/,
  );
  assert.match(
    renderProgress(state).join("\n"),
    /Final error: timeout after 00:01 · attempt 2/,
  );
  const logs = new AgentLogStore(cwd);
  assert.deepEqual(await logs.attempts(state.id, "researcher"), [1, 2]);
  assert.match(await logs.overview(state.id), /attempt 1  ✗ timeout/);
  assert.match(
    await logs.timeline(state.id, "researcher", 1),
    /timeout after 00:01/,
  );
  assert.match(await logs.timeline(state.id, "researcher"), /attempt 2/);
  assert.match(await logs.timeline(state.id, "researcher", 3), /No log/);
  const first = await readFile(logs.path(state.id, "researcher", 1), "utf8");
  assert.match(first, /assistant_output/);
  assert.match(first, /\[REDACTED\]/);
  assert.doesNotMatch(first, /topsecret|reasoning|scratchpad/);
  assert.match(first, /"type":"retry"/);
  assert.equal(
    (await stat(logs.path(state.id, "researcher", 1))).mode & 0o777,
    0o600,
  );
  assert.ok(
    logs
      .path(state.id, "researcher", 1)
      .startsWith(join(await realpath(cwd), ".pi", "team", "state")),
  );
  assert.equal((await engine.store.load(state.id)).phase, "BLOCKED");
  runtime.dispose();
});

test("tool events, visible output and /team-log command remain concise", async () => {
  const cwd = await repository();
  const cfg = config();
  cfg.toolActivity.mappings = {
    "exa_*": { category: "web-search", provider: "Exa" },
  };
  class ObservingFixture extends FixtureRunner {
    override async run(
      role: Role,
      state: WorkflowState,
      _signal?: AbortSignal,
      activity?: ActivityObserver,
      _attempt?: number,
      visible?: OutputObserver,
    ) {
      activity?.("serena_find_symbol", "one");
      activity?.(undefined, "one", undefined, true);
      activity?.("mcp", "two", "exa_search");
      activity?.(undefined, "two", undefined, false);
      visible?.("visible assistant API_KEY=mysecret");
      return super.run(role, state);
    }
  }
  const engine = new WorkflowEngine(cwd, new ObservingFixture(), ui);
  const state = await engine.start("Fix", cfg);
  await engine.invoke("researcher", state);
  const logs = new AgentLogStore(cwd);
  const events = await logs.read(state.id, "researcher", 1);
  assert.deepEqual(
    events.filter((e) => e.type === "tool_start").map((e) => e.activity),
    ["Serena: symbols", "Web search"],
  );
  assert.equal(
    events.find((e) => e.type === "tool_start" && e.activity === "Web search")
      ?.provider,
    "Exa",
  );
  assert.equal(
    events.find((e) => e.type === "tool_end" && e.tool === "exa_search")
      ?.success,
    false,
  );
  assert.equal(
    events.find((e) => e.type === "assistant_output")?.text,
    "visible assistant API_KEY=[REDACTED]",
  );
  assert.doesNotMatch(
    JSON.stringify(events),
    /mysecret|tool args|hidden reasoning/,
  );
  const commands = new Map<string, any>();
  const notices: string[] = [];
  teamExtension({
    on: () => {},
    registerCommand: (name: string, command: any) =>
      commands.set(name, command),
  } as any);
  const ctx = { cwd, ui: { notify: (value: string) => notices.push(value) } };
  await commands.get("team-log").handler("", ctx);
  assert.match(
    notices.at(-1) ?? "",
    /researcher\nattempt 1|researcher\n  attempt 1/,
  );
  await commands.get("team-log").handler("researcher", ctx);
  assert.match(notices.at(-1) ?? "", /Serena: symbols/);
  await commands.get("team-log").handler("researcher --attempt 1", ctx);
  assert.match(notices.at(-1) ?? "", /Web search/);
  await commands.get("team-log").handler("researcher --attempt 9", ctx);
  assert.match(notices.at(-1) ?? "", /No log/);
});

test("running attempts are readable and logging off still preserves history", async () => {
  const cwd = await repository();
  const cfg = config();
  const engine = new WorkflowEngine(cwd, new FixtureRunner(), ui);
  const state = await engine.start("Fix", cfg);
  const logs = new AgentLogStore(cwd);
  const { logger } = await logs.create(state.id, "researcher");
  logger.append({ type: "agent_start", agent: "researcher", attempt: 1 });
  await logger.flush();
  assert.match(await logs.overview(state.id), /attempt 1  ● running/);
  assert.match(
    await logs.timeline(state.id, "researcher"),
    /running or interrupted/,
  );
  await appendFile(logs.path(state.id, "researcher", 1), '{"type":"partial"');
  assert.match(
    await logs.timeline(state.id, "researcher"),
    /running or interrupted/,
  );
  state.config.logging.agentLogs.level = "off";
  await engine.invoke("critic", state);
  assert.deepEqual(await logs.attempts(state.id, "critic"), []);
  assert.ok(
    state.history.some(
      (entry) =>
        entry.event === "agent_attempt_completed" &&
        entry.meta?.agent === "critic",
    ),
  );
});
