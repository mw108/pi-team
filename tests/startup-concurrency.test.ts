import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import YAML from "yaml";
import teamExtension from "../src/index.ts";
import { WorkflowEngine } from "../src/workflow/engine.ts";
import { StateStore } from "../src/workflow/persistence.ts";
import type { WorkflowState } from "../src/workflow/state.ts";
import { config, repository } from "./helpers.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

async function setup() {
  const cwd = await repository();
  await writeFile(join(cwd, ".pi/team/team.yaml"), YAML.stringify(config()));
  const commands = new Map<
    string,
    { handler: (args: string, ctx: any) => Promise<void> }
  >();
  const notices: string[] = [];
  teamExtension({
    on: () => {},
    registerCommand: (name: string, command: any) =>
      commands.set(name, command),
    appendEntry: () => {},
  } as any);
  const ctx = {
    cwd,
    waitForIdle: async () => {},
    ui: {
      notify: (message: string) => notices.push(message),
      setStatus: () => {},
      setWidget: () => {},
    },
  };
  return { cwd, commands, notices, ctx };
}

test("a second /team is rejected during startup and ownership passes to the run", async () => {
  const { cwd, commands, notices, ctx } = await setup();
  const startup = deferred<void>();
  const running = deferred<WorkflowState>();
  const originalStart = WorkflowEngine.prototype.start;
  const originalRun = WorkflowEngine.prototype.run;
  let starts = 0;
  let runningState: WorkflowState | undefined;
  WorkflowEngine.prototype.start = async function (...args) {
    starts++;
    return originalStart.apply(this, args);
  };
  WorkflowEngine.prototype.run = async function (state) {
    runningState = state;
    return running.promise;
  } as typeof WorkflowEngine.prototype.run;
  try {
    ctx.waitForIdle = () => startup.promise;
    const first = commands.get("team")!.handler("First task", ctx);
    await commands.get("team")!.handler("Second task", ctx);
    assert.match(notices.at(-1) ?? "", /already active/);
    assert.equal(starts, 0);
    await commands.get("team-status")!.handler("", ctx);
    assert.match(notices.at(-1) ?? "", /starting/);
    startup.resolve();
    await first;
    assert.equal(starts, 1);
    assert.ok(runningState);
    await commands.get("team")!.handler("Third task", ctx);
    assert.match(notices.at(-1) ?? "", /already active/);
    const files = await readdir(join(cwd, ".pi/team/state"));
    assert.equal(files.filter((file) => file.endsWith(".json")).length, 1);
    assert.equal((await new StateStore(cwd).latest())?.id, runningState.id);
  } finally {
    if (runningState) running.resolve(runningState);
    WorkflowEngine.prototype.start = originalStart;
    WorkflowEngine.prototype.run = originalRun;
  }
});

test("failed startup releases the reservation for a later /team", async () => {
  const { commands, notices, ctx } = await setup();
  const startup = deferred<void>();
  const running = deferred<WorkflowState>();
  const originalStart = WorkflowEngine.prototype.start;
  const originalRun = WorkflowEngine.prototype.run;
  let starts = 0;
  let runningState: WorkflowState | undefined;
  WorkflowEngine.prototype.start = async function (...args) {
    starts++;
    return originalStart.apply(this, args);
  };
  WorkflowEngine.prototype.run = async function (state) {
    runningState = state;
    return running.promise;
  } as typeof WorkflowEngine.prototype.run;
  try {
    ctx.waitForIdle = () => startup.promise;
    const first = commands.get("team")!.handler("First task", ctx);
    await commands.get("team")!.handler("Second task", ctx);
    assert.match(notices.at(-1) ?? "", /already active/);
    startup.reject(new Error("Idle wait failed"));
    await first;
    assert.match(notices.at(-1) ?? "", /Idle wait failed/);
    assert.equal(starts, 0);
    ctx.waitForIdle = async () => {};
    await commands.get("team")!.handler("Later task", ctx);
    assert.equal(starts, 1);
    assert.ok(runningState);
  } finally {
    if (runningState) running.resolve(runningState);
    WorkflowEngine.prototype.start = originalStart;
    WorkflowEngine.prototype.run = originalRun;
  }
});
