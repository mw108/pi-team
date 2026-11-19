import test from "node:test";
import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { approvalRecoveryFixture } from "./fixtures/approval-recovery.ts";

function host(cwd: string, id: string, boundary: string) {
  const child = fork(
    new URL("./fixtures/approval-recovery-process.ts", import.meta.url),
    [cwd, id, boundary],
    {
      execArgv: ["--import", "tsx"],
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    },
  );
  let stderr = "";
  child.stderr?.on("data", (data) => {
    stderr += data;
  });
  const message = new Promise<any>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Recovery host timeout: " + stderr)),
      15000,
    );
    child.once("message", (value) => {
      clearTimeout(timeout);
      resolve(value);
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      if (code) reject(new Error(`Host exited ${code}: ${stderr}`));
    });
  });
  return { child, message };
}
async function kill(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  await exited;
}
for (const boundary of [
  "before-decision",
  "during-reconciliation",
  "after-decision",
]) {
  test(`real resume host crash ${boundary} leaves recoverable durable approval state`, async (t) => {
    const f = await approvalRecoveryFixture(null);
    const first = host(f.cwd, f.state.id, boundary);
    t.after(() => kill(first.child));
    assert.equal((await first.message).boundary, boundary);
    await kill(first.child);
    const saved = await f.engine.store.load(f.state.id);
    assert.equal(
      saved.pendingRuntimeCommands.length,
      boundary === "after-decision" ? 0 : 1,
    );
    assert.equal(
      saved.runtimeCommandApprovals.length,
      boundary === "after-decision" ? 1 : 0,
    );
    assert.equal(saved.executions.length, 1);
    const second = host(f.cwd, f.state.id, "finish");
    t.after(() => kill(second.child));
    const result = await second.message;
    assert.equal(result.done, true);
    assert.equal(result.phase, "BLOCKED");
    assert.equal(result.pending, 0);
    assert.equal(result.executions, 1);
    assert.equal(result.reconciled, 1);
    assert.equal(result.actionable, true);
    await once(second.child, "exit");
    assert.deepEqual(
      (await f.engine.store.load(f.state.id)).results,
      f.state.results,
    );
  });
}
