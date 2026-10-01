import { test } from "node:test";
import assert from "node:assert/strict";
import { access, readFile, realpath, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { loadExtensions } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js";
import {
  repository,
  disposeSerenaTestRuntime,
  isolateSerenaTestHome,
} from "./helpers.ts";
import { packagePath } from "../src/integrations/resources.ts";
import { PiRunner } from "../src/agents/runner.ts";
import { newState } from "../src/workflow/state.ts";
import { baseline } from "../src/workflow/git.ts";
import { config, output } from "./helpers.ts";
import type { Role } from "../src/agents/schemas.ts";

const available =
  spawnSync("serena", ["--version"], { stdio: "ignore" }).status === 0;
const extensionPath = packagePath("@bacnh85/pi-serena", "extensions/index.ts");

type SerenaStatus = {
  ok: boolean;
  pid: number;
  project: string;
  cachedAgents: number;
  activeProject?: string;
};

// pi-serena owns one module-level worker, so these fixtures deliberately run in
// sequence within this test file. Node's test runner isolates test files by process.
async function withSerenaProject<T>(
  run: (fixture: {
    cwd: string;
    home: string;
    status: (includeAgent?: boolean) => Promise<SerenaStatus>;
  }) => Promise<T>,
): Promise<T> {
  const cwd = await repository();
  const serenaHome = await isolateSerenaTestHome();
  let session:
    | {
        extensionRunner: { emit: (event: any) => Promise<void> };
        dispose: () => void;
      }
    | undefined;
  try {
    const loaded = await loadExtensions([extensionPath], cwd);
    assert.deepEqual(loaded.errors, []);
    const extension = loaded.extensions[0];
    assert.ok(extension);
    const ctx = { ui: { setStatus() {} } };
    session = {
      extensionRunner: {
        async emit(event: { type: "session_shutdown"; reason: "quit" }) {
          for (const handler of extension.handlers.get("session_shutdown") ??
            [])
            await handler(event, ctx);
        },
      },
      dispose() {},
    };
    return await run({
      cwd,
      home: serenaHome.home,
      async status(includeAgent = false) {
        const result = await extension.tools
          .get("serena_status")!
          .definition.execute(
            "lifecycle-status",
            { project: cwd, includeAgent },
            new AbortController().signal,
            undefined,
            ctx as any,
          );
        const details = result.details as SerenaStatus;
        assert.equal(details.ok, true, JSON.stringify(details));
        return details;
      },
    });
  } finally {
    try {
      await disposeSerenaTestRuntime(cwd, session as any);
    } finally {
      await serenaHome.dispose();
    }
  }
}

test(
  "Serena closes the project before deleting a temporary fixture",
  { skip: !available },
  async () => {
    let cwd = "";
    let home = "";
    await withSerenaProject(async (fixture) => {
      cwd = fixture.cwd;
      home = fixture.home;
      const status = await fixture.status(true);
      assert.equal(status.project, cwd);
      assert.equal(status.cachedAgents, 0);
      assert.equal(status.activeProject, await realpath(cwd));
      assert.match(
        await readFile(join(home, "serena_config.yml"), "utf8"),
        /pi-team-test-/,
      );
    });
    await assert.rejects(access(cwd), { code: "ENOENT" });
    await assert.rejects(access(home), { code: "ENOENT" });
  },
);

test(
  "Serena teardown also runs after a failed test body",
  { skip: !available },
  async () => {
    let cwd = "";
    await assert.rejects(
      withSerenaProject(async (fixture) => {
        cwd = fixture.cwd;
        await fixture.status(true);
        throw new Error("fixture assertion failed");
      }),
      /fixture assertion failed/,
    );
    await assert.rejects(access(cwd), { code: "ENOENT" });
  },
);

test(
  "repeated Serena fixtures leave no cached project or late warning",
  { skip: !available },
  async () => {
    const warnings: string[] = [];
    const originalWrite = process.stderr.write;
    process.stderr.write = function (
      this: typeof process.stderr,
      chunk: any,
      ...args: any[]
    ) {
      warnings.push(String(chunk));
      return originalWrite.call(this, chunk, ...args);
    } as typeof process.stderr.write;
    try {
      for (let i = 0; i < 20; i++) {
        await withSerenaProject(async ({ cwd, status }) => {
          const before = await status();
          assert.equal(before.cachedAgents, 0);
          const active = await status(true);
          assert.equal(active.cachedAgents, 0);
          assert.equal(active.activeProject, await realpath(cwd));
          assert.equal((await status()).cachedAgents, 1);
        });
      }
      assert.equal(
        warnings.some((line) =>
          /Project path .*pi-team-test-.* does not exist/i.test(line),
        ),
        false,
      );
    } finally {
      process.stderr.write = originalWrite;
    }
  },
);

test(
  "a later Serena fixture cannot observe the previous project",
  { skip: !available },
  async () => {
    let firstPath = "";
    let firstPid = 0;
    await withSerenaProject(async ({ cwd, status }) => {
      firstPath = cwd;
      firstPid = (await status(true)).pid;
    });
    await withSerenaProject(async ({ cwd, status }) => {
      const fresh = await status();
      assert.equal(fresh.cachedAgents, 0);
      assert.notEqual(fresh.pid, firstPid);
      assert.equal((await status(true)).activeProject, await realpath(cwd));
      assert.notEqual(cwd, firstPath);
    });
  },
);

test("a completed child agent does not shut down a sibling's shared Serena worker", async () => {
  const cwd = await repository();
  try {
    const cfg = config();
    cfg.integrations.serena.enabled = true;
    const state = newState(cwd, "shared worker", cfg, await baseline(cwd));
    const runner = new PiRunner();
    const finish = new Map<Role, () => void>();
    const started = new Map<Role, Promise<void>>();
    let shutdowns = 0;
    for (const role of ["researcher", "solver1"] as const) {
      let start!: () => void;
      started.set(role, new Promise<void>((resolve) => (start = resolve)));
      let complete!: () => void;
      const pending = new Promise<void>((resolve) => (complete = resolve));
      finish.set(role, complete);
      const original = runner.createSession.bind(runner);
      runner.createSession = async (current, ...args) =>
        current === role
          ? ({
              messages: [],
              prompt: async () => {
                start();
                await pending;
              },
              getLastAssistantText: () => JSON.stringify(output(role)),
              extensionRunner: {
                emit: async () => {
                  shutdowns++;
                },
              },
              dispose() {},
              abort: async () => {},
            } as any)
          : original(current, ...args);
    }
    const first = runner.run("researcher", state);
    const second = runner.run("solver1", state);
    await Promise.all(started.values());
    finish.get("researcher")!();
    await first;
    assert.equal(shutdowns, 0);
    finish.get("solver1")!();
    await second;
    assert.equal(shutdowns, 0);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
