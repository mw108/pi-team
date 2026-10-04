import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { checkTool } from "../src/agents/permissions.ts";
import { permissionPatternMatches } from "../src/agents/path-policy.ts";
import { configSchema } from "../src/config/schema.ts";
import { semanticConfigHash } from "../src/config/drift.ts";
import { staticCommandMatches } from "../src/agents/command-policy.ts";
import { commandTool } from "../src/agents/commands.ts";
import { sanitizeToolResult } from "../src/agents/tool-result.ts";
import { approvalParams } from "../src/integrations/pi-ask.ts";
import { WorkflowEngine } from "../src/workflow/engine.ts";
import { renderProgress } from "../src/ui/progress.ts";
import { getWorkflowRecoveryPlan } from "../src/workflow/recovery.ts";
import { config, contract, FixtureRunner, repository } from "./helpers.ts";

const envContract = { ...contract, filesToModify: [".env", ".env.testing"] };

test("static file rules separate read and write and never override forbidden paths", async () => {
  const cwd = await repository();
  await writeFile(
    join(cwd, ".env"),
    "APP_URL=http://localhost\nAPP_KEY=secret\n",
  );
  await writeFile(join(cwd, ".env.testing"), "APP_URL=http://test\n");
  const cfg = config();
  cfg.permissions.files.allowRead = [".env", "config/*.local"];
  cfg.permissions.files.allowWrite = [".env.testing"];
  await checkTool("implementor", "read", { path: ".env" }, cwd, cfg);
  await checkTool(
    "implementor",
    "grep",
    { path: ".env", pattern: "APP_URL" },
    cwd,
    cfg,
  );
  await assert.rejects(() =>
    checkTool(
      "implementor",
      "grep",
      { path: cwd, pattern: "APP_URL" },
      cwd,
      cfg,
    ),
  );
  await checkTool(
    "implementor",
    "edit",
    { path: ".env.testing" },
    cwd,
    cfg,
    envContract,
  );
  await assert.rejects(
    () =>
      checkTool("implementor", "edit", { path: ".env" }, cwd, cfg, envContract),
    /authorization denied/,
  );
  await assert.rejects(
    () => checkTool("implementor", "read", { path: ".env.testing" }, cwd, cfg),
    /authorization denied/,
  );
  assert.equal(permissionPatternMatches(".env.*", ".ENV.TESTING"), true);
  assert.equal(
    permissionPatternMatches("config/*.local", "config/sub/x.local"),
    false,
  );
  assert.equal(
    permissionPatternMatches("cafe\u0301/*.local", "CAFÉ/app.local"),
    true,
  );
  for (const path of [
    ".git/**",
    ".pi/team/state/**",
    ".pi/team/agents/**",
    ".serena/**",
    "../.env",
    "/tmp/.env",
  ])
    assert.equal(
      configSchema.safeParse({
        ...cfg,
        permissions: {
          ...cfg.permissions,
          files: { allowRead: [path], allowWrite: [path] },
        },
      }).success,
      false,
    );
  await assert.rejects(
    () =>
      checkTool(
        "implementor",
        "read",
        { path: ".pi/team/state/workflow.json" },
        cwd,
        cfg,
        undefined,
        {
          dirtyPaths: [],
          approvedDirtyPaths: [],
          authorizeSensitive: async () => true,
        },
      ),
    /private/,
  );
});

test("runtime grants use exact role, operation and path; allow once is ephemeral", async () => {
  const cwd = await repository();
  for (const path of [".env", ".env.testing"])
    await writeFile(
      join(cwd, path),
      "APP_URL=http://localhost\nAPP_KEY=secret\n",
    );
  await symlink(".env", join(cwd, "environment-alias"));
  const answers = [
    "allow_once",
    "allow_workflow",
    "allow_workflow",
    "deny",
    "allow_workflow",
  ];
  const requests: any[] = [];
  const engine = new WorkflowEngine(cwd, new FixtureRunner(), {
    progress: () => {},
    ask: async () => undefined,
    approve: async (request) => {
      requests.push(request);
      return [answers.shift()!];
    },
  });
  const state = await engine.start(
    "Add APP_FRONTEND_URL after APP_URL",
    config(),
  );
  const control = {
    workflowId: state.id,
    attempt: 1,
    controller: new AbortController(),
  };
  (engine as any).activeAttempts.set("implementor", control);
  const approve = (
    operation: "read" | "write",
    path: string,
    role = "implementor",
  ) =>
    (engine as any).commandApprovals.approveFile(
      state,
      role,
      control,
      operation,
      path,
      control.controller.signal,
      "Add APP_FRONTEND_URL after APP_URL",
      () => {},
    );
  const policy = (operation: "read" | "write", path: string) => ({
    dirtyPaths: [],
    approvedDirtyPaths: [],
    authorizeSensitive: () => approve(operation, path),
  });
  await checkTool(
    "implementor",
    "read",
    { path: ".env" },
    cwd,
    state.config,
    undefined,
    policy("read", ".env"),
  );
  assert.equal(state.runtimeFileApprovals.length, 0);
  await checkTool(
    "implementor",
    "read",
    { path: "environment-alias" },
    cwd,
    state.config,
    undefined,
    policy("read", ".env"),
  );
  assert.equal(requests.length, 2);
  assert.equal(state.runtimeFileApprovals.length, 1);
  await checkTool(
    "implementor",
    "read",
    { path: ".ENV" },
    cwd,
    state.config,
    undefined,
    policy("read", ".env"),
  );
  assert.equal(requests.length, 2);
  await checkTool(
    "implementor",
    "write",
    { path: ".env" },
    cwd,
    state.config,
    envContract,
    policy("write", ".env"),
  );
  assert.equal(requests.length, 3);
  await assert.rejects(
    () =>
      checkTool(
        "implementor",
        "read",
        { path: ".env.testing" },
        cwd,
        state.config,
        undefined,
        policy("read", ".env.testing"),
      ),
    /authorization denied/,
  );
  assert.equal(requests.length, 4);
  await checkTool(
    "implementor",
    "read",
    { path: ".env.testing" },
    cwd,
    state.config,
    undefined,
    policy("read", ".env.testing"),
  );
  assert.equal(requests.length, 5);
  assert.match(requests[0].prompt, /Operation: Read/);
  assert.equal(approvalParams(requests[0]).questions[0].type, "single");
  assert.doesNotMatch(requests[0].prompt, /APP_KEY=secret/);
  const loaded = await engine.store.load(state.id);
  assert.deepEqual(loaded.runtimeFileApprovals, state.runtimeFileApprovals);
  assert.equal(loaded.pendingRuntimeFiles.length, 0);
  (engine as any).activeAttempts.set("tester", { ...control });
  const tester = (engine as any).commandApprovals.approveFile(
    loaded,
    "tester",
    (engine as any).activeAttempts.get("tester"),
    "read",
    ".env",
    undefined,
    "Inspect",
    () => {},
  );
  await tester;
  assert.equal(requests.length, 6);
});

test("static command rules require exact executable and prefix and keep sandbox execution", async () => {
  const cfg = config();
  cfg.permissions.commands.allow = [
    { executable: "php", argsPrefix: ["artisan"], allowRemainingArgs: true },
  ];
  const rule = cfg.permissions.commands.allow[0];
  assert.equal(
    staticCommandMatches(rule, {
      executable: "php",
      args: ["artisan", "test"],
    }),
    true,
  );
  assert.equal(
    staticCommandMatches(rule, { executable: "php", args: ["arbitrary.php"] }),
    false,
  );
  assert.equal(
    staticCommandMatches(rule, { executable: "bash", args: ["artisan"] }),
    false,
  );
  assert.equal(
    configSchema.safeParse({
      ...cfg,
      permissions: {
        ...cfg.permissions,
        commands: { allow: [{ executable: "bash", allowRemainingArgs: true }] },
      },
    }).success,
    false,
  );
  assert.equal(
    configSchema.safeParse({
      ...cfg,
      permissions: {
        ...cfg.permissions,
        commands: { allow: [{ executable: "php" }] },
      },
    }).success,
    true,
  );
  assert.equal(
    staticCommandMatches(
      { executable: "php", argsPrefix: [], allowRemainingArgs: false },
      { executable: "php", args: ["arbitrary.php"] },
    ),
    false,
  );
  const cwd = await repository();
  cfg.permissions.commands.allow = [
    {
      executable: "node",
      argsPrefix: ["--version"],
      allowRemainingArgs: false,
    },
  ];
  const evidence: any[] = [];
  let prompts = 0;
  const tool = commandTool("implementor", cfg, cwd, evidence, async () => {
    prompts++;
    return "deny";
  });
  const result = await tool.execute(
    "static",
    {
      executable: "node",
      args: ["--version"],
      purpose: "Version",
      category: "development",
    } as any,
    undefined as any,
    undefined as any,
    undefined as any,
  );
  assert.equal(prompts, 0);
  assert.equal(evidence.length, 1);
  assert.ok(evidence[0].sandbox);
  assert.match(JSON.stringify(result), /v\d+/);
});

test("permissions are runtime configuration, not semantic workflow drift", () => {
  const before = config();
  const after = structuredClone(before);
  after.permissions.files.allowRead.push(".env");
  after.permissions.files.allowWrite.push(".env.testing");
  after.permissions.commands.allow.push({
    executable: "php",
    argsPrefix: ["artisan"],
    allowRemainingArgs: true,
  });
  assert.equal(semanticConfigHash(before), semanticConfigHash(after));
});

test("approved env reads retain non-secret keys under provider redaction", () => {
  const result = sanitizeToolResult({
    content: [
      {
        type: "text",
        text: "APP_URL=http://localhost\nAPP_KEY=base64:super-secret-value\n",
      },
    ],
    details: undefined,
    structuredContent: undefined,
  });
  const text = (result.content?.[0] as { text: string }).text;
  assert.match(text, /APP_URL=http:\/\/localhost/);
  assert.match(text, /APP_KEY=\[REDACTED\]/);
  assert.doesNotMatch(text, /super-secret-value/);
});

test("pending file approval survives restart without replaying Allow once", async () => {
  const cwd = await repository();
  const seen: any[] = [];
  const engine = new WorkflowEngine(cwd, new FixtureRunner(), {
    progress: () => {},
    ask: async () => undefined,
    approve: async (request) => {
      seen.push(request);
      return ["allow_workflow"];
    },
  });
  const state = await engine.start("Edit .env", config());
  state.pendingRuntimeFiles.push({
    workflowId: state.id,
    agentId: "implementor",
    run: 1,
    requestId: randomUUID(),
    operation: "write",
    path: ".env",
  });
  state.inFlight = { phase: "IMPLEMENT", roles: ["implementor"] };
  state.phase = "IMPLEMENT";
  await engine.store.save(state);
  const loaded = await engine.store.load(state.id);
  assert.match(renderProgress(loaded).join("\n"), /write access to \.env/);
  assert.equal(
    (await getWorkflowRecoveryPlan(loaded, cwd)).kind,
    "waiting-user",
  );
  const result = await engine.run(loaded);
  assert.equal(seen.length, 1);
  assert.ok(
    !seen[0].options.some((option: any) => option.value === "allow_once"),
  );
  assert.deepEqual(result.runtimeFileApprovals, [
    { role: "implementor", operation: "write", path: ".env" },
  ]);
  assert.equal(result.pendingRuntimeFiles.length, 0);
  assert.equal(result.phase, "BLOCKED");
});

test(".env implementation preauthorization covers both files without a prompt", async () => {
  const cwd = await repository();
  await writeFile(
    join(cwd, ".env"),
    "APP_URL=http://localhost\nAPP_KEY=secret\n",
  );
  await writeFile(join(cwd, ".env.testing"), "APP_URL=http://test\n");
  const cfg = config();
  cfg.permissions.files.allowRead = [".env", ".env.testing"];
  cfg.permissions.files.allowWrite = [".env", ".env.testing"];
  let prompts = 0;
  const policy = {
    dirtyPaths: [],
    approvedDirtyPaths: [],
    authorizeSensitive: async () => {
      prompts++;
      return false;
    },
  };
  for (const path of [".env", ".env.testing"]) {
    await checkTool(
      "implementor",
      "read",
      { path },
      cwd,
      cfg,
      envContract,
      policy,
    );
    await checkTool(
      "implementor",
      "edit",
      { path },
      cwd,
      cfg,
      envContract,
      policy,
    );
  }
  assert.equal(prompts, 0);
});

test("denied file approval does not consume an agent failure", async () => {
  const cwd = await repository();
  class DeniedFileRunner extends FixtureRunner {
    override async run(role: any, state: any, ...extras: any[]) {
      if (role === "implementor") {
        const fileApproval = extras.at(-2);
        assert.equal(await fileApproval("read", ".env"), false);
      }
      return super.run(role, state);
    }
  }
  const engine = new WorkflowEngine(cwd, new DeniedFileRunner(), {
    progress: () => {},
    ask: async () => undefined,
    approve: async () => ["deny"],
  });
  const state = await engine.start("Inspect .env", config());
  await engine.invoke("implementor", state);
  assert.equal(state.agentFailures, 0);
  assert.equal(
    state.history.some((event) => event.event === "agent_attempt_failed"),
    false,
  );
  assert.equal(
    state.history.some(
      (event) => event.event === "file_access_approval_denied",
    ),
    true,
  );
});

test("stale file approval cannot grant a superseded attempt", async () => {
  const cwd = await repository();
  let reply!: (choice: string[]) => void;
  const decision = new Promise<string[]>((resolve) => {
    reply = resolve;
  });
  const engine = new WorkflowEngine(cwd, new FixtureRunner(), {
    progress: () => {},
    ask: async () => undefined,
    approve: async () => decision,
  });
  const state = await engine.start("Read .env", config());
  const old = {
    workflowId: state.id,
    attempt: 1,
    controller: new AbortController(),
    intention: undefined as "superseded" | undefined,
  };
  (engine as any).activeAttempts.set("implementor", old);
  const pending = (engine as any).commandApprovals.approveFile(
    state,
    "implementor",
    old,
    "read",
    ".env",
    old.controller.signal,
    "Inspect",
    () => {},
  );
  for (let i = 0; !state.pendingRuntimeFiles.length && i < 100; i++)
    await new Promise((resolve) => setTimeout(resolve, 1));
  assert.equal(state.pendingRuntimeFiles.length, 1);
  old.intention = "superseded";
  old.controller.abort();
  (engine as any).activeAttempts.set("implementor", {
    workflowId: state.id,
    attempt: 2,
    controller: new AbortController(),
  });
  reply(["allow_workflow"]);
  assert.equal(await pending, false);
  assert.deepEqual(state.runtimeFileApprovals, []);
  assert.deepEqual(state.pendingRuntimeFiles, []);
});
