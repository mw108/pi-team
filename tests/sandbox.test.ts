import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "./helpers.ts";
import { configSchema } from "../src/config/schema.ts";
import { execute } from "../src/agents/commands.ts";
import {
  bubblewrapArgs,
  bubblewrapAvailable,
  sandboxSetupFailure,
  SandboxSetupError,
  SandboxUnavailableError,
} from "../src/agents/sandbox.ts";
import { commandNetworkPolicy } from "../src/agents/command-policy.ts";

function command(source: string, purpose: "test" | "pentest" = "test") {
  return {
    id: "sandbox-test",
    executable: process.execPath,
    args: ["-e", source],
    purpose,
    timeoutMs: 5000,
  };
}

test("sandbox defaults and unknown values", () => {
  assert.deepEqual(config().execution.sandbox, {
    mode: "auto",
    network: "deny",
    pentestNetwork: "deny",
  });
  assert.deepEqual(
    configSchema.parse({ ...config(), execution: undefined }).execution.sandbox,
    { mode: "auto", network: "deny", pentestNetwork: "deny" },
  );
  assert.equal(commandNetworkPolicy("static", "deny", "allow"), "deny");
  assert.equal(commandNetworkPolicy("static", "allow", "deny"), "allow");
  assert.equal(commandNetworkPolicy("pentest", "deny", "allow"), "allow");
  assert.equal(
    configSchema.safeParse({
      ...config(),
      execution: { sandbox: { mode: "surprise" } },
    }).success,
    false,
  );
});

test("constrained execution isolates HOME and temp, filters credentials, and preserves output", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-team-sandbox-test-"));
  const fakeHome = join(cwd, "real-home");
  const old = Object.fromEntries(
    ["HOME", "OPENAI_API_KEY", "AWS_SECRET_ACCESS_KEY", "SSH_AUTH_SOCK"].map(
      (key) => [key, process.env[key]],
    ),
  );
  try {
    await mkdir(join(fakeHome, ".ssh"), { recursive: true });
    await writeFile(join(fakeHome, ".ssh", "fixture"), "FAKE_SECRET");
    await writeFile(join(cwd, "source.txt"), "source");
    process.env.HOME = fakeHome;
    process.env.OPENAI_API_KEY = "FAKE_SECRET";
    process.env.AWS_SECRET_ACCESS_KEY = "FAKE_SECRET";
    process.env.SSH_AUTH_SOCK = "/fake/agent";
    const result = await execute(
      command(`const fs=require('fs'),p=require('path');
        console.log(JSON.stringify({home:process.env.HOME,tmp:process.env.TMPDIR,
          secret:process.env.OPENAI_API_KEY,aws:process.env.AWS_SECRET_ACCESS_KEY,
          ssh:process.env.SSH_AUTH_SOCK,
          homeSecret:fs.existsSync(p.join(process.env.HOME,'.ssh','fixture')),
          source:fs.readFileSync('source.txt','utf8')}));
        fs.writeFileSync('build.txt','built'); console.error('stderr-line'); process.exit(7)`),
      cwd,
      undefined,
      { mode: "none", network: "deny", pentestNetwork: "deny" },
    );
    const data = JSON.parse(result.stdout!.trim());
    assert.notEqual(data.home, fakeHome);
    assert.notEqual(data.tmp, process.env.TMPDIR);
    assert.equal(data.homeSecret, false);
    assert.equal(data.secret, undefined);
    assert.equal(data.aws, undefined);
    assert.equal(data.ssh, undefined);
    assert.equal(data.source, "source");
    assert.equal(await readFile(join(cwd, "build.txt"), "utf8"), "built");
    assert.equal(result.exitCode, 7);
    assert.match(result.stderr!, /stderr-line/);
    assert.equal(result.sandbox.mode, "none");
    assert.equal(result.sandbox.network, "host");
    await assert.rejects(stat(data.home), { code: "ENOENT" });
  } finally {
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(cwd, { recursive: true, force: true });
  }
});

test("Bubblewrap argv keeps repository writable, hides team internals, and denies network by category", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-team-bwrap-argv-"));
  try {
    await mkdir(join(cwd, ".pi/team/state"), { recursive: true });
    await mkdir(join(cwd, ".pi/team/agents"));
    const denied = bubblewrapArgs(command(""), cwd, "deny");
    assert.ok(denied.includes("--unshare-net"));
    assert.deepEqual(denied.slice(-3), [process.execPath, "-e", ""]);
    assert.ok(
      denied.some((arg, i) => arg === "--bind" && denied[i + 1] === cwd),
    );
    assert.ok(
      denied.some(
        (arg, i) =>
          arg === "--ro-bind" && denied[i + 1] === join(cwd, ".pi/team"),
      ),
    );
    for (const name of ["state", "agents"])
      assert.ok(
        denied.some(
          (arg, i) =>
            arg === "--tmpfs" && denied[i + 1] === join(cwd, ".pi/team", name),
        ),
      );
    assert.equal(
      denied.includes(process.env.HOME ?? "unavailable-home"),
      false,
    );
    const allowed = bubblewrapArgs(command("", "pentest"), cwd, "allow");
    assert.equal(allowed.includes("--unshare-net"), false);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("auto fallback is visible and required mode fails when bwrap is absent", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-team-bwrap-absent-"));
  const oldPath = process.env.PATH;
  try {
    process.env.PATH = cwd;
    const result = await execute(command("console.log('ok')"), cwd);
    assert.equal(result.sandbox.mode, "constrained-host");
    assert.equal(result.sandbox.temporaryHome, true);
    assert.equal(result.sandbox.filesystemIsolation, false);
    assert.match(result.stdout!, /ok/);
    await assert.rejects(
      execute(command("process.exit(0)"), cwd, undefined, {
        mode: "required",
        network: "deny",
        pentestNetwork: "deny",
      }),
      SandboxUnavailableError,
    );
  } finally {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    await rm(cwd, { recursive: true, force: true });
  }
});

test("Bubblewrap startup failure is infrastructure, not a test failure", () => {
  const sandbox = {
    mode: "bubblewrap" as const,
    network: "deny" as const,
    temporaryHome: true,
    filesystemIsolation: true,
  };
  const error = sandboxSetupFailure(
    sandbox,
    1,
    "bwrap: namespace unavailable",
    false,
  );
  assert.ok(error instanceof SandboxSetupError);
  assert.equal(error.code, "SANDBOX_SETUP_FAILED");
  assert.equal(
    sandboxSetupFailure(sandbox, 0, "bwrap: test output", false),
    undefined,
  );
  assert.equal(
    sandboxSetupFailure(sandbox, 1, "bwrap: timeout", true),
    undefined,
  );
});

test("abort kills a running command and cleans its temporary home", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-team-sandbox-abort-"));
  const controller = new AbortController();
  try {
    const pending = execute(
      command(`const {spawn}=require('child_process');
        const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
        console.log(JSON.stringify({home:process.env.HOME,pid:child.pid}));
        setInterval(()=>{},1000)`),
      cwd,
      controller.signal,
      { mode: "none", network: "deny", pentestNetwork: "deny" },
    );
    setTimeout(() => controller.abort(), 250);
    const result = await pending;
    assert.notEqual(result.exitCode, 0);
    const { home, pid } = JSON.parse(result.stdout!.trim());
    await assert.rejects(stat(home), { code: "ENOENT" });
    for (let i = 0; i < 20; i++) {
      try {
        process.kill(pid, 0);
        await new Promise((resolve) => setTimeout(resolve, 25));
      } catch {
        break;
      }
    }
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test(
  "optional Linux Bubblewrap blocks loopback and permits repository output",
  { skip: !bubblewrapAvailable() },
  async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-team-bwrap-live-"));
    const server = createServer((socket) => socket.end());
    try {
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("No loopback port");
      await writeFile(join(cwd, "source.txt"), "source");
      await mkdir(join(cwd, ".pi/team/state"), { recursive: true });
      await writeFile(join(cwd, ".pi/team/state", "private.txt"), "private");
      const source = `const fs=require('fs'),net=require('net');
        if(fs.existsSync('.pi/team/state/private.txt')) process.exit(10);
        fs.writeFileSync('build.txt',fs.readFileSync('source.txt'));
        const s=net.connect(${address.port},'127.0.0.1');
        s.on('connect',()=>process.exit(9));
        s.on('error',()=>process.exit(0));
        setTimeout(()=>process.exit(8),1000)`;
      const result = await execute(command(source), cwd, undefined, {
        mode: "required",
        network: "deny",
        pentestNetwork: "deny",
      });
      assert.equal(result.exitCode, 0);
      assert.equal(result.sandbox.mode, "bubblewrap");
      assert.equal(result.sandbox.network, "deny");
      assert.equal(await readFile(join(cwd, "build.txt"), "utf8"), "source");
      assert.equal(
        await readFile(join(cwd, ".pi/team/state", "private.txt"), "utf8"),
        "private",
      );
      const allowed = await execute(
        command(source, "pentest"),
        cwd,
        undefined,
        {
          mode: "required",
          network: "deny",
          pentestNetwork: "allow",
        },
      );
      assert.equal(allowed.exitCode, 9);
      assert.equal(allowed.sandbox.network, "allow");
    } finally {
      server.close();
      await rm(cwd, { recursive: true, force: true });
    }
  },
);
