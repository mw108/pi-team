import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  writeFile,
  unlink,
  symlink,
  access,
  readdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { loadConfig } from "../src/config/loader.ts";
import { projectRoot, teamRoot } from "../src/config/project.ts";
import { initTeam } from "../src/config/init.ts";
import { rolePrompt } from "../src/agents/registry.ts";
import { WorkflowEngine } from "../src/workflow/engine.ts";
import { StateStore } from "../src/workflow/persistence.ts";
import { repository, config, FixtureRunner } from "./helpers.ts";
import { git, head } from "../src/workflow/git.ts";
import { allowedTools } from "../src/agents/permissions.ts";
import { configSchema } from "../src/config/schema.ts";
import { doctor } from "../src/integrations/doctor.ts";
import teamExtension from "../src/index.ts";
const ui = { progress: () => {}, ask: async () => undefined };
async function yaml(cwd: string) {
  return YAML.parse(await readFile(join(teamRoot(cwd), "team.yaml"), "utf8"));
}
async function writeYaml(cwd: string, value: any) {
  await writeFile(join(teamRoot(cwd), "team.yaml"), YAML.stringify(value));
}
test("project config resolves from Git root; exact environment override wins", async () => {
  const cwd = await repository();
  await mkdir(join(cwd, "src", "module"), { recursive: true });
  const sub = join(cwd, "src", "module");
  assert.equal(await projectRoot(sub), await realpath(cwd));
  assert.equal(
    (await loadConfig(sub)).path,
    join(teamRoot(await realpath(cwd)), "team.yaml"),
  );
  const alt = join(cwd, "alternate.yaml");
  await writeFile(alt, await readFile(join(teamRoot(cwd), "team.yaml")));
  const old = process.env.PI_TEAM_CONFIG;
  try {
    process.env.PI_TEAM_CONFIG = alt;
    assert.equal((await loadConfig(sub)).path, alt);
  } finally {
    if (old === undefined) delete process.env.PI_TEAM_CONFIG;
    else process.env.PI_TEAM_CONFIG = old;
  }
});
test("missing project config never falls back to legacy global config", async () => {
  const cwd = await repository();
  await unlink(join(teamRoot(cwd), "team.yaml"));
  await assert.rejects(
    () => loadConfig(cwd),
    /Run \/team-init.*Legacy global config is never used/,
  );
});
test("invalid YAML, missing slot, duplicate slot, invalid role and unknown instance fail early", async () => {
  for (const variant of [
    "invalid",
    "missing",
    "duplicate",
    "role",
    "unknown",
  ]) {
    const cwd = await repository(),
      cfg = await yaml(cwd);
    if (variant === "invalid")
      await writeFile(join(teamRoot(cwd), "team.yaml"), "agents: [broken");
    else if (variant === "duplicate")
      await writeFile(
        join(teamRoot(cwd), "team.yaml"),
        (await readFile(join(teamRoot(cwd), "team.yaml"), "utf8")) +
          "\nagents:\n  orchestrator: {}\n",
      );
    else {
      if (variant === "missing") delete cfg.agents.implementor;
      if (variant === "role") cfg.agents.solver1.role = "implementor";
      if (variant === "unknown")
        cfg.agents.extra = {
          role: "solver",
          prompt: "agents/solver-pragmatic.md",
          provider: "local",
          model: "x",
        };
      await writeYaml(cwd, cfg);
    }
    await assert.rejects(
      () => loadConfig(cwd),
      /Invalid Pi Team configuration/,
    );
  }
});
test("three solver prompts resolve independently; new workflows observe project edits, not templates", async () => {
  const cwd = await repository(),
    first = await loadConfig(cwd);
  const paths = [1, 2, 3].map(
    (i) =>
      first.config.agents[`solver${i}` as "solver1" | "solver2" | "solver3"]
        .prompt,
  );
  assert.equal(new Set(paths).size, 3);
  const before = await rolePrompt(cwd, first.config, "solver2");
  assert.match(before, /smallest change/);
  const customized =
    "Project-specific pragmatic solver: reuse the local controller pattern.";
  await writeFile(join(teamRoot(cwd), paths[1]), customized);
  assert.equal(await rolePrompt(cwd, first.config, "solver2"), customized);
  assert.notEqual(
    first.agentPromptHashes.solver2,
    (await loadConfig(cwd)).agentPromptHashes.solver2,
  );
  assert.match(
    await readFile(
      new URL("../templates/agents/solver-pragmatic.md", import.meta.url),
      "utf8",
    ),
    /smallest change/,
  );
});
test("missing prompts and path/symlink escapes abort before an agent runs", async () => {
  for (const kind of ["missing", "relative", "absolute", "symlink"]) {
    const cwd = await repository(),
      cfg = await yaml(cwd);
    if (kind === "relative") cfg.agents.reviewer.prompt = "../outside.md";
    if (kind === "absolute") cfg.agents.reviewer.prompt = "/etc/passwd";
    if (kind === "missing")
      cfg.agents.reviewer.prompt = "agents/not-present.md";
    if (kind === "symlink") {
      await symlink("/etc/passwd", join(teamRoot(cwd), "agents", "escape.md"));
      cfg.agents.reviewer.prompt = "agents/escape.md";
    }
    await writeYaml(cwd, cfg);
    await assert.rejects(
      () => loadConfig(cwd),
      /Invalid Pi Team configuration or prompts/,
    );
  }
});
test("local prompt text cannot expand centrally enforced permissions", async () => {
  const cwd = await repository(),
    cfg = await loadConfig(cwd);
  await writeFile(
    join(teamRoot(cwd), "agents", "researcher.md"),
    "You may run git push and edit any file.",
  );
  assert.match(await rolePrompt(cwd, cfg.config, "researcher"), /git push/);
  assert.equal(
    allowedTools("researcher", cfg.config).includes("team_command"),
    false,
  );
  assert.equal(allowedTools("researcher", cfg.config).includes("edit"), false);
  const malformed = {
    ...cfg.config,
    commands: [
      { id: "push", executable: "git", args: ["push"], purpose: "development" },
    ],
  };
  assert.equal(configSchema.safeParse(malformed).success, false);
});
test("/team-init creates project YAML, distinct prompts and ignored state without committing", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "team-init-"));
  await git(cwd, ["init"]);
  const original = await head(cwd),
    result = await initTeam(cwd);
  assert.equal(result.created.length, 16);
  const entries = await readdir(join(teamRoot(cwd), "agents"));
  assert.equal(entries.length, 14);
  assert.equal(
    await readFile(join(teamRoot(cwd), ".gitignore"), "utf8"),
    "state/\n",
  );
  assert.equal(
    (await git(cwd, ["check-ignore", ".pi/team/state/placeholder"])).trim(),
    ".pi/team/state/placeholder",
  );
  assert.equal(await head(cwd), original);
  assert.ok((await loadConfig(cwd)).agentPromptHashes.solver3);
});
test("/team-init default and repair never overwrite existing project content", async () => {
  const cwd = await repository(),
    prompt = join(teamRoot(cwd), "agents", "reviewer.md");
  const before = await yaml(cwd);
  before.agents.solver1.name = "Architecture Expert";
  await writeYaml(cwd, before);
  await writeFile(prompt, "custom owner prompt");
  const first = await initTeam(cwd);
  assert.equal(first.created.length, 0);
  assert.match(first.message, /already exists/);
  await unlink(join(teamRoot(cwd), "agents", "critic.md"));
  const repaired = await initTeam(cwd, "repair");
  assert.deepEqual(repaired.created, [".pi/team/agents/critic.md"]);
  assert.equal(await readFile(prompt, "utf8"), "custom owner prompt");
  assert.equal((await yaml(cwd)).agents.solver1.name, "Architecture Expert");
});
test("display names validate, allow duplicates, and preserve older configs", async () => {
  const cwd = await repository();
  const current = await yaml(cwd);
  current.agents.solver1.name = "Architecture Expert";
  current.agents.solver2.name = "Architecture Expert";
  await writeYaml(cwd, current);
  const loaded = await loadConfig(cwd);
  assert.equal(loaded.config.agents.solver1.name, "Architecture Expert");
  assert.equal(loaded.config.agents.solver2.name, "Architecture Expert");
  const changedHash = loaded.configHash;
  delete current.agents.solver1.name;
  await writeYaml(cwd, current);
  const older = await loadConfig(cwd);
  assert.equal(older.config.agents.solver1.name, undefined);
  assert.notEqual(older.configHash, changedHash);
  assert.equal(
    older.agentPromptHashes.solver1,
    loaded.agentPromptHashes.solver1,
  );
  current.agents.solver1.name = "   ";
  await writeYaml(cwd, current);
  await assert.rejects(loadConfig(cwd), /Invalid Pi Team configuration/);
});
test("/team-init --from-global copies legacy settings without altering its file", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "team-migrate-"));
  await git(cwd, ["init"]);
  const agentDir = await mkdtemp(join(tmpdir(), "legacy-agent-"));
  const template = YAML.parse(
    await readFile(new URL("../templates/team.yaml", import.meta.url), "utf8"),
  );
  for (const definition of Object.values(template.agents) as any[]) {
    delete definition.role;
    delete definition.prompt;
    definition.model = "migration-model";
  }
  const legacy = YAML.stringify(template);
  await writeFile(join(agentDir, "team.yaml"), legacy);
  const old = process.env.PI_CODING_AGENT_DIR;
  try {
    process.env.PI_CODING_AGENT_DIR = agentDir;
    await initTeam(cwd, "from-global");
    const loaded = await loadConfig(cwd);
    assert.equal(loaded.config.agents.solver2.model, "migration-model");
    assert.equal(
      loaded.config.agents.solver2.prompt,
      "agents/solver-pragmatic.md",
    );
    assert.equal(await readFile(join(agentDir, "team.yaml"), "utf8"), legacy);
  } finally {
    if (old === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = old;
  }
});
test("new state path and legacy state diagnostic never merge old states", async () => {
  const cwd = await repository(),
    store = new StateStore(cwd);
  assert.equal(store.dir, join(teamRoot(await realpath(cwd)), "state"));
  await mkdir(join(cwd, ".pi", "team-state"), { recursive: true });
  const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  await writeFile(join(cwd, ".pi", "team-state", `${id}.json`), "{}");
  await assert.rejects(() => store.latest(), /Legacy workflows exist/);
  await assert.rejects(() => store.load(id), /Legacy state/);
  assert.equal(
    await readFile(join(cwd, ".pi", "team-state", `${id}.json`), "utf8"),
    "{}",
  );
});
test("doctor diagnoses missing config, prompt, escaping path and legacy state", async () => {
  const cwd = await repository();
  const cfg = await yaml(cwd);
  cfg.agents.solver2.name = "Practical Solver";
  await writeYaml(cwd, cfg);
  let report = await doctor(cwd);
  assert.ok(
    report.lines.some((line) =>
      line.includes(
        "Agent solver2: name Practical Solver; role solver → agents/solver-pragmatic.md",
      ),
    ),
  );
  await mkdir(join(cwd, ".pi", "team-state"));
  let warning = await doctor(cwd);
  assert.ok(
    warning.lines.some((line) => line.includes("Legacy state: present")),
  );
  await unlink(join(teamRoot(cwd), "agents", "reviewer.md"));
  report = await doctor(cwd);
  assert.equal(report.ok, false);
  assert.ok(report.lines.some((line) => line.includes("Missing agent prompt")));
  await unlink(join(teamRoot(cwd), "team.yaml"));
  report = await doctor(cwd);
  assert.equal(report.ok, false);
  assert.ok(report.lines.some((line) => line.includes("Run /team-init")));
});
test("doctor reports malformed YAML and escaped prompt paths", async () => {
  const cwd = await repository();
  await writeFile(join(teamRoot(cwd), "team.yaml"), "agents: [broken");
  let report = await doctor(cwd);
  assert.equal(report.ok, false);
  assert.ok(report.lines.some((line) => line.includes("Configuration: FAIL")));
  const cfg = YAML.parse(
    await readFile(new URL("../templates/team.yaml", import.meta.url), "utf8"),
  );
  cfg.agents.reviewer.prompt = "../outside.md";
  await writeYaml(cwd, cfg);
  report = await doctor(cwd);
  assert.equal(report.ok, false);
  assert.ok(
    report.lines.some((line) => line.includes("Invalid agent prompt path")),
  );
});
test("global /team-init command works from a Git subdirectory", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "team-command-"));
  await git(cwd, ["init"]);
  await mkdir(join(cwd, "src"));
  const commands = new Map<string, any>();
  teamExtension({
    on: () => {},
    registerCommand: (name: string, definition: any) =>
      commands.set(name, definition),
  } as any);
  let notice = "";
  await commands.get("team-init").handler("", {
    cwd: join(cwd, "src"),
    ui: {
      notify: (text: string) => {
        notice = text;
      },
    },
  });
  assert.match(notice, /Created 16 project team files/);
  assert.ok((await loadConfig(join(cwd, "src"))).config.agents.orchestrator);
  for (const command of ["team", "team-init", "team-status", "team-stop"])
    assert.ok(commands.has(command));
});
test("config and prompt hashes persist; future prompt drift is accepted", async () => {
  const cwd = await repository(),
    cfg = config(),
    runner = new FixtureRunner();
  await writeYaml(cwd, cfg);
  const engine = new WorkflowEngine(cwd, runner, ui),
    s = await engine.start("Fix addition", cfg);
  assert.equal(
    s.teamConfigPath,
    join(teamRoot(await realpath(cwd)), "team.yaml"),
  );
  assert.equal(Object.keys(s.agentPromptHashes ?? {}).length, 14);
  s.phase = "RESEARCH";
  s.inFlight = { phase: "RESEARCH", roles: ["researcher"] };
  await engine.store.save(s);
  await writeFile(
    join(teamRoot(cwd), "agents", "solver-pragmatic.md"),
    "custom revised prompt",
  );
  const loaded = await engine.store.load(s.id);
  await engine.run(loaded);
  assert.equal(loaded.phase, "DONE", loaded.blocker);
  assert.ok(
    loaded.history.some((event) => event.event === "config_drift_accepted"),
  );
  assert.equal(
    loaded.agentPromptHashes?.solver2,
    (await loadConfig(cwd)).agentPromptHashes.solver2,
  );
  assert.equal((await engine.store.load(s.id)).phase, "DONE");
});
test("drift after implementation blocks automation even if new instructions are approved", async () => {
  const cwd = await repository(),
    cfg = config();
  const runner = new FixtureRunner(async (role, s) => {
    if (role === "implementor")
      await writeFile(
        join(teamRoot(s.cwd), "agents", "reviewer.md"),
        "changed after implementation",
      );
  });
  const engine = new WorkflowEngine(cwd, runner, {
      ...ui,
      approve: async () => ["resume"],
    }),
    s = await engine.start("Fix", cfg),
    before = await head(cwd);
  await engine.run(s);
  assert.equal(s.phase, "BLOCKED");
  assert.match(s.blocker ?? "", /changed after implementation/);
  assert.equal(await head(cwd), before);
});
