import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { repository, config, FixtureRunner, output } from "./helpers.ts";
import { WorkflowEngine } from "../src/workflow/engine.ts";
import { commandTool } from "../src/agents/commands.ts";
import {
  commandSummary,
  formatCommandLine,
} from "../src/agents/command-observability.ts";
import {
  normalizedRuntimeCommand,
  ruleMatches,
  similarCommandRuleSchema,
} from "../src/agents/runtime-commands.ts";
import { effectiveConfig } from "../src/agents/discovery.ts";
import { renderProgress } from "../src/ui/progress.ts";
import {
  toolSignature,
  DoomLoopDetector,
  resolveDoomLoop,
} from "../src/agents/doom-loop.ts";
import { AgentLogStore } from "../src/workflow/agent-logs.ts";
import { formatToolActivity } from "../src/ui/activity.ts";
import { getWorkflowRecoveryPlan } from "../src/workflow/recovery.ts";
import type { Role } from "../src/agents/schemas.ts";
import { validateState } from "../src/workflow/state.ts";

async function fixture(answers: (string[] | undefined)[] = []) {
  const cwd = await repository();
  const requests: any[] = [];
  const events: any[] = [];
  const engine = new WorkflowEngine(cwd, new FixtureRunner(), {
    progress: () => {},
    ask: async () => undefined,
    approve: async (request) => {
      requests.push(request);
      return answers.shift();
    },
  });
  const state = await engine.start("Fix", config());
  const controls = new Map<Role, any>();
  const control = (role: Role, run = 1) => {
    const item = {
      workflowId: state.id,
      controller: new AbortController(),
      attempt: run,
    };
    controls.set(role, item);
    (engine as any).activeAttempts.set(role, item);
    return item;
  };
  const approve = (role: Role, run: any, input: unknown) => {
    const { command, request } = normalizedRuntimeCommand(input, role);
    return (engine as any).runtimeCommandApproval(
      state,
      state,
      role,
      run,
      command,
      request,
      run.controller.signal,
      (event: any) => events.push(event),
    ) as Promise<"allow" | "deny" | "pending">;
  };
  return { cwd, engine, state, requests, events, control, approve };
}

test("command redaction is key-driven for separate and inline forms across display surfaces", () => {
  for (const key of ["token", "api-key", "authorization", "credential"]) {
    for (const args of [[`--${key}`, "SECRET"], [`--${key}=SECRET`]]) {
      const command = {
        id: "detected-safe",
        executable: "php",
        args,
        purpose: "test" as const,
        timeoutMs: 1000,
      };
      const safe = commandSummary(command.id, command);
      assert.doesNotMatch(JSON.stringify(safe), /SECRET/);
      assert.doesNotMatch(formatCommandLine(command), /SECRET/);
      assert.match(formatCommandLine(command), /\[REDACTED\]/);
      assert.doesNotMatch(
        formatToolActivity("team_command", undefined, undefined, safe),
        /SECRET/,
      );
    }
  }
  const benign = {
    id: "detected-benign",
    executable: "php",
    args: ["--filter=test_token_parser", "--name=authorization-service"],
    purpose: "test" as const,
    timeoutMs: 1000,
  };
  assert.deepEqual(commandSummary(benign.id, benign).args, benign.args);
  const bearer = { ...benign, args: ["--authorization", "Bearer", "SECRET"] };
  assert.deepEqual(commandSummary(bearer.id, bearer).args, [
    "--authorization",
    "[REDACTED]",
    "[REDACTED]",
  ]);
});

test("allow once executes exactly once per prompt and keeps workflow approvals empty", async () => {
  const f = await fixture([["allow_once"], ["allow_once"]]);
  const run = f.control("implementor");
  const input = {
    executable: process.execPath,
    args: ["-e", "process.stdout.write('ok')"],
    purpose: "Check runtime",
    category: "development",
  };
  const evidence: any[] = [];
  const tool = commandTool(
    "implementor",
    effectiveConfig(f.state),
    f.cwd,
    evidence,
    (command, request, signal) =>
      (f.engine as any).runtimeCommandApproval(
        f.state,
        f.state,
        "implementor",
        run,
        command,
        request,
        signal,
        (event: any) => f.events.push(event),
      ),
    () => effectiveConfig(f.state, "implementor").commands,
  );
  for (let i = 0; i < 2; i++) {
    const result = await tool.execute(
      `call-${i}`,
      input,
      run.controller.signal,
      undefined,
      {} as any,
    );
    assert.equal((result.details as any).exitCode, 0);
  }
  assert.equal(f.requests.length, 2);
  assert.equal(evidence.length, 2);
  assert.ok(evidence.every((item) => item.sandbox.temporaryHome));
  assert.ok(evidence.every((item) => item.sandbox.mode !== "none"));
  assert.equal(f.state.approvedCommands.length, 0);
  assert.equal(f.state.runtimeApprovedCommandIds.length, 0);
});

test("discovered command metadata appears when runtime approval is requested", async () => {
  const f = await fixture([["deny"]]);
  const command = normalizedRuntimeCommand(
    {
      executable: "vendor/bin/phpunit",
      args: [],
      purpose: "Run repository tests",
      category: "test",
    },
    "tester",
  ).command;
  f.state.discoveredCommands = [
    { command, source: "phpunit.xml", category: "test", confidence: "medium" },
  ];
  assert.equal(
    await f.approve("tester", f.control("tester"), {
      executable: "vendor/bin/phpunit",
      args: [],
      purpose: "Run repository tests",
      category: "test",
    }),
    "deny",
  );
  assert.equal(f.requests.length, 1);
  assert.match(f.requests[0].prompt, /Purpose: test/);
  assert.match(f.requests[0].prompt, /Source: phpunit.xml/);
  assert.match(f.requests[0].prompt, /Confidence: medium/);
  assert.equal(f.state.approvedCommands.length, 0);
});

test("generic runtime approval uses neutral wording and exact scope", async () => {
  const f = await fixture([["deny"]]);
  const role = "implementor";
  assert.equal(
    await f.approve(role, f.control(role), {
      executable: process.execPath,
      args: ["--version"],
      purpose: "Check the local runtime",
      category: "development",
    }),
    "deny",
  );
  const request = f.requests[0];
  assert.match(request.prompt, /Agent: .*implementor/);
  assert.match(request.prompt, /Category: development/);
  assert.match(request.prompt, /Purpose: Check the local runtime/);
  assert.match(request.prompt, /Scope: exact command/);
  assert.doesNotMatch(
    request.prompt,
    /artisan|phpunit|tests\/Feature|migrate:fresh/i,
  );
  assert.deepEqual(
    request.options.map((option: { value: string }) => option.value),
    ["allow_once", "allow_workflow", "deny"],
  );
});

test("workflow exact approval is reused and survives state reload; configured commands stay immediate", async () => {
  const f = await fixture([["allow_workflow"]]);
  const run = f.control("implementor");
  const input = {
    executable: process.execPath,
    args: ["-e", "process.stdout.write('ok')"],
    purpose: "Check runtime",
    category: "development",
  };
  const evidence: any[] = [];
  const tool = commandTool(
    "implementor",
    effectiveConfig(f.state),
    f.cwd,
    evidence,
    (command, request, signal) =>
      (f.engine as any).runtimeCommandApproval(
        f.state,
        f.state,
        "implementor",
        run,
        command,
        request,
        signal,
        () => {},
      ),
    () => effectiveConfig(f.state).commands,
  );
  await tool.execute(
    "first",
    input,
    run.controller.signal,
    undefined,
    {} as any,
  );
  await tool.execute(
    "second",
    input,
    run.controller.signal,
    undefined,
    {} as any,
  );
  assert.equal(f.requests.length, 1);
  assert.equal(f.state.runtimeCommandApprovals.length, 1);
  const loaded = await f.engine.store.load(f.state.id);
  assert.deepEqual(
    loaded.runtimeCommandApprovals,
    f.state.runtimeCommandApprovals,
  );
  assert.deepEqual(
    loaded.runtimeApprovedCommandIds,
    f.state.runtimeApprovedCommandIds,
  );
  const configured = commandTool(
    "implementor",
    effectiveConfig(f.state),
    f.cwd,
    [],
  );
  const result = await configured.execute(
    "configured",
    { id: "test" },
    undefined,
    undefined,
    {} as any,
  );
  assert.equal((result.details as any).id, "test");
  assert.equal((result.details as any).sandbox.temporaryHome, true);
});

test("similar approval persists an explicit test prefix and excludes destructive artisan commands", async () => {
  const f = await fixture([["allow_similar"], ["deny"]]);
  const run = f.control("implementor");
  const input = {
    executable: "php",
    args: ["artisan", "test", "--filter=Foo"],
    purpose: "Focused test",
    category: "test",
  };
  assert.equal(await f.approve("implementor", run, input), "allow");
  assert.deepEqual(f.state.similarCommandRules, [
    {
      executable: "php",
      argsPrefix: ["artisan", "test"],
      category: "test",
      role: "implementor",
    },
  ]);
  assert.equal(
    similarCommandRuleSchema.safeParse({
      executable: "php",
      argsPrefix: ["artisan"],
      allowRemainingArgs: true,
      category: "test",
    }).success,
    false,
  );
  const rule = f.state.similarCommandRules[0];
  for (const args of [
    ["artisan", "test"],
    ["artisan", "test", "--filter=Bar"],
  ])
    assert.equal(
      ruleMatches(
        rule,
        normalizedRuntimeCommand({ ...input, args }, "implementor").command,
      ),
      true,
    );
  assert.equal(
    await f.approve("implementor", run, {
      ...input,
      args: ["artisan", "test", "--filter=Bar"],
    }),
    "allow",
  );
  assert.equal(f.requests.length, 1);
  const dangerous = { ...input, args: ["artisan", "migrate:fresh"] };
  assert.equal(
    ruleMatches(
      rule,
      normalizedRuntimeCommand(dangerous, "implementor").command,
    ),
    false,
  );
  assert.equal(await f.approve("implementor", run, dangerous), "deny");
  assert.equal(f.requests.length, 2);
  const reloadedRules = (await f.engine.store.load(f.state.id))
    .similarCommandRules;
  assert.deepEqual(reloadedRules, f.state.similarCommandRules);
  assert.equal(
    ruleMatches(
      reloadedRules[0],
      normalizedRuntimeCommand(
        { ...input, args: ["artisan", "test", "--filter=Again"] },
        "implementor",
      ).command,
      "implementor",
    ),
    true,
  );
  assert.equal(
    ruleMatches(
      reloadedRules[0],
      normalizedRuntimeCommand(
        { ...input, args: ["artisan", "test", "--filter=Again"] },
        "tester",
      ).command,
      "tester",
    ),
    false,
  );
});

test("denial returns structured policy result and malformed requests never prompt", async () => {
  const f = await fixture([["deny"]]);
  const run = f.control("implementor");
  const evidence: any[] = [];
  const tool = commandTool(
    "implementor",
    effectiveConfig(f.state),
    f.cwd,
    evidence,
    (command, request, signal) =>
      (f.engine as any).runtimeCommandApproval(
        f.state,
        f.state,
        "implementor",
        run,
        command,
        request,
        signal,
        () => {},
      ),
  );
  const input = {
    executable: process.execPath,
    args: ["-p", "42"],
    purpose: "Inspect",
  };
  const denied = await tool.execute(
    "deny",
    input,
    run.controller.signal,
    undefined,
    {} as any,
  );
  assert.equal((denied.details as any).code, "COMMAND_APPROVAL_DENIED");
  assert.equal(f.state.agentFailures, 0);
  assert.equal(evidence.length, 0);
  await assert.rejects(() =>
    tool.execute(
      "bad",
      { ...input, executable: "" },
      undefined,
      undefined,
      {} as any,
    ),
  );
  await assert.rejects(() =>
    tool.execute(
      "bad",
      { ...input, args: "-p 42" },
      undefined,
      undefined,
      {} as any,
    ),
  );
  await assert.rejects(() =>
    tool.execute(
      "bad",
      { ...input, executable: "bash" },
      undefined,
      undefined,
      {} as any,
    ),
  );
  assert.equal(f.requests.length, 1);
});

test("parallel requests retain agent identities; stale and aborted answers cannot grant", async () => {
  const f = await fixture([["allow_workflow"], ["deny"]]);
  const implementor = f.control("implementor");
  const tester = f.control("tester");
  const a = {
    executable: "php",
    args: ["artisan", "route:list"],
    purpose: "Inspect routes",
    category: "development",
  };
  const b = {
    executable: "vendor/bin/phpunit",
    args: ["--filter=Foo"],
    purpose: "Run tests",
    category: "test",
  };
  assert.deepEqual(
    await Promise.all([
      f.approve("implementor", implementor, a),
      f.approve("tester", tester, b),
    ]),
    ["allow", "deny"],
  );
  assert.match(f.requests[0].prompt, /Agent: Implementor/);
  assert.match(f.requests[1].prompt, /Agent: Tester/);
  assert.notEqual(f.events[0].requestId, f.events[1].requestId);

  let answer!: (value: string[]) => void;
  const pending = new Promise<string[]>((resolve) => {
    answer = resolve;
  });
  const g = await fixture([]);
  (g.engine.ui as any).approve = async () => pending;
  const oldRun = g.control("implementor", 1);
  const wait = g.approve("implementor", oldRun, a);
  while (!g.state.pendingRuntimeCommands.length)
    await new Promise((resolve) => setTimeout(resolve, 1));
  const oldId = g.state.pendingRuntimeCommands[0].requestId;
  await g.engine.abortAgent(
    Object.assign(g.state, { phase: "IMPLEMENT" }),
    "implementor",
  );
  answer(["allow_workflow"]);
  assert.equal(await wait, "pending");
  assert.equal(g.state.approvedCommands.length, 0);
  assert.equal(g.state.pendingRuntimeCommands.length, 0);
  const next = g.control("implementor", 2);
  (g.engine.ui as any).approve = async () => ["deny"];
  assert.equal(await g.approve("implementor", next, a), "deny");
  assert.notEqual(g.events.at(-1).requestId, oldId);
  assert.equal(
    toolSignature("team_command", {
      id: normalizedRuntimeCommand(a, "implementor").command.id,
    }),
    toolSignature("team_command", a),
  );
  const detector = new DoomLoopDetector(
    resolveDoomLoop(config(), "implementor"),
  );
  for (let i = 0; i < 3; i++)
    assert.equal(detector.observe("team_command", a), undefined);
  assert.equal(detector.observe("team_command", a)?.patternType, "identical");
});

test("pending approval survives restart and is re-presented without executing", async () => {
  const f = await fixture([["allow_workflow"]]);
  const command = normalizedRuntimeCommand(
    {
      executable: "php",
      args: ["artisan", "route:list", "--token=SECRET"],
      purpose: "Inspect routes",
      category: "development",
    },
    "implementor",
  ).command;
  f.state.pendingRuntimeCommands.push({
    workflowId: f.state.id,
    agentId: "implementor",
    run: 1,
    requestId: randomUUID(),
    command,
    purpose: "Inspect routes",
  });
  f.state.inFlight = { phase: "IMPLEMENT", roles: ["implementor"] };
  f.state.phase = "IMPLEMENT";
  await f.engine.store.save(f.state);
  const loaded = await f.engine.store.load(f.state.id);
  assert.match(renderProgress(loaded).join("\n"), /command approval required/);
  assert.doesNotMatch(renderProgress(loaded).join("\n"), /SECRET/);
  assert.equal(
    (await getWorkflowRecoveryPlan(loaded, f.cwd)).kind,
    "waiting-user",
  );
  const result = await f.engine.run(loaded);
  assert.equal(f.requests.length, 1);
  assert.doesNotMatch(f.requests[0].prompt, /SECRET/);
  assert.equal(result.runtimeCommandApprovals.length, 1);
  assert.equal(result.pendingRuntimeCommands.length, 0);
  assert.equal(result.phase, "BLOCKED");
});

test("engine JSONL and team-log redact dynamic requests and preserve original execution argv", async () => {
  const cwd = await repository();
  const prompts: string[] = [];
  const original = [
    "-e",
    "process.stdout.write(process.argv[1])",
    "--",
    "--token=SECRET",
  ];
  class RuntimeFixture extends FixtureRunner {
    override async run(
      role: Role,
      state: any,
      _signal?: AbortSignal,
      _activity?: any,
      _attempt?: number,
      _output?: any,
      _network?: any,
      _registry?: any,
      _guard?: any,
      _provider?: any,
      _progress?: any,
      runtimeApproval?: any,
    ) {
      if (role === "implementor") {
        const { command, request } = normalizedRuntimeCommand(
          {
            executable: process.execPath,
            args: original,
            purpose: "Inspect --api-key=SECRET",
            category: "development",
          },
          role,
        );
        assert.equal(await runtimeApproval(command, request), "allow");
        const tool = commandTool(
          role,
          effectiveConfig(state, role),
          cwd,
          [],
          async () => "allow",
        );
        const result = await tool.execute(
          "id",
          { id: command.id },
          undefined,
          undefined,
          {} as any,
        );
        assert.match((result.details as any).output, /--token=SECRET/);
      }
      return output(role);
    }
  }
  const engine = new WorkflowEngine(cwd, new RuntimeFixture(), {
    progress: () => {},
    ask: async () => undefined,
    approve: async (request) => {
      prompts.push(request.prompt);
      return ["allow_workflow"];
    },
  });
  const state = await engine.start("Fix", config());
  await engine.invoke("implementor", state);
  const log = new AgentLogStore(cwd);
  const events = await log.read(state.id, "implementor", 1);
  const requested = events.find(
    (event) => event.type === "command_approval_requested",
  )!;
  assert.deepEqual(requested.args, [
    "-e",
    "process.stdout.write(process.argv[1])",
    "--",
    "--token=[REDACTED]",
  ]);
  assert.deepEqual(requested.authorization, {
    decision: "pending",
    source: "runtime",
  });
  const decided = events.find(
    (event) => event.type === "command_approval_decided",
  )!;
  assert.deepEqual(decided.authorization, {
    decision: "approved",
    source: "runtime",
    scope: "workflow",
  });
  assert.equal(decided.requestingRole, "implementor");
  assert.deepEqual(decided.command, requested.command);
  assert.doesNotMatch(JSON.stringify(events), /SECRET/);
  assert.doesNotMatch(prompts[0], /SECRET/);
  assert.doesNotMatch(await log.timeline(state.id, "implementor", 1), /SECRET/);
});

test("workflow stop while approval waits invalidates the pending request", async () => {
  const f = await fixture([]);
  (f.engine.ui as any).approve = async () => new Promise(() => {});
  const run = f.control("implementor");
  const input = {
    executable: "php",
    args: ["artisan", "route:list"],
    purpose: "Inspect",
    category: "development",
  };
  const waiting = f.approve("implementor", run, input);
  while (!f.state.pendingRuntimeCommands.length)
    await new Promise((resolve) => setTimeout(resolve, 1));
  run.controller.abort();
  assert.equal(await waiting, "pending");
  assert.equal(f.state.pendingRuntimeCommands.length, 0);
  assert.equal(f.state.approvedCommands.length, 0);
});

test("denied runtime command does not consume the engine failure budget", async () => {
  const cwd = await repository();
  class DeniedFixture extends FixtureRunner {
    override async run(
      role: Role,
      _state: any,
      _signal?: AbortSignal,
      _activity?: any,
      _attempt?: number,
      _output?: any,
      _network?: any,
      _registry?: any,
      _guard?: any,
      _provider?: any,
      _progress?: any,
      runtimeApproval?: any,
    ) {
      if (role === "implementor") {
        const { command, request } = normalizedRuntimeCommand(
          {
            executable: "php",
            args: ["artisan", "route:list"],
            purpose: "Inspect routes",
            category: "development",
          },
          role,
        );
        assert.equal(await runtimeApproval(command, request), "deny");
      }
      return output(role);
    }
  }
  const engine = new WorkflowEngine(cwd, new DeniedFixture(), {
    progress: () => {},
    ask: async () => undefined,
    approve: async () => ["deny"],
  });
  const state = await engine.start("Fix", config());
  await engine.invoke("implementor", state);
  assert.equal(state.agentFailures, 0);
  assert.equal(
    state.history.some((event) => event.event === "agent_attempt_failed"),
    false,
  );
});

test("cancelled approval pauses routing without counting an agent failure", async () => {
  const cwd = await repository();
  class PendingFixture extends FixtureRunner {
    override async run(
      role: Role,
      state: any,
      signal?: AbortSignal,
      _activity?: any,
      _attempt?: number,
      _output?: any,
      _network?: any,
      _registry?: any,
      _guard?: any,
      _provider?: any,
      _progress?: any,
      runtimeApproval?: any,
    ) {
      if (role !== "implementor") return super.run(role, state);
      const { command, request } = normalizedRuntimeCommand(
        {
          executable: "php",
          args: ["artisan", "route:list"],
          purpose: "Inspect routes",
          category: "development",
        },
        role,
      );
      assert.equal(await runtimeApproval(command, request, signal), "pending");
      return output(role);
    }
  }
  const engine = new WorkflowEngine(cwd, new PendingFixture(), {
    progress: () => {},
    ask: async () => undefined,
    approve: async () => undefined,
  });
  const state = await engine.start("Fix addition", config());
  const result = await engine.run(state);
  assert.equal(result.phase, "BLOCKED");
  assert.equal(result.agentFailures, 0);
  assert.equal(result.pendingRuntimeCommands.length, 1);
  assert.equal(result.results.implementor, undefined);
  assert.equal(
    (await getWorkflowRecoveryPlan(result, cwd)).kind,
    "waiting-user",
  );
  (engine.ui as any).approve = async () => ["allow_workflow"];
  await engine.run(result);
  assert.equal(result.pendingRuntimeCommands.length, 0);
  assert.equal(result.runtimeCommandApprovals.length, 1);
  assert.equal(
    (await getWorkflowRecoveryPlan(result, cwd)).kind,
    "retry-agent",
  );
  assert.equal(await engine.retryAgent(result, "implementor"), "prepared");
});

test("exact runtime grants persist for one role and prompt exposes scope", async () => {
  const f = await fixture([["allow_workflow"], ["deny"], ["deny"]]);
  const input = {
    executable: "php",
    args: ["artisan", "route:list"],
    purpose: "Inspect routes",
    category: "static",
  };
  assert.equal(
    await f.approve("implementor", f.control("implementor"), input),
    "allow",
  );
  assert.match(f.requests[0].prompt, /Agent: Implementor.*implementor/);
  assert.match(f.requests[0].prompt, /Category: static/);
  assert.match(f.requests[0].prompt, /Command: php artisan route:list/);
  assert.match(f.requests[0].prompt, /Purpose: Inspect routes/);
  assert.match(f.requests[0].prompt, /Scope: exact command for Implementor/);
  const loaded = await f.engine.store.load(f.state.id);
  assert.deepEqual(
    loaded.runtimeCommandApprovals,
    f.state.runtimeCommandApprovals,
  );
  const approvedId = loaded.runtimeCommandApprovals[0].command.id;
  assert.ok(
    effectiveConfig(loaded, "implementor").commands.some(
      (command) => command.id === approvedId,
    ),
  );
  assert.ok(
    !effectiveConfig(loaded, "tester").commands.some(
      (command) => command.id === approvedId,
    ),
  );
  assert.ok(
    !effectiveConfig(loaded, "codeReviewer").commands.some(
      (command) => command.id === approvedId,
    ),
  );
  assert.equal(f.events[0].category, "static");
  assert.equal(f.events[0].approvalScope, "role-and-workflow");
  assert.equal(
    await f.approve("implementor", f.control("implementor", 2), input),
    "allow",
  );
  assert.equal(await f.approve("tester", f.control("tester"), input), "deny");
  assert.equal(
    await f.approve("codeReviewer", f.control("codeReviewer"), input),
    "deny",
  );
  assert.equal(f.requests.length, 3);
});

test("similar rules accept named safe test options and reject unsafe arguments across roles", async () => {
  const f = await fixture([["allow_similar"], ["deny"]]);
  const input = {
    executable: "vendor/bin/phpunit",
    args: ["--filter", "Foo"],
    purpose: "Focused test",
    category: "test",
  };
  assert.equal(
    await f.approve("implementor", f.control("implementor"), input),
    "allow",
  );
  assert.match(f.requests[0].prompt, /Allowed options: --filter/);
  const rule = f.state.similarCommandRules[0];
  const command = (executable: string, args: string[]) =>
    normalizedRuntimeCommand(
      { executable, args, purpose: "test", category: "test" },
      "implementor",
    ).command;
  for (const args of [
    ["--filter", "Bar"],
    ["--testsuite", "Unit"],
    ["--testdox"],
  ])
    assert.equal(
      ruleMatches(rule, command("vendor/bin/phpunit", args), "implementor"),
      true,
    );
  for (const args of [
    ["--bootstrap", "/tmp/evil.php"],
    ["--prepend", "evil.php"],
    ["--configuration", "../../outside.xml"],
    ["--unknown"],
    ["../../outside.php"],
    ["tests/Feature/AuthTest.php"],
    ["--filter", "--bootstrap"],
  ])
    assert.equal(
      ruleMatches(rule, command("vendor/bin/phpunit", args), "implementor"),
      false,
    );
  assert.equal(
    ruleMatches(
      rule,
      command("vendor/bin/phpunit", ["--testsuite", "Unit"]),
      "tester",
    ),
    false,
  );
  assert.equal(
    ruleMatches(
      rule,
      command("php", ["artisan", "migrate:fresh"]),
      "implementor",
    ),
    false,
  );
  assert.equal(
    ruleMatches(
      rule,
      command("npm", ["run", "arbitrary-script"]),
      "implementor",
    ),
    false,
  );
  assert.deepEqual(
    (await f.engine.store.load(f.state.id)).similarCommandRules,
    f.state.similarCommandRules,
  );
  assert.equal(await f.approve("tester", f.control("tester"), input), "deny");
});

test("legacy category-wide exact grants and unrestricted similar rules are revoked", async () => {
  const f = await fixture();
  const command = normalizedRuntimeCommand(
    {
      executable: "vendor/bin/phpunit",
      args: [],
      purpose: "Tests",
      category: "test",
    },
    "implementor",
  ).command;
  const legacy: any = {
    ...f.state,
    approvedCommands: [command],
    runtimeApprovedCommandIds: [command.id],
    similarCommandRules: [
      {
        executable: "vendor/bin/phpunit",
        argsPrefix: [],
        allowRemainingArgs: true,
        category: "test",
      },
    ],
  };
  const loaded = validateState(legacy);
  assert.deepEqual(loaded.approvedCommands, []);
  assert.deepEqual(loaded.similarCommandRules, []);
  assert.deepEqual(loaded.runtimeCommandApprovals, []);
  assert.ok(
    loaded.history.some(
      (event) => event.event === "legacy_runtime_approvals_revoked",
    ),
  );
});
