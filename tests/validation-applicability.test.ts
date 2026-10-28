import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { discoverCommands } from "../src/agents/discovery.ts";
import { PiRunner } from "../src/agents/runner.ts";
import { baseline } from "../src/workflow/git.ts";
import { newState } from "../src/workflow/state.ts";
import { validationApplicability } from "../src/workflow/validation-applicability.ts";
import { recordVerifiedCommandResult } from "../src/workflow/verified-commands.ts";
import { config, contract, repository } from "./helpers.ts";

async function project(options: {
  script?: string;
  laravel?: boolean;
  angular?: boolean;
  tsconfig?: boolean;
  view?: string;
  files?: string[];
  contractText?: string;
  ci?: boolean;
}) {
  const cwd = await repository();
  await writeFile(
    join(cwd, "package.json"),
    JSON.stringify({ scripts: { build: options.script ?? "vite build" } }),
  );
  if (options.laravel) {
    await writeFile(
      join(cwd, "composer.json"),
      JSON.stringify({ require: { "laravel/framework": "^13" } }),
    );
    await writeFile(join(cwd, "artisan"), "<?php\n");
  }
  if (options.angular) await writeFile(join(cwd, "angular.json"), "{}\n");
  if (options.tsconfig) await writeFile(join(cwd, "tsconfig.json"), "{}\n");
  if (options.view) {
    await mkdir(join(cwd, "resources", "views"), { recursive: true });
    await writeFile(
      join(cwd, "resources", "views", "app.blade.php"),
      options.view,
    );
  }
  if (options.ci) {
    await mkdir(join(cwd, ".github", "workflows"), { recursive: true });
    await writeFile(
      join(cwd, ".github", "workflows", "ci.yml"),
      "steps:\n  - run: npm run build\n",
    );
  }
  const state = newState(cwd, "build policy", config(), await baseline(cwd));
  state.config.commands = [];
  state.results.reviewer = {
    ...contract,
    goal: options.contractText ?? contract.goal,
    filesToModify: options.files ?? ["app/Service.php"],
  };
  state.discoveredCommands = await discoverCommands(cwd);
  return { cwd, state };
}

function buildPolicy(
  values: Awaited<ReturnType<typeof validationApplicability>>,
) {
  const value = values.find((candidate) => candidate.category === "build");
  assert.ok(value, "build command was not discovered");
  return value;
}

test("unused Laravel Vite scaffold is not applicable, even when execution was approved", async () => {
  const { state } = await project({
    laravel: true,
    files: ["app/Http/Controllers/LocaleController.php"],
    contractText: "Implement API localization behavior",
  });
  const build = state.discoveredCommands.find(
    (item) => item.category === "build",
  );
  assert.ok(build);
  state.approvedCommands = [build.command];
  const policy = buildPolicy(await validationApplicability(state));
  assert.equal(policy.status, "NOT_APPLICABLE");
  assert.match(policy.reason, /does not connect frontend asset compilation/i);
  assert.ok(policy.evidence.length >= 2);
});

test("Laravel runtime asset use makes Vite required", async () => {
  const { state } = await project({
    laravel: true,
    view: "<html><head>@vite(['resources/css/app.css'])</head></html>\n",
  });
  assert.equal(
    buildPolicy(await validationApplicability(state)).status,
    "REQUIRED",
  );
});

test("Angular and TypeScript compiler builds are required project gates", async () => {
  const angular = await project({ angular: true, script: "ng build" });
  assert.equal(
    buildPolicy(await validationApplicability(angular.state)).status,
    "REQUIRED",
  );
  const typescript = await project({
    tsconfig: true,
    script: "tsc -p tsconfig.json",
  });
  assert.equal(
    buildPolicy(await validationApplicability(typescript.state)).status,
    "REQUIRED",
  );
});

test("frontend scope, explicit Contract requirements, and exact CI usage require builds", async () => {
  const mixed = await project({
    laravel: true,
    files: ["resources/js/localization.ts"],
  });
  assert.equal(
    buildPolicy(await validationApplicability(mixed.state)).status,
    "REQUIRED",
  );
  const explicit = await project({
    laravel: true,
    contractText: "Run npm run build to verify the localization assets",
  });
  assert.equal(
    buildPolicy(await validationApplicability(explicit.state)).status,
    "REQUIRED",
  );
  const ci = await project({ ci: true });
  assert.equal(
    buildPolicy(await validationApplicability(ci.state)).status,
    "REQUIRED",
  );
});

test("an undecidable generic build remains ambiguous instead of being skipped", async () => {
  const { state } = await project({});
  const policy = buildPolicy(await validationApplicability(state));
  assert.equal(policy.status, "AMBIGUOUS");
  assert.match(policy.reason, /execution approval alone/i);
});

test("an ambiguous build blocks Tester even when another current check passes", async () => {
  const { state } = await project({});
  const command = {
    id: "diagnostic",
    executable: process.execPath,
    args: ["-e", "process.exit(0)"],
    purpose: "test" as const,
    timeoutMs: 1000,
  };
  const verified = await recordVerifiedCommandResult(
    state,
    command,
    {
      id: command.id,
      exitCode: 0,
      output: "pass",
      sandbox: {
        mode: "none",
        network: "host",
        temporaryHome: true,
        filesystemIsolation: false,
      },
    },
    "tester",
    1,
  );
  assert.ok(verified);
  state.verifiedCommandResults.push(verified);
  const runner = new PiRunner();
  runner.createSession = async () =>
    ({
      messages: [],
      prompt: async () => {},
      getLastAssistantText: () =>
        JSON.stringify({ status: "PASS", commands: [], failedAreas: [] }),
      extensionRunner: { emit: async () => {} },
      dispose: () => {},
      abort: async () => {},
    }) as any;
  const result = (await runner.run("tester", state)) as any;
  assert.equal(result.status, "BLOCKED");
  assert.match(result.reason, /applicability is unresolved/i);
});

test("explicit workflow commands remain required independently of discovery", async () => {
  const { state } = await project({ laravel: true });
  const command = state.discoveredCommands.find(
    (item) => item.category === "build",
  )!.command;
  state.config.commands = [command];
  const policy = (await validationApplicability(state)).find(
    (candidate) => candidate.command.id === command.id,
  );
  assert.equal(policy?.discovery, "CONFIGURED");
  assert.equal(policy?.status, "REQUIRED");
});
