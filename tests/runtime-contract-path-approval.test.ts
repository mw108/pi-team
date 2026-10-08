import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { deleteTool } from "../src/agents/files.ts";
import {
  checkTool,
  isContractOperationAllowed,
  validateContractPathRequest,
  workflowScopePaths,
} from "../src/agents/permissions.ts";
import { approvalParams } from "../src/integrations/pi-ask.ts";
import { WorkflowEngine } from "../src/workflow/engine.ts";
import { transition } from "../src/workflow/router.ts";
import {
  config,
  contract,
  finding,
  FixtureRunner,
  output,
  repository,
} from "./helpers.ts";

async function fixture(choices: string[]) {
  const cwd = await repository();
  const requests: any[] = [];
  const engine = new WorkflowEngine(cwd, new FixtureRunner(), {
    progress: () => {},
    ask: async () => undefined,
    approve: async (request) => {
      requests.push(request);
      return [choices.shift()!];
    },
  });
  const state = await engine.start("Change an additional file", config());
  state.results.reviewer = contract;
  const control = {
    workflowId: state.id,
    attempt: 1,
    controller: new AbortController(),
  };
  (engine as any).activeAttempts.set("implementor", control);
  const decide = (
    path: string,
    operation: "create" | "modify" | "delete" = "modify",
    reason = "The existing test requires this component change",
  ) =>
    (engine as any).commandApprovals.approveContractPath(
      state,
      "implementor",
      control,
      operation,
      path,
      reason,
      control.controller.signal,
      () => {},
    ) as Promise<"once" | "workflow" | "deny">;
  return { cwd, engine, state, control, requests, decide };
}

test("Reviewer contract grants only the matching create, modify, or delete operation", async () => {
  const cwd = await repository();
  const cfg = config();
  const path = "x.ts";
  const noApproval = {
    dirtyPaths: [],
    approvedDirtyPaths: [],
    consumeContractOnce: () => {
      throw new Error("unexpected approval request");
    },
  };
  const createOnly = {
    ...contract,
    filesToModify: [],
    filesToCreate: [path],
    filesToDelete: [],
  };
  const modifyOnly = {
    ...contract,
    filesToModify: [path],
    filesToCreate: [],
    filesToDelete: [],
  };
  const deleteOnly = {
    ...contract,
    filesToModify: [],
    filesToCreate: [],
    filesToDelete: [path],
  };

  assert.equal(isContractOperationAllowed(createOnly, path, "create"), true);
  await checkTool(
    "implementor",
    "write",
    { path },
    cwd,
    cfg,
    createOnly,
    noApproval,
  );
  await writeFile(join(cwd, path), "original\n");
  await assert.rejects(
    () => checkTool("implementor", "edit", { path }, cwd, cfg, createOnly),
    /team_request_contract_path/,
  );

  assert.equal(isContractOperationAllowed(modifyOnly, path, "modify"), true);
  await checkTool(
    "implementor",
    "edit",
    { path },
    cwd,
    cfg,
    modifyOnly,
    noApproval,
  );
  await assert.rejects(
    () =>
      checkTool("implementor", "team_delete", { path }, cwd, cfg, modifyOnly),
    /team_request_contract_path/,
  );

  assert.equal(isContractOperationAllowed(deleteOnly, path, "delete"), true);
  await checkTool(
    "implementor",
    "team_delete",
    { path },
    cwd,
    cfg,
    deleteOnly,
    noApproval,
  );
  await assert.rejects(
    () => checkTool("implementor", "edit", { path }, cwd, cfg, deleteOnly),
    /team_request_contract_path/,
  );
  assert.equal(await readFile(join(cwd, path), "utf8"), "original\n");
});

test("runtime approval bridges a create-only contract to modify without granting delete", async () => {
  const f = await fixture(["allow_once", "allow_workflow"]);
  const path = "x.ts";
  const createOnly = {
    ...contract,
    filesToModify: [],
    filesToCreate: [path],
    filesToDelete: [],
  };
  f.state.results.reviewer = createOnly;
  await writeFile(join(f.cwd, path), "original\n");
  await assert.rejects(
    () =>
      checkTool(
        "implementor",
        "edit",
        { path },
        f.cwd,
        f.state.config,
        createOnly,
      ),
    /team_request_contract_path/,
  );
  assert.equal(await f.decide(path, "modify"), "once");
  let once = true;
  const oneShot = {
    dirtyPaths: [],
    approvedDirtyPaths: [],
    consumeContractOnce: (operation: string, requested: string) => {
      if (operation !== "modify" || requested !== path || !once) return false;
      once = false;
      return true;
    },
  };
  await checkTool(
    "implementor",
    "edit",
    { path },
    f.cwd,
    f.state.config,
    createOnly,
    oneShot,
  );
  await assert.rejects(
    () =>
      checkTool(
        "implementor",
        "edit",
        { path },
        f.cwd,
        f.state.config,
        createOnly,
        oneShot,
      ),
    /team_request_contract_path/,
  );
  assert.equal(await f.decide(path, "modify"), "workflow");
  const workflow = {
    dirtyPaths: [],
    approvedDirtyPaths: [],
    workflowContractApprovals: f.state.workflowApprovedContractPaths,
  };
  await checkTool(
    "implementor",
    "edit",
    { path },
    f.cwd,
    f.state.config,
    createOnly,
    workflow,
  );
  await checkTool(
    "implementor",
    "edit",
    { path },
    f.cwd,
    f.state.config,
    createOnly,
    workflow,
  );
  await assert.rejects(
    () =>
      checkTool(
        "implementor",
        "team_delete",
        { path },
        f.cwd,
        f.state.config,
        createOnly,
        workflow,
      ),
    /team_request_contract_path/,
  );
  assert.equal(f.requests.length, 2);
  assert.deepEqual(createOnly.filesToModify, []);
});

test("allow once authorizes one matching mutation, preserves original contract, and asks again", async () => {
  const f = await fixture(["allow_once", "deny"]);
  const path = "extra.js";
  await writeFile(join(f.cwd, path), "old\n");
  assert.equal(await f.decide(path), "once");
  let tickets = 1;
  const policy = {
    dirtyPaths: [],
    approvedDirtyPaths: [],
    consumeContractOnce: (operation: string, requested: string) =>
      operation === "modify" && requested === path && tickets-- > 0,
  };
  await checkTool(
    "implementor",
    "edit",
    { path },
    f.cwd,
    f.state.config,
    contract,
    policy,
  );
  await writeFile(join(f.cwd, path), "new\n");
  assert.equal(await readFile(join(f.cwd, path), "utf8"), "new\n");
  await assert.rejects(
    () =>
      checkTool(
        "implementor",
        "edit",
        { path },
        f.cwd,
        f.state.config,
        contract,
        policy,
      ),
    /team_request_contract_path/,
  );
  assert.equal(await f.decide(path), "deny");
  assert.equal(f.requests.length, 2);
  assert.deepEqual(f.state.workflowApprovedContractPaths, []);
  assert.deepEqual(contract.filesToModify, ["math.js"]);
  assert.deepEqual(
    f.requests[0].options.map((option: any) => option.label),
    ["Ja", "Ja für diesen Workflow", "Nein"],
  );
  assert.equal(approvalParams(f.requests[0]).questions[0].type, "single");
  assert.match(
    f.requests[0].prompt,
    /The existing test requires this component change/,
  );
  assert.match(f.requests[0].prompt, /implementor/);
  assert.equal(f.state.agentFailures, 0);
  assert.ok(
    f.state.history.some(
      (event) => event.event === "contract_path_approval_granted_once",
    ),
  );
  assert.ok(
    f.state.history.some(
      (event) => event.event === "contract_path_approval_denied",
    ),
  );
});

test("workflow grant survives reload and authorizes another mutating agent only for the exact operation", async () => {
  const f = await fixture(["allow_workflow"]);
  const path = "tests/extra.test.mjs";
  await writeFile(join(f.cwd, path), "old\n");
  assert.equal(await f.decide(path), "workflow");
  assert.deepEqual(f.state.workflowApprovedContractPaths, [
    { path, operation: "modify" },
  ]);
  const loaded = await f.engine.store.load(f.state.id);
  assert.deepEqual(
    loaded.workflowApprovedContractPaths,
    f.state.workflowApprovedContractPaths,
  );
  const cfg = f.state.config;
  cfg.tester.mayModifyTests = true;
  cfg.tester.testPaths = ["tests"];
  const policy = {
    dirtyPaths: [],
    approvedDirtyPaths: [],
    workflowContractApprovals: loaded.workflowApprovedContractPaths,
  };
  await checkTool(
    "implementor",
    "edit",
    { path },
    f.cwd,
    cfg,
    contract,
    policy,
  );
  await checkTool("tester", "edit", { path }, f.cwd, cfg, contract, policy);
  await assert.rejects(
    () =>
      checkTool(
        "implementor",
        "team_delete",
        { path },
        f.cwd,
        cfg,
        contract,
        policy,
      ),
    /team_request_contract_path/,
  );
  assert.equal(f.requests.length, 1);
  assert.ok(workflowScopePaths(loaded).includes(path));
  assert.ok(
    f.state.history.some(
      (event) => event.event === "contract_path_approval_granted_workflow",
    ),
  );
  f.state.phase = "CODE_REVIEW";
  f.state.results.codeReviewer = { status: "FIX_LOCAL", findings: [finding] };
  transition(f.state);
  assert.equal(f.state.phase, "IMPLEMENT");
  assert.deepEqual(f.state.workflowApprovedContractPaths, [
    { path, operation: "modify" },
  ]);
  const other = await f.engine.start("Another workflow", config());
  assert.deepEqual(other.workflowApprovedContractPaths, []);
});

test("denial leaves the file untouched and an existing in-contract path needs no scope request", async () => {
  const f = await fixture(["deny"]);
  await writeFile(join(f.cwd, "extra.js"), "old\n");
  assert.equal(await f.decide("extra.js"), "deny");
  await assert.rejects(
    () =>
      checkTool(
        "implementor",
        "edit",
        { path: "extra.js" },
        f.cwd,
        f.state.config,
        contract,
        { dirtyPaths: [], approvedDirtyPaths: [] },
      ),
    /team_request_contract_path/,
  );
  assert.equal(await readFile(join(f.cwd, "extra.js"), "utf8"), "old\n");
  await checkTool(
    "implementor",
    "edit",
    { path: "math.js" },
    f.cwd,
    f.state.config,
    contract,
  );
  assert.equal(f.requests.length, 1);
  assert.equal(f.state.agentFailures, 0);
  f.state.phase = "IMPLEMENT";
  f.state.results.implementor = {
    status: "IMPLEMENTATION_BLOCKED",
    reason: "The denied extra.js change is required",
    evidence: ["The requested path was explicitly denied"],
    suggestedRoute: "FIX_DESIGN",
  };
  transition(f.state);
  assert.equal(f.state.phase, "RESEARCH");
});

test("pending contract scope request is WAITING_USER without an agent failure", async () => {
  const cwd = await repository();
  let answer!: (choice: string[]) => void;
  const engine = new WorkflowEngine(cwd, new FixtureRunner(), {
    progress: () => {},
    ask: async () => undefined,
    approve: () =>
      new Promise<string[]>((resolve) => {
        answer = resolve;
      }),
  });
  const state = await engine.start("Modify extra file", config());
  const control = {
    workflowId: state.id,
    attempt: 1,
    controller: new AbortController(),
  };
  (engine as any).activeAttempts.set("implementor", control);
  const pending = (engine as any).commandApprovals.approveContractPath(
    state,
    "implementor",
    control,
    "modify",
    "extra.js",
    "Existing tests require it",
    control.controller.signal,
    () => {},
  );
  for (let i = 0; !answer && i < 100; i++)
    await new Promise((resolve) => setTimeout(resolve, 1));
  assert.equal(state.phase, "WAITING_USER");
  assert.equal(state.pendingContractPaths.length, 1);
  assert.equal(state.agentFailures, 0);
  answer(["deny"]);
  assert.equal(await pending, "deny");
  assert.equal(state.phase, "ORCHESTRATE");
  assert.equal(state.pendingContractPaths.length, 0);
});

test("path validation rejects traversal, external paths, symlinks, and protected paths without approval", async () => {
  const cwd = await repository();
  for (const path of [
    "../../outside",
    "/tmp/outside",
    ".pi/team/team.yaml",
    "sub/../extra.js",
    "extra*.js",
  ])
    await assert.rejects(() => validateContractPathRequest(cwd, path));
  assert.equal(
    await validateContractPathRequest(cwd, "tests/extra.test.mjs"),
    "tests/extra.test.mjs",
  );
});

test("a workflow grant is separate from the original contract and exact per path", async () => {
  const f = await fixture(["allow_workflow"]);
  assert.equal(await f.decide("extra-a.js"), "workflow");
  assert.ok(!workflowScopePaths(f.state).includes("extra-b.js"));
  await assert.rejects(
    () =>
      checkTool(
        "implementor",
        "write",
        { path: "extra-b.js" },
        f.cwd,
        f.state.config,
        contract,
        {
          dirtyPaths: [],
          approvedDirtyPaths: [],
          workflowContractApprovals: f.state.workflowApprovedContractPaths,
        },
      ),
    /team_request_contract_path/,
  );
  assert.equal(f.requests.length, 1);
});

test("pending scope approval after restart offers workflow approval without replaying a one-shot write", async () => {
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
  const state = await engine.start("Modify extra file", config());
  state.results.reviewer = contract;
  state.pendingContractPaths.push({
    workflowId: state.id,
    agentId: "implementor",
    run: 1,
    requestId: randomUUID(),
    path: "extra.js",
    operation: "modify",
    reason: "Existing tests require it",
  });
  state.inFlight = { phase: "IMPLEMENT", roles: ["implementor"] };
  state.phase = "WAITING_USER";
  await engine.store.save(state);
  const loaded = await engine.store.load(state.id);
  const result = await engine.run(loaded);
  assert.equal(seen.length, 1);
  assert.ok(
    !seen[0].options.some((option: any) => option.value === "allow_once"),
  );
  assert.match(seen[0].prompt, /Existing tests require it/);
  assert.deepEqual(result.workflowApprovedContractPaths, [
    { path: "extra.js", operation: "modify" },
  ]);
  assert.equal(result.pendingContractPaths.length, 0);
  assert.equal(result.agentFailures, 0);
  assert.equal(result.phase, "BLOCKED");
});

test("a superseded attempt cannot acquire a workflow grant from a stale answer", async () => {
  const cwd = await repository();
  let reply!: (choice: string[]) => void;
  const engine = new WorkflowEngine(cwd, new FixtureRunner(), {
    progress: () => {},
    ask: async () => undefined,
    approve: () =>
      new Promise<string[]>((resolve) => {
        reply = resolve;
      }),
  });
  const state = await engine.start("Edit extra file", config());
  const old = {
    workflowId: state.id,
    attempt: 1,
    controller: new AbortController(),
    intention: undefined as "superseded" | undefined,
  };
  (engine as any).activeAttempts.set("implementor", old);
  const pending = (engine as any).commandApprovals.approveContractPath(
    state,
    "implementor",
    old,
    "modify",
    "extra.js",
    "Test requires it",
    old.controller.signal,
    () => {},
  );
  for (let i = 0; !reply && i < 100; i++)
    await new Promise((resolve) => setTimeout(resolve, 1));
  old.intention = "superseded";
  old.controller.abort();
  (engine as any).activeAttempts.set("implementor", {
    workflowId: state.id,
    attempt: 2,
    controller: new AbortController(),
  });
  reply(["allow_workflow"]);
  assert.equal(await pending, "deny");
  assert.deepEqual(state.workflowApprovedContractPaths, []);
  assert.deepEqual(state.pendingContractPaths, []);
});

test("team_delete refuses direct execution without a matching host-authorized tool call", async () => {
  const cwd = await repository();
  await writeFile(join(cwd, "extra.js"), "old\n");
  const tool = deleteTool(cwd, () => false);
  await assert.rejects(
    () =>
      tool.execute(
        "unapproved",
        { path: "extra.js" } as any,
        undefined,
        undefined,
        {} as any,
      ),
    /approved tool call/,
  );
  assert.equal(await readFile(join(cwd, "extra.js"), "utf8"), "old\n");
});

test("HAPAK register template scope gap asks before the success-button edit", async () => {
  const f = await fixture(["allow_workflow"]);
  const path = "projects/hapak/src/app/register/register.component.html";
  const hapakContract = {
    ...contract,
    filesToModify: [
      "projects/hapak/src/app/app.config.ts",
      "projects/hapak/src/app/register-verify/register-verify.component.ts",
      "projects/hapak/src/app/register-verify/register-verify.component.html",
      "projects/hapak/src/app/register-verify/register-verify.component.css",
      "projects/hapak/src/app/register-verify/register-verify.component.spec.ts",
    ],
  };
  await mkdir(join(f.cwd, "projects/hapak/src/app/register"), {
    recursive: true,
  });
  await writeFile(join(f.cwd, path), "<div>Success</div>\n");
  assert.equal(
    await f.decide(
      path,
      "modify",
      "Existing RegisterComponent tests require a .success-button in the success state",
    ),
    "workflow",
  );
  assert.match(f.requests[0].prompt, /register\/register\.component\.html/);
  assert.match(f.requests[0].prompt, /\.success-button/);
  await checkTool(
    "implementor",
    "edit",
    { path },
    f.cwd,
    f.state.config,
    hapakContract,
    {
      dirtyPaths: [],
      approvedDirtyPaths: [],
      workflowContractApprovals: f.state.workflowApprovedContractPaths,
    },
  );
  assert.ok(!hapakContract.filesToModify.includes(path));
});

test("engine keeps a one-shot scope grant inside the current Implementor attempt", async () => {
  const cwd = await repository();
  await writeFile(join(cwd, "extra.js"), "old\n");
  class RequestingRunner extends FixtureRunner {
    override async run(role: any, state: any, ...extras: any[]) {
      if (role !== "implementor") return super.run(role, state, ...extras);
      const approval = extras.at(-3);
      const mutationObserver = extras.at(-1);
      assert.equal(
        await approval.request(
          "modify",
          "extra.js",
          "Existing test needs the new behavior",
        ),
        true,
      );
      await checkTool(
        "implementor",
        "edit",
        { path: "extra.js" },
        cwd,
        state.config,
        contract,
        {
          dirtyPaths: [],
          approvedDirtyPaths: [],
          workflowContractApprovals: state.workflowApprovedContractPaths,
          consumeContractOnce: approval.consumeOnce,
        },
      );
      await writeFile(join(cwd, "extra.js"), "new\n");
      await mutationObserver({
        path: "extra.js",
        identity: "extra.js",
        kind: "edit",
      });
      return output("implementor");
    }
  }
  const requests: any[] = [];
  const engine = new WorkflowEngine(cwd, new RequestingRunner(), {
    progress: () => {},
    ask: async () => undefined,
    approve: async (request) => {
      requests.push(request);
      return ["allow_once"];
    },
  });
  const state = await engine.start("Edit extra file", config());
  state.results.reviewer = contract;
  await engine.invoke("implementor", state);
  assert.equal(requests.length, 1);
  assert.equal(await readFile(join(cwd, "extra.js"), "utf8"), "new\n");
  assert.deepEqual(state.workflowApprovedContractPaths, []);
  assert.deepEqual(state.completedOneShotContractPaths, ["extra.js"]);
  assert.ok(workflowScopePaths(state).includes("extra.js"));
  assert.equal(state.agentFailures, 0);
});
