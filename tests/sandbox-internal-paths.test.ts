import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serializeErrorDiagnostics } from "../src/agents/error-diagnostics.ts";
import {
  bubblewrapArgs,
  prepareExecution,
  SandboxSetupError,
  SandboxUnavailableError,
  validateSandboxInternalPaths,
} from "../src/agents/sandbox.ts";

const command = {
  id: "sandbox-path-test",
  executable: process.execPath,
  args: ["-e", "require('fs').writeFileSync('ran.txt','yes')"],
  purpose: "test" as const,
  timeoutMs: 1000,
};
const sandbox = {
  mode: "auto" as const,
  network: "deny" as const,
  pentestNetwork: "deny" as const,
};
const selectedBackend = () => "/usr/bin/bwrap";

test("real internal directories are isolated and missing optional directories are allowed", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-team-safe-paths-"));
  try {
    await mkdir(join(cwd, ".pi/team/state"), { recursive: true });
    await mkdir(join(cwd, ".pi/team/agents"));
    assert.deepEqual(validateSandboxInternalPaths(cwd), {
      team: true,
      state: true,
      agents: true,
    });
    const args = bubblewrapArgs(command, cwd, "deny");
    for (const name of ["state", "agents"])
      assert.ok(
        args.some(
          (arg, i) =>
            arg === "--tmpfs" && args[i + 1] === join(cwd, ".pi/team", name),
        ),
      );
    await rm(join(cwd, ".pi/team/state"), { recursive: true });
    await rm(join(cwd, ".pi/team/agents"), { recursive: true });
    assert.deepEqual(validateSandboxInternalPaths(cwd), {
      team: true,
      state: false,
      agents: false,
    });
    assert.ok(bubblewrapArgs(command, cwd, "deny").includes("--ro-bind"));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

for (const [name, makeUnsafe, relativePath] of [
  [
    ".pi symlink",
    async (cwd: string) => {
      await mkdir(join(cwd, "real-pi/team"), { recursive: true });
      await symlink(join(cwd, "real-pi"), join(cwd, ".pi"), "dir");
    },
    ".pi",
  ],
  [
    "team symlink",
    async (cwd: string) => {
      await mkdir(join(cwd, ".pi"));
      await mkdir(join(cwd, "real-team"));
      await symlink(join(cwd, "real-team"), join(cwd, ".pi/team"), "dir");
    },
    ".pi/team",
  ],
  [
    "state relative symlink",
    async (cwd: string) => {
      await mkdir(join(cwd, ".pi/team"), { recursive: true });
      await mkdir(join(cwd, "other"));
      await symlink("../../other", join(cwd, ".pi/team/state"), "dir");
    },
    ".pi/team/state",
  ],
  [
    "agents external symlink",
    async (cwd: string) => {
      await mkdir(join(cwd, ".pi/team"), { recursive: true });
      await symlink(tmpdir(), join(cwd, ".pi/team/agents"), "dir");
    },
    ".pi/team/agents",
  ],
  [
    "state regular file",
    async (cwd: string) => {
      await mkdir(join(cwd, ".pi/team"), { recursive: true });
      await writeFile(join(cwd, ".pi/team/state"), "unsafe");
    },
    ".pi/team/state",
  ],
  [
    "team regular file",
    async (cwd: string) => {
      await mkdir(join(cwd, ".pi"));
      await writeFile(join(cwd, ".pi/team"), "unsafe");
    },
    ".pi/team",
  ],
  [
    ".pi regular file",
    async (cwd: string) => {
      await writeFile(join(cwd, ".pi"), "unsafe");
    },
    ".pi",
  ],
] as const) {
  test(`${name} fails Bubblewrap setup without an auto downgrade`, async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-team-unsafe-path-"));
    try {
      await makeUnsafe(cwd);
      await assert.rejects(
        prepareExecution(command, cwd, sandbox, selectedBackend),
        (error: unknown) => {
          assert.ok(error instanceof SandboxSetupError);
          assert.equal(error.reason, "unsafe_internal_path");
          assert.equal(error.path, relativePath);
          assert.equal(error.code, "SANDBOX_SETUP_FAILED");
          const diagnostics = serializeErrorDiagnostics(error);
          assert.deepEqual(
            {
              sandboxMode: diagnostics.sandboxMode,
              sandboxSetup: diagnostics.sandboxSetup,
              reason: diagnostics.reason,
              path: diagnostics.path,
            },
            {
              sandboxMode: "bubblewrap",
              sandboxSetup: "failed",
              reason: "unsafe_internal_path",
              path: relativePath,
            },
          );
          assert.equal(JSON.stringify(diagnostics).includes(cwd), false);
          return true;
        },
      );
      await assert.rejects(stat(join(cwd, "ran.txt")), { code: "ENOENT" });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
}

test("required distinguishes unsafe structure from unavailable backend", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-team-required-path-"));
  try {
    await mkdir(join(cwd, ".pi"));
    await writeFile(join(cwd, ".pi/team"), "unsafe");
    await assert.rejects(
      prepareExecution(
        command,
        cwd,
        { ...sandbox, mode: "required" },
        selectedBackend,
      ),
      SandboxSetupError,
    );
    await assert.rejects(
      prepareExecution(
        command,
        cwd,
        { ...sandbox, mode: "required" },
        () => undefined,
      ),
      SandboxUnavailableError,
    );
    const host = await prepareExecution(
      command,
      cwd,
      { ...sandbox, mode: "none" },
      selectedBackend,
    );
    assert.equal(host.sandbox.mode, "none");
    await host.cleanup();
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("auto retains constrained-host fallback when the backend is unavailable", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-team-unavailable-path-"));
  try {
    await mkdir(join(cwd, ".pi/team"), { recursive: true });
    const prepared = await prepareExecution(
      command,
      cwd,
      sandbox,
      () => undefined,
    );
    assert.equal(prepared.sandbox.mode, "constrained-host");
    await prepared.cleanup();
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
