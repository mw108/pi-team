import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  executionContext,
  captureProcessIdentity,
  verifyProcessIdentity,
  inspectExecution,
  type ProcessInspector,
  type ExecutionIdentity,
  type ProcessIdentity,
} from "../src/workflow/execution-identity.ts";
import { execute } from "../src/agents/commands.ts";
import { StateStore } from "../src/workflow/persistence.ts";
import { newState, validateState } from "../src/workflow/state.ts";
import { config } from "./helpers.ts";
const identity: ProcessIdentity = {
  pid: 1234,
  host: "host",
  boot: "boot",
  creation: "start",
  group: false,
};
const api: ProcessInspector = {
  host: async () => "host",
  boot: async () => "boot",
  process: async () => ({ creation: "start", group: 1234, zombie: false }),
  groupActive: async () => false,
};
const absent = () => {
  throw Object.assign(new Error("gone"), { code: "ENOENT" });
};
for (const [name, expected, stored, override] of [
  ["live original", "ACTIVE", identity, {}],
  [
    "terminated original",
    "TERMINATED",
    identity,
    { process: async () => absent() },
  ],
  [
    "PID reused",
    "TERMINATED",
    identity,
    { process: async () => ({ creation: "new", group: 1234, zombie: false }) },
  ],
  ["other host", "UNKNOWN", { ...identity, host: "other" }, {}],
  ["new boot", "TERMINATED", { ...identity, boot: "old" }, {}],
  ["missing identity", "UNKNOWN", undefined, {}],
  [
    "SDK without PID creation identity",
    "UNKNOWN",
    { ...identity, creation: undefined },
    {},
  ],
  [
    "permission denied",
    "UNKNOWN",
    identity,
    {
      process: async () => {
        throw Object.assign(new Error(), { code: "EACCES" });
      },
    },
  ],
  [
    "inspection API unavailable",
    "UNKNOWN",
    identity,
    {
      host: async () => {
        throw new Error("unavailable");
      },
    },
  ],
  [
    "process disappears",
    "TERMINATED",
    identity,
    { process: async () => absent() },
  ],
  [
    "remaining process group",
    "UNKNOWN",
    { ...identity, group: true },
    { process: async () => absent(), groupActive: async () => true },
  ],
  [
    "reused group identity",
    "UNKNOWN",
    { ...identity, group: true },
    { process: async () => ({ creation: "new", group: 1234, zombie: false }) },
  ],
] as const)
  test(`process verification: ${name}`, async () => {
    assert.equal(
      (await verifyProcessIdentity(stored, { ...api, ...override })).status,
      expected,
    );
  });
const record = (): ExecutionIdentity => ({
  id: randomUUID(),
  workflowId: randomUUID(),
  agent: "tester",
  attempt: 1,
  status: "RESERVED",
  children: [],
});
test("legacy and incomplete startup remain explicitly uncertain", async () => {
  assert.equal((await inspectExecution()).status, "UNKNOWN");
  const e = record();
  e.children.push({ id: randomUUID(), status: "STARTING" });
  assert.equal((await inspectExecution(e)).status, "UNKNOWN");
});
test(
  "Linux verifies the actual host process using creation identity",
  { skip: process.platform !== "linux" },
  async () => {
    const original = await captureProcessIdentity();
    assert.ok(original.creation);
    assert.ok(original.boot);
    assert.equal((await verifyProcessIdentity(original)).status, "ACTIVE");
    assert.equal(
      (
        await verifyProcessIdentity({
          ...original,
          creation: String(Number(original.creation) + 1),
        })
      ).status,
      "TERMINATED",
    );
  },
);
test("execution identity survives storage and rejects duplicate or wrong-workflow reservations", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-identity-"));
  const state = newState(cwd, "identity", config(), {
    head: null,
    dirtyPaths: [],
    status: "",
    diff: "",
    cachedDiff: "",
  });
  const e = record();
  e.workflowId = state.id;
  state.executions.push(e);
  const store = new StateStore(cwd);
  await store.save(state);
  const loaded = await new StateStore(cwd).load(state.id);
  assert.deepEqual(loaded.executions, state.executions);
  assert.throws(
    () =>
      validateState({ ...state, executions: [e, { ...e, id: randomUUID() }] }),
    /duplicate/,
  );
  assert.throws(
    () =>
      validateState({
        ...state,
        executions: [{ ...e, workflowId: randomUUID() }],
      }),
    /mismatched/,
  );
  const legacy = { ...state } as Record<string, unknown>;
  delete legacy.executions;
  assert.deepEqual(validateState(legacy).executions, []);
});
test("managed child reservation precedes spawn and exit metadata is durable", async () => {
  const e = record();
  const snapshots: ExecutionIdentity[] = [];
  const result = await executionContext.run(
    {
      update: async (change) => {
        change(e);
        snapshots.push(structuredClone(e));
      },
    },
    () =>
      execute(
        {
          id: "controlled-child",
          executable: process.execPath,
          args: ["-e", "setTimeout(()=>process.exit(0),40)"],
          purpose: "test",
          timeoutMs: 2000,
        },
        process.cwd(),
        undefined,
        { mode: "none", network: "deny", pentestNetwork: "deny" },
      ),
  );
  assert.deepEqual(
    snapshots.map((e) => e.children[0].status),
    ["RESERVED", "STARTING", "RUNNING", "TERMINATED"],
  );
  assert.equal(snapshots[0].children[0].process, undefined);
  assert.equal(result.executionId, snapshots[0].children[0].id);
  assert.equal(snapshots[0].children[0].commandId, "controlled-child");
  assert.ok(snapshots[2].children[0].process?.pid);
  assert.equal(snapshots.at(-1)!.children[0].exitCode, 0);
  assert.equal(new Set(snapshots.map((e) => e.children[0].id)).size, 1);
});
for (const boundary of ["RESERVED", "STARTING", "RUNNING"] as const)
  test(`child persistence failure at ${boundary} never implies not-started`, async () => {
    const e = record();
    let durable = structuredClone(e);
    await assert.rejects(
      executionContext.run(
        {
          update: async (change) => {
            change(e);
            if (e.children[0].status === boundary)
              throw new Error("injected persistence failure");
            durable = structuredClone(e);
          },
        },
        () =>
          execute(
            {
              id: "failure-child",
              executable: process.execPath,
              args: ["-e", "setTimeout(()=>{},2000)"],
              purpose: "test",
              timeoutMs: 3000,
            },
            process.cwd(),
            undefined,
            { mode: "none", network: "deny", pentestNetwork: "deny" },
          ),
      ),
      /injected persistence failure/,
    );
    if (boundary === "RUNNING") {
      assert.equal(durable.children[0].status, "STARTING");
      assert.equal(durable.children[0].process, undefined);
      assert.equal((await inspectExecution(durable)).status, "UNKNOWN");
    }
  });

test("expired SDK execution context cannot mutate workflow state", async () => {
  const { runWithExecutionContext } =
    await import("../src/workflow/execution-identity.ts");
  const e = record();
  let saved: ReturnType<typeof executionContext.getStore>;
  await runWithExecutionContext(
    {
      update: async (change) => {
        change(e);
      },
    },
    async () => {
      saved = executionContext.getStore();
    },
  );
  await assert.rejects(
    saved!.update((execution) => {
      execution.status = "RUNNING";
    }),
    /context expired/,
  );
  assert.equal(e.status, "RESERVED");
});

test(
  "real managed process is active until its original creation identity exits",
  { skip: process.platform !== "linux", timeout: 10000 },
  async () => {
    const { spawn } = await import("node:child_process");
    const child = spawn(
      process.execPath,
      ["-e", "process.on('message',()=>process.exit(0));process.send('ready')"],
      { stdio: ["ignore", "pipe", "pipe", "ipc"] },
    );
    const exited = new Promise<void>((resolve, reject) => {
      child.once("exit", () => resolve());
      child.once("error", reject);
    });
    try {
      await new Promise<void>((resolve) =>
        child.once("message", () => resolve()),
      );
      const processIdentity = await captureProcessIdentity(child.pid!);
      const e = record();
      e.owner = { ...(await captureProcessIdentity()), pid: 2147483647 };
      e.status = "RUNNING";
      e.children.push({
        id: randomUUID(),
        status: "RUNNING",
        process: processIdentity,
      });
      assert.equal((await inspectExecution(e)).status, "ACTIVE");
      child.send("exit");
      await exited;
      assert.equal((await inspectExecution(e)).status, "TERMINATED");
      assert.equal(
        e.children[0].status,
        "RUNNING",
        "inspection must not fabricate an exit lifecycle event",
      );
    } finally {
      if (child.exitCode === null) child.kill();
      await exited;
    }
  },
);
