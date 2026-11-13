/** Controlled subprocess fixture; never loaded by the production extension. */
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { WorkflowEngine } from "../../src/workflow/engine.ts";
import { execute } from "../../src/agents/commands.ts";
import {
  executionContext,
  inspectExecution,
} from "../../src/workflow/execution-identity.ts";
import { getWorkflowRecoveryPlan } from "../../src/workflow/recovery.ts";
import { config, FixtureRunner } from "../helpers.ts";
import type { Role } from "../../src/agents/schemas.ts";

const [action, cwd, roleArg, mode, socketPath, token] = process.argv.slice(2);
const role = roleArg as "tester" | "pentester";
const control = join(cwd, "crash-control");
const send = (message: unknown) =>
  new Promise<void>((resolve, reject) => {
    process.send!(message, (error) => (error ? reject(error) : resolve()));
  });
const childScript = `
const net=require('node:net');const fs=require('node:fs');
const [socketPath,token,counter]=process.argv.slice(1);
const socket=net.createConnection(socketPath);
socket.once('connect',()=>{fs.appendFileSync(counter,JSON.stringify({kind:'child-start',pid:process.pid,token})+'\\n');socket.write(JSON.stringify({kind:'child-ready',pid:process.pid,token})+'\\n');});
socket.on('data',data=>{if(data.toString().includes('stop'))process.exit(0);});
socket.on('error',()=>process.exit(87));socket.on('close',()=>process.exit(0));
setTimeout(()=>process.exit(88),120000);
`;
let approvals = 0;
let engine: WorkflowEngine;
const runner = new FixtureRunner(async (agent: Role) => {
  if (agent !== role) return undefined;
  const state = await engine.store.latest();
  const execution = state!.executions.findLast((e) => e.agent === role)!;
  await appendFile(
    join(control, "starts.jsonl"),
    JSON.stringify({
      kind: "agent-start",
      agent,
      attempt: execution.attempt,
      id: execution.id,
      pid: process.pid,
    }) + "\n",
  );
  if (action === "host") {
    await executionContext.getStore()!.update((e) => {
      e.status = "RUNNING";
    });
    await execute(
      {
        id: "crash-managed-child",
        executable: process.execPath,
        args: [
          "-e",
          childScript,
          socketPath,
          token,
          join(control, "starts.jsonl"),
        ],
        purpose: role === "tester" ? "test" : "pentest",
        timeoutMs: 120000,
      },
      cwd,
      undefined,
      // Same controlled host-execution fixture mode as execution-identity.test.ts.
      // No project/global sandbox configuration is modified.
      { mode: "none", network: "deny", pentestNetwork: "deny" },
    );
  }
  return undefined;
});
engine = new WorkflowEngine(cwd, runner, {
  progress() {},
  ask: async () => undefined,
  approve: async () => {
    approvals++;
    return ["recover"];
  },
});
try {
  if (action === "host") {
    let notified = false;
    const save = engine.store.save.bind(engine.store);
    engine.store.save = async (state) => {
      const execution = state.executions.findLast((e) => e.agent === role);
      const child = execution?.children.find(
        (c) =>
          c.commandId === "crash-managed-child" &&
          c.status === "RUNNING" &&
          c.process?.creation,
      );
      if (!notified && execution && child && mode === "identity-gap") {
        notified = true;
        await send({
          kind: "ready",
          workflowId: state.id,
          executionId: execution.id,
          childId: child.id,
          process: child.process,
          boundary: "before-identity-save",
        });
        await new Promise<void>(() => {}); // SIGKILL is injected while the write is suspended.
      }
      await save(state);
      if (!notified && execution && child) {
        notified = true;
        await send({
          kind: "ready",
          workflowId: state.id,
          executionId: execution.id,
          childId: child.id,
          process: child.process,
          boundary: "identity-durable",
        });
      }
    };
    const cfg = config();
    cfg.qualityGates.commit.enabled = false;
    cfg.qualityGates.pentest.enabled = role === "pentester";
    cfg.logging.agentLogs.level = "off";
    await engine.run(await engine.start("isolated Linux crash fixture", cfg));
    throw new Error("Host unexpectedly completed before SIGKILL");
  }
  const state = (await engine.store.latest())!;
  if (action === "inspect") await engine.run(state); // Acquires/reclaims the actual workflow lock; never bypasses recovery.
  if (action === "claim") {
    try {
      await engine.run(state);
    } catch (error) {
      if (
        !/already running|recovering the workflow lock|lock changed/.test(
          String(error),
        )
      )
        throw error;
      await send({ kind: "result", rejected: String(error), approvals });
      process.disconnect();
      process.exitCode = 0;
      // The losing process has no execution claim.
      await new Promise<void>((resolve) => setImmediate(resolve));
      process.exit(0);
    }
  }
  const rejections: string[] = [];
  if (action === "recover" || action === "prepare") {
    const count = action === "recover" ? 2 : 1;
    for (let i = 0; i < count; i++)
      try {
        await engine.retryAgent(state, role, false, "recover");
      } catch (error) {
        rejections.push(String(error));
      }
  }
  const durable = (await engine.store.latest())!;
  const execution = durable.executions.find(
    (e) => e.agent === role && e.attempt === 1,
  )!;
  await send({
    kind: "result",
    phase: durable.phase,
    process: await inspectExecution(execution),
    plan: await getWorkflowRecoveryPlan(durable, cwd),
    rejections,
    approvals,
  });
  process.disconnect();
} catch (error) {
  await send({
    kind: "failure",
    error: error instanceof Error ? error.stack : String(error),
  }).catch(() => {});
  process.disconnect?.();
  process.exitCode = 1;
}
