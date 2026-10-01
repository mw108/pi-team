import test from "node:test";
import assert from "node:assert/strict";
import {
  stat,
  readFile,
  realpath,
  appendFile,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import YAML from "yaml";
import { config, repository, FixtureRunner, output } from "./helpers.ts";
import { configSchema } from "../src/config/schema.ts";
import {
  AgentTimeoutError,
  formatAgentTimeout,
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
import { commandTool } from "../src/agents/commands.ts";
import { effectiveConfig } from "../src/agents/discovery.ts";
import {
  classifyToolActivity,
  formatToolActivity,
} from "../src/ui/activity.ts";
import { ProgressRuntime } from "../src/ui/runtime.ts";
import { renderProgress } from "../src/ui/progress.ts";
import teamExtension from "../src/index.ts";
import { doctor } from "../src/integrations/doctor.ts";
import type { Role } from "../src/agents/schemas.ts";
import type { WorkflowState } from "../src/workflow/state.ts";

const ui = { progress: () => {}, ask: async () => undefined };

test("agent and global timeout validation, inheritance, and runtime resolution", () => {
  const cfg = config();
  cfg.workflow.agentTimeoutMs = 300000;
  cfg.agents.researcher.timeoutMs = 900000;
  assert.equal(getAgentTimeoutMs(cfg, "researcher"), 900000);
  assert.equal(getAgentTimeoutMs(cfg, "critic"), 300000);
  cfg.agents.researcher.timeoutMs = 0;
  assert.equal(getAgentTimeoutMs(cfg, "researcher"), undefined);
  assert.equal(
    formatAgentTimeout(getAgentTimeoutMs(cfg, "researcher")),
    "unlimited",
  );
  assert.equal(configSchema.safeParse(cfg).success, true);
  cfg.workflow.agentTimeoutMs = 0;
  assert.equal(getAgentTimeoutMs(cfg, "critic"), undefined);
  cfg.agents.researcher.timeoutMs = 900000;
  assert.equal(getAgentTimeoutMs(cfg, "researcher"), 900000);
  assert.equal(
    formatAgentTimeout(getAgentTimeoutMs(cfg, "researcher")),
    "900000 ms",
  );
  assert.equal(configSchema.safeParse(cfg).success, true);
  delete cfg.agents.researcher.timeoutMs;
  assert.equal(getAgentTimeoutMs(cfg, "researcher"), undefined);
  assert.equal(configSchema.safeParse(cfg).success, true);
  for (const timeoutMs of [-1, 500, 999, 3600001, 1.5, NaN, Infinity, "1000"])
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
  for (const agentTimeoutMs of [-1, 500, 3600001, 1.5, NaN, Infinity, "1000"])
    assert.equal(
      configSchema.safeParse({
        ...cfg,
        workflow: { ...cfg.workflow, agentTimeoutMs },
      }).success,
      false,
    );
  const error = new AgentTimeoutError("researcher", 1000, 2);
  assert.deepEqual(
    [error.agentId, error.timeoutMs, error.attempt, classifyFailure(error)],
    ["researcher", 1000, 2, "timeout"],
  );
});

test("deterministic runner fixture: positive timeout, unlimited completion, cancellation", async () => {
  const cwd = await repository();
  const cfg = config();
  cfg.workflow.agentTimeoutMs = 1000;
  cfg.agents.researcher.timeoutMs = 1000;
  const engine = new WorkflowEngine(cwd, new FixtureRunner(), ui);
  const state = await engine.start("Timeout fixture", cfg);
  const runner = new PiRunner();
  let aborts = 0;
  runner.createSession = async () => {
    let rejectPrompt: ((error: Error) => void) | undefined;
    return {
      messages: [{ role: "assistant", stopReason: "end" }],
      prompt: () =>
        new Promise<void>((resolve, reject) => {
          rejectPrompt = reject;
          setTimeout(resolve, 1150);
        }),
      abort: async () => {
        aborts++;
        rejectPrompt?.(new Error("provider aborted"));
      },
      getLastAssistantText: () => JSON.stringify(output("researcher")),
      extensionRunner: { emit: async () => {} },
      dispose: () => {},
    } as any;
  };
  await assert.rejects(
    () => runner.run("researcher", state),
    (error: unknown) =>
      error instanceof AgentTimeoutError && error.timeoutMs === 1000,
  );
  state.config.agents.researcher.timeoutMs = 0;
  assert.deepEqual(await runner.run("researcher", state), output("researcher"));
  const controller = new AbortController();
  const cancelled = runner.run("researcher", state, controller.signal);
  setTimeout(() => controller.abort(), 100);
  await assert.rejects(cancelled, /provider aborted|Workflow interrupted/);
  assert.equal(aborts, 2);
});

test("unlimited attempts log clear mode, cancellation, and provider failures do not hard retry", async () => {
  const cwd = await repository();
  const cfg = config();
  cfg.workflow.agentTimeoutMs = 0;
  cfg.agents.researcher.timeoutMs = 0;
  const retryRunner = new FixtureRunner(async (role, _state, count) => {
    if (role === "researcher" && count === 1)
      throw Object.assign(new Error("provider unavailable"), { status: 503 });
  });
  const engine = new WorkflowEngine(cwd, retryRunner, ui);
  const state = await engine.start("Retry fixture", cfg);
  await assert.rejects(
    () => engine.invoke("researcher", state),
    /provider unavailable/,
  );
  assert.equal(retryRunner.counts.researcher, 1);
  assert.deepEqual(
    state.history
      .filter((entry) => entry.event === "agent_retry")
      .map((entry) => entry.meta?.reason),
    [],
  );
  assert.equal(
    state.history.find((entry) => entry.event === "agent_attempt_started")?.meta
      ?.timeoutMs,
    null,
  );
  assert.equal(
    state.history.find((entry) => entry.event === "agent_attempt_started")?.meta
      ?.timeoutMode,
    "unlimited",
  );
  const logs = new AgentLogStore(cwd);
  const first = await logs.read(state.id, "researcher", 1);
  assert.equal(first[0].timeoutMs, null);
  assert.equal(first[0].timeoutMode, "unlimited");
  assert.equal(
    first.some((event) => event.category === "timeout"),
    false,
  );

  const providerTimeoutRunner = new FixtureRunner(
    async (role, _state, count) => {
      if (role === "researcher" && count === 1)
        throw new Error("provider request timed out");
    },
  );
  const providerTimeoutEngine = new WorkflowEngine(
    cwd,
    providerTimeoutRunner,
    ui,
  );
  const providerTimeoutState = await providerTimeoutEngine.start(
    "Provider timeout fixture",
    cfg,
  );
  await assert.rejects(
    () => providerTimeoutEngine.invoke("researcher", providerTimeoutState),
    /provider request timed out/,
  );
  assert.deepEqual(
    providerTimeoutState.history
      .filter((entry) => entry.event === "agent_retry")
      .map((entry) => entry.meta?.reason),
    [],
  );

  const pi = new PiRunner();
  pi.createSession = async () => {
    let rejectPrompt: ((error: Error) => void) | undefined;
    return {
      messages: [],
      prompt: () =>
        new Promise((_resolve, reject) => {
          rejectPrompt = reject;
        }),
      abort: async () => rejectPrompt?.(new Error("provider aborted")),
      getLastAssistantText: () => "",
      extensionRunner: { emit: async () => {} },
      dispose: () => {},
    } as any;
  };
  const cancelEngine = new WorkflowEngine(cwd, pi, ui);
  const cancelState = await cancelEngine.start("Cancel fixture", cfg);
  const controller = new AbortController();
  const pending = cancelEngine.invoke(
    "researcher",
    cancelState,
    controller.signal,
  );
  setTimeout(() => controller.abort(), 100);
  await assert.rejects(pending, /provider aborted|Workflow interrupted/);
  const cancelled = await new AgentLogStore(cwd).read(
    cancelState.id,
    "researcher",
    1,
  );
  assert.equal(cancelled[0].timeoutMs, null);
  assert.equal(cancelled[0].timeoutMode, "unlimited");
  assert.equal(
    cancelled.find((event) => event.type === "provider_error")?.category,
    "cancelled",
  );
  assert.equal(
    cancelled.some(
      (event) => event.type === "retry" || event.category === "timeout",
    ),
    false,
  );
  assert.equal(
    cancelState.history.find((entry) => entry.event === "agent_attempt_failed")
      ?.meta?.reason,
    "cancelled",
  );
});

test("doctor displays unlimited and positive agent timeouts", async () => {
  const cwd = await repository();
  const cfg = config();
  cfg.agents.researcher.timeoutMs = 0;
  cfg.agents.researcher.networkRetry = { maxRetries: 0 };
  cfg.agents.solver1.timeoutMs = 900000;
  await writeFile(join(cwd, ".pi", "team", "team.yaml"), YAML.stringify(cfg));
  const result = await doctor(cwd);
  assert.match(result.lines.join("\n"), /researcher: .*timeout unlimited/);
  assert.match(
    result.lines.join("\n"),
    /network retry: unlimited max retries; 3000 ms delay/,
  );
  assert.match(result.lines.join("\n"), /solver1: .*timeout 900000 ms/);
  assert.doesNotMatch(result.lines.join("\n"), /timeout 0 ms/);
  cfg.agents.researcher.timeoutMs = -1;
  await writeFile(join(cwd, ".pi", "team", "team.yaml"), YAML.stringify(cfg));
  const invalid = await doctor(cwd);
  assert.equal(invalid.ok, false);
  assert.match(invalid.lines.join("\n"), /Configuration: FAIL.*timeoutMs/s);
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
    /Previous run failed: timeout after 00:01/,
  );
  assert.match(
    renderProgress(state).join("\n"),
    /Final error: timeout after 00:01 · run 2/,
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
  cfg.agents.researcher.name = "Research Analyst";
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
    /Research Analyst \(researcher\)\n  attempt 1/,
  );
  await commands.get("team-log").handler("researcher", ctx);
  assert.match(
    notices.at(-1) ?? "",
    /Research Analyst \(researcher\) · attempt 1/,
  );
  assert.match(notices.at(-1) ?? "", /Serena: symbols/);
  await commands.get("team-log").handler("researcher --attempt 1", ctx);
  assert.match(notices.at(-1) ?? "", /Web search/);
  await commands.get("team-log").handler("researcher --attempt 9", ctx);
  assert.match(notices.at(-1) ?? "", /No log/);
});

test("JSONL tool starts contain only sanitized summaries", async () => {
  const cwd = await repository();
  class SummaryFixture extends FixtureRunner {
    override async run(
      role: Role,
      state: WorkflowState,
      _signal?: AbortSignal,
      activity?: ActivityObserver,
    ) {
      activity?.("read", "read-1", undefined, undefined, {
        path: `${state.cwd}/src/foo.ts`,
        offset: 120,
        limit: 80,
        content: "TOP_SECRET",
      });
      activity?.(undefined, "read-1", undefined, true);
      activity?.("grep", "grep-1", undefined, undefined, {
        path: "src",
        pattern: "passwordsMismatch",
        authorization: "TOP_SECRET",
      });
      activity?.(undefined, "grep-1", undefined, true);
      activity?.("edit", "edit-1", undefined, undefined, {
        path: "src/foo.ts",
        replacement: "TOP_SECRET",
      });
      activity?.(undefined, "edit-1", undefined, true);
      return super.run(role, state);
    }
  }
  const engine = new WorkflowEngine(cwd, new SummaryFixture(), ui);
  const state = await engine.start("Fix", config());
  await engine.invoke("researcher", state);
  const starts = (
    await new AgentLogStore(cwd).read(state.id, "researcher", 1)
  ).filter((event) => event.type === "tool_start");
  assert.deepEqual(
    starts.map((event) => event.summary),
    [
      { path: "src/foo.ts", offset: 120, limit: 80 },
      { path: "src", pattern: "passwordsMismatch" },
      { path: "src/foo.ts" },
    ],
  );
  assert.doesNotMatch(
    JSON.stringify(starts),
    /TOP_SECRET|authorization|Users\//,
  );
});

test("team_command JSONL and /team-log use only resolved approved metadata", async () => {
  const cwd = await repository();
  const cfg = config();
  cfg.commands = [];
  const approvedCommands = [
    {
      id: "detected-e3bc24c70676",
      executable: "vendor/bin/phpunit",
      args: [],
      purpose: "test",
      timeoutMs: 120000,
    },
    {
      id: "detected-abc",
      executable: "php",
      args: ["artisan", "test", "--filter=test_register_with_valid_data"],
      purpose: "test",
      timeoutMs: 120000,
    },
    {
      id: "detected-secret",
      executable: "php",
      args: ["artisan", "test", "--token", "super-secret-value"],
      purpose: "test",
      timeoutMs: 120000,
    },
  ] as const;
  class CommandFixture extends FixtureRunner {
    override async run(
      role: Role,
      state: WorkflowState,
      _signal?: AbortSignal,
      activity?: ActivityObserver,
    ) {
      for (const id of [
        "detected-e3bc24c70676",
        "detected-abc",
        "detected-secret",
        "detected-unknown",
      ]) {
        activity?.("team_command", id, undefined, undefined, {
          id,
          executable: "untrusted-shell",
          args: ["TOP_SECRET"],
          purpose: "development",
        });
        activity?.(undefined, id, undefined, id !== "detected-unknown");
      }
      return output(role);
    }
  }
  const engine = new WorkflowEngine(cwd, new CommandFixture(), ui);
  const state = await engine.start("Fix", cfg);
  state.approvedCommands = approvedCommands.map((command) => ({
    ...command,
    args: [...command.args],
  }));
  state.discoveredCommands = state.approvedCommands.map((command) => ({
    command,
    source: "test fixture",
    category: "test",
    confidence: "high",
  }));
  state.commandApprovalComplete = true;
  await engine.store.save(state);
  await engine.invoke("implementor", state);
  const logs = new AgentLogStore(cwd);
  const starts = (await logs.read(state.id, "implementor", 1)).filter(
    (event) => event.type === "tool_start",
  );
  assert.deepEqual(
    starts.map((event) => event.summary),
    [
      {
        command: "detected-e3bc24c70676",
        commandId: "detected-e3bc24c70676",
        executable: "vendor/bin/phpunit",
        args: [],
        purpose: "test",
      },
      {
        command: "detected-abc",
        commandId: "detected-abc",
        executable: "php",
        args: ["artisan", "test", "--filter=test_register_with_valid_data"],
        purpose: "test",
      },
      {
        command: "detected-secret",
        commandId: "detected-secret",
        executable: "php",
        args: ["artisan", "test", "--token", "[REDACTED]"],
        purpose: "test",
      },
      { command: "detected-unknown", commandId: "detected-unknown" },
    ],
  );
  assert.doesNotMatch(
    JSON.stringify(starts),
    /untrusted-shell|TOP_SECRET|super-secret-value/,
  );
  assert.match(
    await logs.timeline(state.id, "implementor", 1),
    /team_command · Test: vendor\/bin\/phpunit/,
  );
  assert.doesNotMatch(
    await logs.timeline(state.id, "implementor", 1),
    /super-secret-value/,
  );
  await assert.rejects(
    () =>
      commandTool("implementor", effectiveConfig(state), cwd, []).execute(
        "unknown",
        { id: "detected-unknown" },
        undefined,
        undefined,
        {} as any,
      ),
    /not approved/,
  );
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
