import { test } from "node:test";
import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { createServer, type Socket } from "node:net";
import { appendFile, mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { repository } from "./helpers.ts";
import { StateStore } from "../src/workflow/persistence.ts";
import {
  captureProcessIdentity,
  verifyProcessIdentity,
  type ProcessIdentity,
} from "../src/workflow/execution-identity.ts";

type Message = {
  kind: string;
  workflowId?: string;
  executionId?: string;
  childId?: string;
  process?: any;
  boundary?: string;
  phase?: string;
  plan?: any;
  rejections?: string[];
  approvals?: number;
  rejected?: string;
  error?: string;
};
function bounded<T>(
  promise: Promise<T>,
  label: string,
  ms = 15000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout: ${label}`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
async function terminated(identity: ProcessIdentity) {
  const end = Date.now() + 15000;
  let last;
  do {
    last = await verifyProcessIdentity(identity);
    if (last.status === "TERMINATED") return last;
    await delay(15);
  } while (Date.now() < end);
  throw new Error(
    `Owned child termination could not be verified: ${JSON.stringify(last)}`,
  );
}
async function fixture(role: "pentester" | "tester", mode = "durable") {
  const cwd = await repository();
  const control = join(cwd, "crash-control");
  await mkdir(control);
  await appendFile(join(cwd, ".git/info/exclude"), "\n/crash-control/\n");
  const token = randomUUID();
  const socketPath = join(control, "control.sock");
  const handles = new Set<ChildProcess>();
  let socket: Socket | undefined;
  let identity: ProcessIdentity | undefined;
  let readyResolve!: (pid: number) => void;
  let readyReject!: (error: Error) => void;
  const childReady = new Promise<number>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  // Register rejection handling immediately, including fixture startup failures.
  void childReady.catch(() => {});
  const server = createServer((connection) => {
    let buffer = "";
    connection.on("data", (data) => {
      buffer += data.toString();
      if (!buffer.includes("\n")) return;
      try {
        const message = JSON.parse(buffer.split("\n")[0]);
        assert.equal(message.token, token);
        assert.equal(message.kind, "child-ready");
        socket = connection;
        // Retain independently verified ownership even if host readiness fails.
        void captureProcessIdentity(message.pid, true).then((owned) => {
          identity = owned;
          readyResolve(message.pid);
        }, readyReject);
      } catch (error) {
        readyReject(error as Error);
        connection.destroy();
      }
    });
    connection.on("error", () => {});
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  function launch(action: string) {
    const child = fork(
      new URL("./fixtures/linux-crash-worker.ts", import.meta.url),
      [action, cwd, role, mode, socketPath, token],
      {
        execArgv: ["--import", "tsx"],
        // SIGKILL skips command cleanup; keep its temporary HOME/work directories
        // inside this owned fixture so final cleanup removes them as well.
        env: { ...process.env, TMPDIR: control, TMP: control, TEMP: control },
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      },
    );
    handles.add(child);
    let diagnostics = "";
    child.stdout!.on("data", (chunk) => {
      diagnostics = (diagnostics + chunk).slice(-32000);
    });
    child.stderr!.on("data", (chunk) => {
      diagnostics = (diagnostics + chunk).slice(-32000);
    });
    const exited = new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    const message = new Promise<Message>((resolve, reject) => {
      child.once("message", (value) => {
        const m = value as Message;
        m.kind === "failure" ? reject(new Error(m.error)) : resolve(m);
      });
      child.once("error", reject);
      child.once("exit", (code, signal) => {
        if (code !== 0)
          reject(new Error(`Worker exited ${code}/${signal}: ${diagnostics}`));
      });
    });
    void exited.catch(() => {});
    void message.catch(() => {});
    return {
      child,
      exited,
      message: bounded(message, `${action} worker message`),
      diagnostics: () => diagnostics,
    };
  }
  async function worker(action: string) {
    const p = launch(action);
    const message = await p.message;
    const exit = await bounded(p.exited, `${action} worker exit`);
    assert.equal(exit.code, 0, p.diagnostics());
    return message;
  }
  const host = launch("host");
  async function events() {
    return (await readFile(join(control, "starts.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }
  async function cleanup() {
    for (const p of handles)
      if (p.exitCode === null && p.signalCode === null) p.kill("SIGKILL");
    await Promise.all(
      [...handles].map((p) =>
        p.exitCode !== null || p.signalCode !== null
          ? Promise.resolve()
          : bounded(
              new Promise<void>((resolve) => p.once("exit", () => resolve())),
              "owned worker cleanup",
            ),
      ),
    );
    if (socket && !socket.destroyed) socket.write("stop\n");
    if (identity) {
      if ((await verifyProcessIdentity(identity)).status === "ACTIVE") {
        // Token-authenticated IPC is the first choice; signal only this positively matched fixture PID if needed.
        await terminated(identity).catch(async () => {
          if ((await verifyProcessIdentity(identity)).status === "ACTIVE")
            process.kill(identity!.pid, "SIGTERM");
          await terminated(identity!);
        });
      } else await terminated(identity);
    }
    socket?.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(cwd, { recursive: true, force: true });
  }
  return {
    cwd,
    store: new StateStore(cwd),
    host,
    worker,
    events,
    async ready() {
      const [message, pid] = await Promise.all([
        host.message,
        bounded(childReady, "managed child IPC ready"),
      ]);
      identity = await captureProcessIdentity(pid, true);
      assert.equal(message.process.pid, pid);
      assert.equal(message.process.creation, identity.creation);
      return { message, identity };
    },
    async killHost() {
      host.child.kill("SIGKILL");
      const exit = await bounded(host.exited, "SIGKILL host exit");
      assert.equal(exit.signal, "SIGKILL");
    },
    async stopChild() {
      assert.ok(socket);
      socket.write("stop\n");
      assert.ok(identity);
      await terminated(identity);
    },
    cleanup,
  };
}

for (const role of ["pentester", "tester"] as const)
  test(
    `real Linux SIGKILL: surviving ${role} managed child blocks concurrent recovery`,
    { skip: process.platform !== "linux", timeout: 90000 },
    async () => {
      const f = await fixture(role);
      try {
        const { message, identity } = await f.ready();
        const before = await f.store.load(message.workflowId!);
        const execution = before.executions.find(
          (e) => e.id === message.executionId,
        )!;
        assert.equal(execution.workflowId, before.id);
        assert.equal(execution.agent, role);
        assert.equal(execution.attempt, 1);
        assert.equal(execution.status, "RUNNING");
        assert.equal(execution.children[0].id, message.childId);
        assert.deepEqual(execution.children[0].process, identity);
        assert.equal(
          (await f.events()).filter((e) => e.kind === "child-start").length,
          1,
        );
        assert.equal((await verifyProcessIdentity(identity)).status, "ACTIVE");
        const liveContender = await f.worker("claim");
        assert.match(liveContender.rejected!, /already running/);
        assert.equal(
          (await f.store.load(before.id)).executions.find(
            (e) => e.agent === role,
          )!.id,
          execution.id,
        );
        await f.killHost();
        assert.equal(
          (await verifyProcessIdentity(execution.owner)).status,
          "TERMINATED",
        );
        assert.equal(
          JSON.parse(await readFile(join(f.store.dir, "active.lock"), "utf8"))
            .pid,
          f.host.child.pid,
        );
        assert.equal((await verifyProcessIdentity(identity)).status, "ACTIVE");
        const restart = await f.worker("inspect");
        assert.equal(restart.process.status, "ACTIVE");
        assert.equal(restart.phase, "BLOCKED");
        assert.equal(restart.plan.kind, "unsafe");
        const requests = await Promise.all([
          f.worker("recover"),
          f.worker("recover"),
        ]);
        assert.ok(
          requests.some((r) =>
            r.rejections?.some((error) => error.includes("ACTIVE")),
          ),
        );
        assert.ok(requests.every((r) => r.approvals === 0));
        const after = await f.store.load(before.id);
        assert.equal(
          after.executions.filter((e) => e.agent === role).length,
          1,
        );
        assert.equal(
          after.executions.find((e) => e.agent === role)!.id,
          execution.id,
        );
        assert.equal(
          after.history.filter(
            (e) => e.event === "interrupted_agent_recovery_accepted",
          ).length,
          0,
        );
        assert.deepEqual(
          (await f.events())
            .filter((e) => e.kind === "agent-start")
            .map((e) => e.attempt),
          [1],
        );
        assert.equal((await verifyProcessIdentity(identity)).status, "ACTIVE");
      } finally {
        await f.cleanup();
      }
    },
  );

test(
  "real Linux SIGKILL: terminated child permits approved recovery and one cross-process retry claim",
  { skip: process.platform !== "linux", timeout: 90000 },
  async () => {
    const f = await fixture("tester");
    try {
      const { message, identity } = await f.ready();
      const initial = await f.store.load(message.workflowId!);
      const original = initial.executions.find(
        (e) => e.id === message.executionId,
      )!;
      assert.deepEqual(original.children[0].process, identity);
      assert.equal(original.status, "RUNNING");
      assert.equal((await verifyProcessIdentity(identity)).status, "ACTIVE");
      await f.killHost();
      assert.equal((await verifyProcessIdentity(identity)).status, "ACTIVE");
      await f.stopChild();
      const restart = await f.worker("inspect");
      assert.equal(restart.process.status, "TERMINATED");
      assert.equal(restart.plan.kind, "interrupted-quality-gate");
      const blocked = await f.store.load(message.workflowId!);
      assert.equal(blocked.phase, "BLOCKED");
      assert.deepEqual(
        (await f.events())
          .filter((e) => e.kind === "agent-start")
          .map((e) => e.attempt),
        [1],
      );
      const prepare = await f.worker("prepare");
      assert.equal(prepare.approvals, 1);
      assert.deepEqual(prepare.rejections, []);
      const claims = await Promise.all([f.worker("claim"), f.worker("claim")]);
      assert.ok(claims.some((r) => r.phase === "DONE"));
      const final = await f.store.load(message.workflowId!);
      assert.equal(final.phase, "DONE", final.blocker);
      for (const agent of [
        "implementor",
        "codeReviewer",
        "securityReviewer",
      ] as const) {
        assert.deepEqual(final.results[agent], initial.results[agent]);
        assert.equal(
          final.history.filter(
            (e) =>
              e.event === "agent_attempt_started" && e.meta?.agent === agent,
          ).length,
          1,
        );
      }
      assert.equal(
        (await f.events()).filter((e) => e.kind === "child-start").length,
        1,
      );
      assert.ok(
        !final.history.some(
          (e) =>
            ["agent_attempt_completed", "agent_attempt_failed"].includes(
              e.event,
            ) &&
            e.meta?.agent === "tester" &&
            e.meta.attempt === 1,
        ),
      );
      const executions = final.executions.filter((e) => e.agent === "tester");
      assert.deepEqual(
        executions.map((e) => e.attempt),
        [1, 2],
      );
      assert.equal(new Set(executions.map((e) => e.id)).size, 2);
      assert.equal(
        executions[0].status,
        "RUNNING",
        "crashed execution history must not be fabricated as completed",
      );
      assert.equal(executions[1].status, "COMPLETED");
      assert.equal(
        final.history.filter(
          (e) => e.event === "interrupted_agent_recovery_accepted",
        ).length,
        1,
      );
      assert.deepEqual(
        (await f.events())
          .filter((e) => e.kind === "agent-start")
          .map((e) => e.attempt),
        [1, 2],
      );
    } finally {
      await f.cleanup();
    }
  },
);

test(
  "real Linux SIGKILL before child identity save stays UNKNOWN even after the child exits",
  { skip: process.platform !== "linux", timeout: 90000 },
  async () => {
    const f = await fixture("tester", "identity-gap");
    try {
      const { message, identity } = await f.ready();
      const before = await f.store.load(message.workflowId!);
      const execution = before.executions.find(
        (e) => e.id === message.executionId,
      )!;
      assert.equal(message.boundary, "before-identity-save");
      assert.equal(execution.children[0].status, "STARTING");
      assert.equal(execution.children[0].process, undefined);
      await f.killHost();
      assert.equal((await verifyProcessIdentity(identity)).status, "ACTIVE");
      const restart = await f.worker("inspect");
      assert.equal(restart.process.status, "UNKNOWN");
      assert.equal(restart.plan.kind, "unsafe");
      const requests = await Promise.all([
        f.worker("recover"),
        f.worker("recover"),
      ]);
      assert.ok(requests.every((r) => r.approvals === 0));
      assert.ok(
        requests.some((r) =>
          r.rejections?.some((error) => error.includes("UNKNOWN")),
        ),
      );
      await f.stopChild();
      const afterExit = await f.worker("inspect");
      assert.equal(afterExit.process.status, "UNKNOWN");
      const durable = await f.store.load(before.id);
      assert.equal(
        durable.executions.find((e) => e.id === execution.id)!.children[0]
          .process,
        undefined,
      );
      assert.equal(
        durable.executions.find((e) => e.id === execution.id)!.children[0]
          .status,
        "STARTING",
      );
      assert.ok(
        !durable.history.some(
          (e) =>
            ["agent_attempt_completed", "agent_attempt_failed"].includes(
              e.event,
            ) &&
            e.meta?.agent === "tester" &&
            e.meta.attempt === 1,
        ),
      );
      assert.equal(
        (await f.events()).filter((e) => e.kind === "child-start").length,
        1,
      );
      assert.equal(
        durable.executions.filter((e) => e.agent === "tester").length,
        1,
      );
      assert.deepEqual(
        (await f.events())
          .filter((e) => e.kind === "agent-start")
          .map((e) => e.attempt),
        [1],
      );
    } finally {
      await f.cleanup();
    }
  },
);
