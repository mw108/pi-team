import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import YAML from "yaml";
import {
  repository,
  FixtureRunner,
  disposeSerenaTestRuntime,
  isolateSerenaTestHome,
} from "../tests/helpers.ts";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../src/config/loader.ts";
import { teamRoot } from "../src/config/project.ts";
import { PiRunner } from "../src/agents/runner.ts";
import { WorkflowEngine } from "../src/workflow/engine.ts";
import { head } from "../src/workflow/git.ts";
const base = await loadConfig(process.cwd());
const cwd = await repository();
const serenaHome = await isolateSerenaTestHome();
let session: AgentSession | undefined;
try {
  const subdir = join(cwd, "src", "module");
  await mkdir(subdir, { recursive: true });
  const target = teamRoot(cwd),
    cfg = YAML.parse(await readFile(join(target, "team.yaml"), "utf8"));
  for (const [slot, definition] of Object.entries(cfg.agents) as [
    string,
    any,
  ][]) {
    definition.provider =
      base.config.agents[slot as keyof typeof base.config.agents].provider;
    definition.model =
      base.config.agents[slot as keyof typeof base.config.agents].model;
    definition.thinking = "off";
  }
  cfg.commands = [
    {
      id: "test",
      executable: process.execPath,
      args: ["--test", "tests/math.test.mjs"],
      purpose: "test",
      timeoutMs: 120000,
    },
  ];
  await writeFile(join(target, "team.yaml"), YAML.stringify(cfg));
  const marker = "Project-specific pragmatic solver " + Date.now();
  await writeFile(join(target, "agents", "solver-pragmatic.md"), marker);
  const definition = await loadConfig(subdir),
    ui = { progress: () => {}, ask: async () => undefined };
  const engine = new WorkflowEngine(subdir, new FixtureRunner(), ui),
    state = await engine.start("Fix arithmetic", definition.config, definition);
  const piRunner = new PiRunner();
  session = await piRunner.createSession("solver2", state);
  const promptUsed =
    session.systemPrompt.includes(marker) &&
    !session.systemPrompt.includes("Prefer the smallest change that satisfies");
  if (!promptUsed)
    throw new Error("PiRunner did not use the project-specific Solver prompt");
  const before = await head(cwd);
  await engine.run(state);
  if (state.phase !== "DONE" || (await head(cwd)) === before)
    throw new Error(
      `Fixture workflow did not complete: ${state.phase} ${state.blocker}`,
    );
  const interruptedController = new AbortController();
  const interruptedEngine = new WorkflowEngine(subdir, new FixtureRunner(), {
    progress: (current) => {
      if (current.phase === "RESEARCH") interruptedController.abort();
    },
    ask: async () => undefined,
  });
  const interrupted = await interruptedEngine.start(
    "Inspect arithmetic after the fix",
    definition.config,
    definition,
  );
  await interruptedEngine.run(interrupted, interruptedController.signal);
  if (interrupted.phase === "DONE" || interrupted.phase === "BLOCKED")
    throw new Error(`Expected interrupted workflow, got ${interrupted.phase}`);
  await writeFile(
    join(target, "agents", "solver-pragmatic.md"),
    marker + " changed",
  );
  const resumed = await interruptedEngine.store.load(interrupted.id);
  const resumeEngine = new WorkflowEngine(subdir, new FixtureRunner(), ui);
  await resumeEngine.run(resumed);
  if (
    resumed.phase !== "WAITING_USER" ||
    resumed.pendingApproval?.kind !== "configDrift"
  )
    throw new Error("Changed project prompt did not pause resume");
  const report = {
    at: new Date().toISOString(),
    repository: cwd,
    projectRoot: engine.cwd,
    subdirectory: subdir,
    initFiles: 13,
    customProjectPromptUsed: promptUsed,
    templatePromptUsed: false,
    workflowPhaseBeforeInterruption: "DONE",
    commit: state.commit?.hash,
    interruptedPhase: interrupted.phase,
    driftDetected: resumed.pendingApproval?.kind,
    changed: resumed.driftCandidate?.changed,
    statePath: resumeEngine.store.path(resumed.id),
    remoteInference: false,
  };
  await writeFile(
    "docs/project-local-validation.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  try {
    await disposeSerenaTestRuntime(cwd, session);
  } finally {
    await serenaHome.dispose();
  }
}
