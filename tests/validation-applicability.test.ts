import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { discoverCommands } from "../src/agents/discovery.ts";
import { PiRunner } from "../src/agents/runner.ts";
import { persistedTestSchema } from "../src/agents/schemas.ts";
import { baseline } from "../src/workflow/git.ts";
import { newState, stateSchema } from "../src/workflow/state.ts";
import { renderProgress } from "../src/ui/progress.ts";
import {
  classifyValidationScriptContext,
  validationApplicability,
} from "../src/workflow/validation-applicability.ts";
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
  composerScripts?: Record<string, string | string[]>;
  packageScripts?: Record<string, string>;
  runtimeView?: string;
}) {
  const cwd = await repository();
  await writeFile(
    join(cwd, "package.json"),
    JSON.stringify({
      scripts: {
        build: options.script ?? "vite build",
        ...options.packageScripts,
      },
    }),
  );
  if (options.laravel) {
    await writeFile(
      join(cwd, "composer.json"),
      JSON.stringify({
        require: { "laravel/framework": "^13" },
        scripts: options.composerScripts,
      }),
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
  if (options.runtimeView) {
    await mkdir(join(cwd, "routes"), { recursive: true });
    await writeFile(
      join(cwd, "routes", "web.php"),
      `<?php\nRoute::view('/', '${options.runtimeView}');\n`,
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
  assert.match(policy.explanation, /server-rendered files/i);
  assert.ok(policy.evidence.length >= 2);
});

test("HAPAK-like API localization ignores setup-only Vite scaffold evidence", async () => {
  const { cwd, state } = await project({
    laravel: true,
    composerScripts: {
      setup: [
        "composer install",
        "@php artisan migrate --force",
        "npm install --ignore-scripts",
        "npm run build",
      ],
    },
    contractText:
      "Implement API localization; no frontend build is required for this task",
    files: [
      "app/Models/User.php",
      "app/Models/UserSetting.php",
      "app/Http/Middleware/SetUserLocale.php",
      "database/migrations/2026_10_28_create_user_settings.php",
      "lang/de/messages.php",
      "resources/views/mail/verification.blade.php",
      "resources/views/mail/password_reset.blade.php",
      "tests/Unit/UserSettingLanguageSwitchTest.php",
    ],
  });
  for (const [path, content] of [
    [
      "vite.config.js",
      "export default { input: ['resources/css/app.css', 'resources/js/app.js'] };\n",
    ],
    ["resources/css/app.css", "@import 'tailwindcss';\n"],
    ["resources/js/app.js", "// scaffold\n"],
    [
      "resources/views/welcome.blade.php",
      "@vite(['resources/css/app.css', 'resources/js/app.js'])\n",
    ],
    [
      "resources/views/mail/verification.blade.php",
      "{{ __('messages.mail.verification.subject') }}\n",
    ],
    [
      "resources/views/mail/password_reset.blade.php",
      "@lang('messages.mail.password_reset')\n",
    ],
  ] as const) {
    await mkdir(join(cwd, path, ".."), { recursive: true });
    await writeFile(join(cwd, path), content);
  }
  state.discoveredCommands = await discoverCommands(cwd);
  const policy = buildPolicy(await validationApplicability(state));
  assert.equal(policy.status, "NOT_APPLICABLE");
  assert.equal(policy.reasonCode, "NO_FRONTEND_BUILD_REQUIREMENT");
  assert.match(policy.explanation, /backend or server-rendered files/i);
  assert.ok(
    policy.evidence.some(
      (item) =>
        item.reference === "composer.json scripts.setup" &&
        /does not establish a Tester quality gate/i.test(item.detail ?? ""),
    ),
  );
  assert.ok(
    policy.evidence.some(
      (item) => item.reference === "resources/views/welcome.blade.php",
    ),
  );
});

test("script contexts are structural and preserve setup, quality, deployment, transitive, and unknown intent", async () => {
  assert.deepEqual(
    ["setup", "dev", "build", "test", "ci", "deploy", "assets-ready"].map(
      classifyValidationScriptContext,
    ),
    ["SETUP", "DEVELOPMENT", "BUILD", "TEST", "CI", "DEPLOYMENT", "UNKNOWN"],
  );

  const setup = await project({
    laravel: true,
    composerScripts: { setup: "npm run build" },
  });
  assert.equal(
    buildPolicy(await validationApplicability(setup.state)).status,
    "NOT_APPLICABLE",
  );

  const testScript = await project({
    laravel: true,
    composerScripts: { test: "npm run build" },
  });
  assert.equal(
    buildPolicy(await validationApplicability(testScript.state)).reasonCode,
    "VERIFIED_QUALITY_SCRIPT_REQUIREMENT",
  );

  const configured = await project({
    laravel: true,
    composerScripts: { check: "npm run build" },
  });
  const configuredBuild = configured.state.discoveredCommands.find(
    (item) => item.category === "build",
  )!.command;
  configured.state.config.commands = [configuredBuild];
  assert.equal(
    (await validationApplicability(configured.state))[0].reasonCode,
    "EXPLICIT_WORKFLOW_CONFIGURATION",
  );

  const deployment = await project({
    laravel: true,
    composerScripts: { deploy: "npm run build" },
  });
  assert.equal(
    buildPolicy(await validationApplicability(deployment.state)).reasonCode,
    "UNRESOLVED_DEPLOYMENT_BUILD_REQUIREMENT",
  );

  const transitive = await project({
    laravel: true,
    composerScripts: { setup: "@build", build: "npm run build" },
  });
  const transitivePolicy = buildPolicy(
    await validationApplicability(transitive.state),
  );
  assert.equal(transitivePolicy.status, "NOT_APPLICABLE");
  assert.match(
    transitivePolicy.evidence.find(
      (item) => item.reference === "composer.json scripts.setup",
    )?.detail ?? "",
    /transitively/i,
  );

  const unknown = await project({
    laravel: true,
    composerScripts: { "assets-ready": "npm run build" },
  });
  assert.equal(
    buildPolicy(await validationApplicability(unknown.state)).reasonCode,
    "UNKNOWN_SCRIPT_BUILD_CONTEXT",
  );
});

test("Laravel runtime asset use makes Vite required", async () => {
  const { state } = await project({
    laravel: true,
    view: "<html><head>@vite(['resources/css/app.css'])</head></html>\n",
    runtimeView: "app",
  });
  assert.equal(
    buildPolicy(await validationApplicability(state)).status,
    "REQUIRED",
  );
});

test("Blade localization is server-side while verified, unresolved, and incidental asset consumers remain distinct", async () => {
  for (const view of [
    "{{ __('messages.mail.subject') }}\n",
    "@lang('messages.mail.greeting')\n",
    "<html>{{ __('messages.mail.subject') }}</html>\n",
  ]) {
    const localized = await project({ laravel: true, view });
    assert.equal(
      buildPolicy(await validationApplicability(localized.state)).status,
      "NOT_APPLICABLE",
    );
  }

  const compiled = await project({
    laravel: true,
    view: "<script src=\"{{ asset('build/app.js') }}\"></script>\n",
    runtimeView: "app",
  });
  assert.equal(
    buildPolicy(await validationApplicability(compiled.state)).reasonCode,
    "VERIFIED_RUNTIME_ASSET_DEPENDENCY",
  );

  const unresolved = await project({
    laravel: true,
    view: "@vite(['resources/css/app.css'])\n",
  });
  assert.equal(
    buildPolicy(await validationApplicability(unresolved.state)).reasonCode,
    "UNRESOLVED_RUNTIME_ASSET_DEPENDENCY",
  );

  const welcome = await project({ laravel: true });
  await mkdir(join(welcome.cwd, "resources", "views"), { recursive: true });
  await writeFile(
    join(welcome.cwd, "resources", "views", "welcome.blade.php"),
    "@vite(['resources/css/app.css'])\n",
  );
  assert.equal(
    buildPolicy(await validationApplicability(welcome.state)).status,
    "NOT_APPLICABLE",
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
    view: "<html><head>@vite(['resources/js/localization.ts'])</head></html>\n",
    runtimeView: "app",
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

  const negated = await project({
    laravel: true,
    contractText: "Do not run npm run build; no frontend build is required",
  });
  assert.equal(
    buildPolicy(await validationApplicability(negated.state)).status,
    "NOT_APPLICABLE",
  );

  const conflict = await project({
    laravel: true,
    ci: true,
    composerScripts: { setup: "npm run build" },
    contractText: "No frontend build is required by the task scope",
  });
  assert.equal(
    buildPolicy(await validationApplicability(conflict.state)).reasonCode,
    "EXPLICIT_CI_REQUIREMENT",
  );

  negated.state.results.reviewer = {
    ...(negated.state.results.reviewer as typeof contract),
    goal: "Implement API localization",
    technicalDecisions: [
      "The existing composer setup script invokes npm run build during environment initialization",
    ],
  };
  assert.equal(
    buildPolicy(await validationApplicability(negated.state)).status,
    "NOT_APPLICABLE",
  );
});

test("an undecidable generic build remains ambiguous instead of being skipped", async () => {
  const { state } = await project({});
  const policy = buildPolicy(await validationApplicability(state));
  assert.equal(policy.status, "AMBIGUOUS");
  assert.match(policy.explanation, /no decisive quality-gate requirement/i);
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

test("every applicability status has deterministic structured provenance", async () => {
  const required = await project({ ci: true });
  const notApplicable = await project({ laravel: true });
  const ambiguous = await project({});
  const optional = await project({
    laravel: true,
    packageScripts: { lint: "eslint ." },
  });
  const policies = [
    buildPolicy(await validationApplicability(required.state)),
    buildPolicy(await validationApplicability(notApplicable.state)),
    buildPolicy(await validationApplicability(ambiguous.state)),
    (await validationApplicability(optional.state)).find(
      (candidate) => candidate.category === "lint",
    )!,
  ];
  assert.deepEqual(
    policies.map((policy) => policy.status),
    ["REQUIRED", "NOT_APPLICABLE", "AMBIGUOUS", "OPTIONAL"],
  );
  for (const policy of policies) {
    assert.match(policy.reasonCode, /^[A-Z][A-Z0-9_]+$/);
    assert.ok(policy.explanation.length > 10);
    assert.ok(policy.evidence.length > 0);
    assert.ok(policy.evidence.every((item) => item.source.length > 0));
  }
});

test("Tester results, history, state recovery, and team status retain applicability provenance", async () => {
  const { state } = await project({ laravel: true });
  state.results.reviewer = {
    ...(state.results.reviewer as typeof contract),
    requiredTests: [],
  };
  const command = {
    id: "required-diagnostic",
    executable: process.execPath,
    args: ["-e", "process.exit(0)"],
    purpose: "test" as const,
    timeoutMs: 1000,
  };
  state.config.commands = [command];
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
  assert.equal(result.status, "PASS", result.reason);
  const build = result.validationOutcomes.find(
    (outcome: any) => outcome.validationType === "BUILD",
  );
  assert.equal(build.applicability, "NOT_APPLICABLE");
  assert.equal(build.applicabilityReasonCode, "NO_FRONTEND_BUILD_REQUIREMENT");
  assert.match(build.applicabilityExplanation, /server-rendered files/i);
  assert.ok(build.applicabilityEvidence.length > 0);
  assert.ok(
    state.history.some(
      (entry) =>
        entry.event === "validation_applicability_decided" &&
        entry.meta?.applicabilityReasonCode === "NO_FRONTEND_BUILD_REQUIREMENT",
    ),
  );

  state.results.tester = result;
  const recovered = stateSchema.parse(JSON.parse(JSON.stringify(state)));
  assert.equal(
    recovered.results.tester?.validationOutcomes?.find(
      (outcome) => outcome.validationType === "BUILD",
    )?.applicabilityReasonCode,
    "NO_FRONTEND_BUILD_REQUIREMENT",
  );
  const status = renderProgress(recovered, undefined, true).join("\n");
  assert.match(status, /Build applicability: NOT_APPLICABLE/);
  assert.match(status, /Reason: .*server-rendered files/i);

  assert.doesNotThrow(() =>
    persistedTestSchema.parse({
      status: "PASS",
      commands: [],
      failedAreas: [],
      validationOutcomes: [
        {
          id: "legacy-build",
          validationType: "BUILD",
          validator: "VITE",
          validatorSource: "package_script",
          outcome: "PASS",
          reason: "Historical result without applicability provenance",
          recoverable: false,
          applicability: "REQUIRED",
        },
      ],
    }),
  );
});
