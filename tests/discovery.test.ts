import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile, readFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import { discoverCommands, effectiveConfig } from "../src/agents/discovery.ts";
import { execute, commandTool } from "../src/agents/commands.ts";
import { commandSchema } from "../src/config/schema.ts";
import { WorkflowEngine } from "../src/workflow/engine.ts";
import { repository, config, FixtureRunner } from "./helpers.ts";
const ui = { progress: () => {}, ask: async () => undefined };
async function discoveredFixture() {
  const cwd = await repository();
  await writeFile(
    join(cwd, "package.json"),
    JSON.stringify({
      type: "module",
      scripts: {
        test: "node --test tests/math.test.mjs",
        lint: 'node -e "console.log(123)"',
        build: 'node -e "console.log(456)"',
        dev: "node server.js",
        format: "prettier --write .",
      },
    }),
  );
  return cwd;
}
test("package commands discovered deterministically with source and purpose", async () => {
  const commands = await discoverCommands(await discoveredFixture());
  assert.deepEqual(
    commands.map((c) => c.category),
    ["test", "lint", "build"],
  );
  assert.deepEqual(commands[0].command.args, ["test"]);
  assert.match(commands[0].source, /package.json/);
});
test("Composer scripts and PHPUnit discovery", async () => {
  const cwd = await repository();
  await writeFile(
    join(cwd, "composer.json"),
    JSON.stringify({
      scripts: { test: ["phpunit"], lint: "phpstan", build: "build" },
    }),
  );
  await writeFile(join(cwd, "phpunit.xml"), "<phpunit/>");
  const commands = await discoverCommands(cwd);
  assert.ok(
    commands.some(
      (c) =>
        c.command.executable === "composer" &&
        c.command.args.join(" ") === "run test",
    ),
  );
  assert.ok(
    commands.some((c) => c.command.executable === "vendor/bin/phpunit"),
  );
});
test("duplicate command sources deduplicated and malformed data ignored", async () => {
  const cwd = await discoveredFixture();
  await writeFile(
    join(cwd, "README.md"),
    "npm test\nnpm test\nnpm run lint\nnpm test && touch owned\n",
  );
  await writeFile(join(cwd, "composer.json"), "{broken");
  await writeFile(join(cwd, "Taskfile.yml"), "[broken");
  const commands = await discoverCommands(cwd);
  assert.equal(commands.length, 3);
  assert.ok(!commands.some((c) => c.command.executable === "touch"));
});
test("workflow discovers commands without a startup approval or implicit trust", async () => {
  const cwd = await discoveredFixture();
  const cfg = config();
  cfg.commands = [];
  const runner = new FixtureRunner();
  const requests: string[] = [];
  const engine = new WorkflowEngine(cwd, runner, {
    ...ui,
    approve: async (request) => {
      requests.push(request.kind);
      return undefined;
    },
  });
  const s = await engine.start("Fix", cfg);
  await engine.run(s);
  assert.equal(s.phase, "BLOCKED");
  assert.ok(
    s.discoveredCommands.some((item) => item.source.includes("package.json")),
  );
  assert.equal(s.approvedCommands.length, 0);
  assert.deepEqual(requests, []);
  assert.ok(
    !s.history.some(
      (entry) =>
        entry.event === "approval_requested" && entry.detail === "commands",
    ),
  );
  assert.ok((runner.counts.orchestrator ?? 0) >= 1);
  assert.ok((runner.counts.implementor ?? 0) >= 1);
  await assert.rejects(
    () =>
      commandTool("tester", effectiveConfig(s), cwd, []).execute(
        "x",
        { id: s.discoveredCommands[0].command.id },
        undefined,
        undefined,
        {} as any,
      ),
    /not approved/,
  );
});
test("legacy startup command approval resumes without prompting and retains exact approvals", async () => {
  const cwd = await discoveredFixture();
  const requests: string[] = [];
  const engine = new WorkflowEngine(cwd, new FixtureRunner(), {
    ...ui,
    approve: async (request) => {
      requests.push(request.kind);
      return undefined;
    },
  });
  const s = await engine.start("Fix", config());
  s.discoveredCommands = await discoverCommands(cwd);
  s.approvedCommands = [s.discoveredCommands[0].command];
  s.phase = "WAITING_USER";
  s.resumePhase = "RESEARCH";
  s.pendingApproval = {
    kind: "commands",
    title: "Approve repository validation commands",
    prompt: "Legacy request",
    options: [],
  };
  await engine.store.save(s);
  await engine.run(s);
  assert.equal(s.phase, "DONE", s.blocker);
  assert.deepEqual(requests, []);
  assert.equal(s.approvedCommands.length, 1);
  assert.equal(s.pendingApproval, undefined);
});
test("missing discovered commands do not block Tester runtime approval", async () => {
  const cwd = await repository(),
    cfg = config();
  cfg.commands = [];
  const runner = new FixtureRunner(),
    engine = new WorkflowEngine(cwd, runner, ui),
    s = await engine.start("Fix", cfg);
  await engine.run(s);
  assert.ok((runner.counts.implementor ?? 0) >= 1);
  assert.ok((runner.counts.tester ?? 0) >= 1);
});
test("persisted approved/configured ID collisions fail closed", async () => {
  const cwd = await discoveredFixture(),
    cfg = config();
  const candidate = (await discoverCommands(cwd))[0];
  cfg.commands[0].id = candidate.command.id;
  const engine = new WorkflowEngine(cwd, new FixtureRunner(), {
      ...ui,
    }),
    s = await engine.start("Fix", cfg);
  s.discoveredCommands = [candidate];
  s.approvedCommands = [candidate.command];
  await engine.run(s);
  assert.equal(s.phase, "BLOCKED");
  assert.match(s.blocker ?? "", /command ID conflicts/);
});
test("argv executes literal metacharacters without shell interpolation", async () => {
  const cwd = await repository();
  const value = "$(touch shell-owned); `touch shell-owned` && literal";
  const result = await execute(
    {
      id: "literal",
      executable: process.execPath,
      args: ["-e", "console.log(process.argv[1])", value],
      purpose: "test",
      timeoutMs: 1000,
    },
    cwd,
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout?.trim(), value);
  await assert.rejects(() => readFile(join(cwd, "shell-owned")));
  for (const args of [
    ["test", "&&", "evil"],
    ["test", "\n"],
  ])
    assert.equal(
      commandSchema.safeParse({
        id: "bad",
        executable: "npm",
        args,
        purpose: "test",
      }).success,
      false,
    );
});
test("command evidence reports stderr and timeout from real execution", async () => {
  const cwd = await repository();
  const evidence = await execute(
    {
      id: "timeout",
      executable: process.execPath,
      args: ["-e", 'console.error("diagnostic");setTimeout(()=>{},1000)'],
      purpose: "test",
      timeoutMs: 100,
    },
    cwd,
  );
  assert.equal(evidence.timedOut, true);
  assert.notEqual(evidence.exitCode, 0);
  assert.match(evidence.stderr ?? "", /diagnostic/);
});

test("discovery ignores oversized metadata and symlinks escaping the repository", async () => {
  const cwd = await repository();
  await writeFile(join(cwd, "package.json"), " ".repeat(262145));
  assert.deepEqual(await discoverCommands(cwd), []);
  await symlink("/etc", join(cwd, "outside"));
  await symlink("/etc/passwd", join(cwd, "composer.json"));
  assert.deepEqual(await discoverCommands(cwd), []);
});
test("Cargo, Go, pytest, Make, just and Taskfile candidates have concrete argv", async () => {
  const cwd = await repository();
  await writeFile(join(cwd, "Cargo.toml"), '[package]\nname = "fixture"\n');
  await writeFile(join(cwd, "go.mod"), "module example.invalid/fixture\n");
  await writeFile(join(cwd, "pyproject.toml"), "[tool.pytest.ini_options]\n");
  await writeFile(join(cwd, "Makefile"), "test:\n\techo test\n");
  await writeFile(join(cwd, "justfile"), "lint:\n echo lint\n");
  await writeFile(
    join(cwd, "Taskfile.yml"),
    'version: "3"\ntasks:\n  build:\n    cmds: [echo build]\n',
  );
  const commands = await discoverCommands(cwd);
  for (const executable of ["cargo", "go", "python3", "make", "just", "task"])
    assert.ok(
      commands.some((candidate) => candidate.command.executable === executable),
      executable,
    );
  assert.deepEqual(
    commands.find((candidate) => candidate.command.executable === "go")?.command
      .args,
    ["test", "./..."],
  );
});
