import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commandTool, execute } from "../src/agents/commands.ts";
import {
  ExecutableResolutionError,
  resolveWindowsExecutable,
  windowsBatchCommandLine,
} from "../src/agents/executable-resolution.ts";
import { commandOutcomeForLog } from "../src/agents/command-observability.ts";
import { config, repository } from "./helpers.ts";

test("Windows resolution honors PATH and PATHEXT without implicitly preferring cwd", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-team-resolution-"));
  const cwd = join(root, "work");
  const bin = join(root, "Program Files", "Composer");
  try {
    await mkdir(cwd, { recursive: true });
    await mkdir(bin, { recursive: true });
    await writeFile(join(cwd, "composer.cmd"), "malicious");
    await writeFile(join(bin, "Composer.CmD"), "trusted");
    const found = await resolveWindowsExecutable("composer", cwd, {
      PATH: bin,
      PATHEXT: ".EXE;.CMD;.BAT;.COM",
    });
    assert.equal(
      found.resolved?.toLowerCase(),
      join(bin, "Composer.CmD").toLowerCase(),
    );
    assert.equal(found.kind, "batch");
    assert.equal(found.source, "path");
    assert.deepEqual(found.searchedExtensions, [
      ".EXE",
      ".CMD",
      ".BAT",
      ".COM",
    ]);
    await assert.rejects(
      resolveWindowsExecutable("only-in-cwd", cwd, {
        PATH: bin,
        PATHEXT: ".CMD",
      }),
      (error: unknown) =>
        error instanceof ExecutableResolutionError &&
        error.code === "EXECUTABLE_NOT_FOUND",
    );
    await writeFile(join(cwd, "only-in-cwd.cmd"), "explicit");
    assert.equal(
      (
        await resolveWindowsExecutable("./only-in-cwd", cwd, {
          PATH: bin,
          PATHEXT: ".CMD",
        })
      ).source,
      "explicit",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("batch command construction preserves ordinary argv and rejects ambiguous cmd syntax", () => {
  const line = windowsBatchCommandLine(
    "C:\\Program Files\\Composer\\composer.cmd",
    ["run", "test suite", "apostrophe's-safe"],
  );
  assert.equal(
    line,
    '""C:\\Program Files\\Composer\\composer.cmd" "run" "test suite" "apostrophe\'s-safe""',
  );
  for (const value of ["&", "|", ">", "<", "^", "%PATH%", "!X!", '"'])
    assert.throws(
      () => windowsBatchCommandLine("C:\\safe\\tool.cmd", [value]),
      (error: unknown) =>
        error instanceof ExecutableResolutionError &&
        error.code === "UNSAFE_BATCH_ARGUMENT",
    );
});

test(
  "real Windows batch launcher resolves through PATHEXT, preserves spaces, and captures nonzero exits",
  { skip: process.platform !== "win32", concurrency: false },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-team batch space "));
    const oldPath = process.env.PATH;
    const oldPathExt = process.env.PATHEXT;
    try {
      await writeFile(
        join(root, "composer.cmd"),
        '@echo off\r\necho [%~1][%~2][%~3]\r\nif "%~1"=="fail" exit /b 7\r\n',
      );
      process.env.PATH = `${root};${oldPath ?? ""}`;
      process.env.PATHEXT = ".EXE;.CMD;.BAT;.COM";
      const passed = await execute(
        {
          id: "composer-pass",
          executable: "composer",
          args: ["run", "test suite", "apostrophe's-safe"],
          purpose: "test",
          timeoutMs: 5000,
        },
        root,
      );
      assert.equal(passed.exitCode, 0);
      assert.match(
        passed.stdout ?? "",
        /\[run\]\[test suite\]\[apostrophe's-safe\]/,
      );
      assert.equal(passed.resolution?.kind, "batch");
      assert.match(passed.resolvedExecutable ?? "", /composer\.cmd$/i);
      const failed = await execute(
        {
          id: "composer-fail",
          executable: "composer",
          args: ["fail"],
          purpose: "test",
          timeoutMs: 5000,
        },
        root,
      );
      assert.equal(failed.processStarted, true);
      assert.equal(failed.exitCode, 7);
      assert.equal(
        commandOutcomeForLog({ details: failed }, false).error?.code,
        "NONZERO_EXIT",
      );
    } finally {
      if (oldPath === undefined) delete process.env.PATH;
      else process.env.PATH = oldPath;
      if (oldPathExt === undefined) delete process.env.PATHEXT;
      else process.env.PATHEXT = oldPathExt;
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("ENOENT tool result is actionable, unverified, and keeps fallback authorization separate", async () => {
  const cwd = await repository();
  const cfg = config();
  cfg.commands = [
    {
      id: "missing",
      executable: "definitely-missing-pi-team-command",
      args: ["test"],
      purpose: "test",
      timeoutMs: 1000,
    },
  ];
  const fallback = {
    id: "fallback",
    executable: process.execPath,
    args: ["-e", "process.exit(0)"],
    purpose: "test" as const,
    timeoutMs: 1000,
  };
  const evidence: any[] = [];
  const tool = commandTool(
    "tester",
    cfg,
    cwd,
    evidence,
    async () => "deny",
    undefined,
    undefined,
    undefined,
    async () => [
      {
        command: fallback,
        source: "verified:implementor:attempt-1",
        reason: "Previously passed on this repository snapshot",
      },
    ],
  );
  const missing = await tool.execute(
    "missing",
    { id: "missing" },
    undefined,
    undefined,
    {} as any,
  );
  assert.equal((missing.details as any).code, "EXECUTABLE_NOT_FOUND");
  assert.equal((missing.details as any).osError, "ENOENT");
  assert.equal((missing.details as any).processStarted, false);
  assert.equal((missing.details as any).fallbackAvailable, true);
  assert.equal(
    (missing.details as any).suggestedAlternatives[0].executable,
    process.execPath,
  );
  assert.equal(
    (missing.details as any).suggestedAlternatives[0].requiresApproval,
    true,
  );
  assert.deepEqual(evidence, []);
  const denied = await tool.execute(
    "fallback",
    {
      executable: fallback.executable,
      args: fallback.args,
      purpose: "Run fallback tests",
    },
    undefined,
    undefined,
    {} as any,
  );
  assert.equal((denied.details as any).code, "COMMAND_APPROVAL_DENIED");
  assert.deepEqual(evidence, []);
});

test("a missing fallback is not recursively suggested and cannot fabricate Tester evidence", async () => {
  const cwd = await repository();
  const cfg = config();
  const first = {
    id: "missing-first",
    executable: "pi-team-missing-first",
    args: ["test"],
    purpose: "test" as const,
    timeoutMs: 1000,
  };
  const second = {
    id: "missing-second",
    executable: "pi-team-missing-second",
    args: ["test"],
    purpose: "test" as const,
    timeoutMs: 1000,
  };
  cfg.commands = [first, second];
  const evidence: any[] = [];
  const tool = commandTool(
    "tester",
    cfg,
    cwd,
    evidence,
    undefined,
    undefined,
    undefined,
    undefined,
    async (failed) => [
      {
        command: failed.id === first.id ? second : first,
        source: "project fixture",
        reason: "Project test alternative",
      },
    ],
  );
  const a = await tool.execute(
    "first",
    { id: first.id },
    undefined,
    undefined,
    {} as any,
  );
  assert.deepEqual(
    (a.details as any).suggestedAlternatives.map((item: any) => item.commandId),
    [second.id],
  );
  const b = await tool.execute(
    "second",
    { id: second.id },
    undefined,
    undefined,
    {} as any,
  );
  assert.deepEqual((b.details as any).suggestedAlternatives, []);
  assert.equal((b.details as any).fallbackAvailable, false);
  assert.deepEqual(evidence, []);
});
