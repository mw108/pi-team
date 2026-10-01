import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { realpathSync } from "node:fs";
import {
  createAgentSession,
  DefaultResourceLoader,
  SettingsManager,
  SessionManager,
  ModelRuntime,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import YAML from "yaml";
import { loadConfig, agentDir } from "../src/config/loader.ts";
import { StateStore } from "../src/workflow/persistence.ts";
import {
  repository,
  disposeSerenaTestRuntime,
  isolateSerenaTestHome,
} from "../tests/helpers.ts";
import { packagePath } from "../src/integrations/resources.ts";
const resume = process.argv[2];
const cwd = resume ? realpathSync(resume) : realpathSync(await repository());
const serenaHome = resume ? undefined : await isolateSerenaTestHome();
let session: AgentSession | undefined;
try {
  const { config } = await loadConfig(process.cwd());
  config.commands = [
    {
      id: "test",
      executable: process.execPath,
      args: ["--test", "tests/math.test.mjs"],
      purpose: "test",
      timeoutMs: 120000,
    },
  ];
  // Enable the optional security gates in the live acceptance run.
  config.qualityGates.pentest.enabled = true;
  await mkdir(join(cwd, ".pi", "team"), { recursive: true });
  await writeFile(
    join(cwd, ".pi", "team", "team.yaml"),
    YAML.stringify(config),
  );
  const runtime = await ModelRuntime.create({
    authPath: `${agentDir()}/auth.json`,
    modelsPath: `${agentDir()}/models.json`,
  });
  const model = runtime.getModel(
    config.agents.orchestrator.provider,
    config.agents.orchestrator.model,
  );
  if (!model) throw new Error("Model missing");
  const settings = SettingsManager.inMemory({
    packages: [],
    extensions: [],
    retry: { enabled: false },
    cacheWarming: "off",
  });
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: agentDir(),
    settingsManager: settings,
    noExtensions: true,
    noSkills: true,
    noThemes: true,
    noPromptTemplates: true,
    additionalExtensionPaths: [
      join(process.cwd(), "src/index.ts"),
      packagePath("@bacnh85/pi-serena", "extensions/index.ts"),
    ],
  });
  await loader.reload();
  if (loader.getExtensions().errors.length)
    throw new Error(JSON.stringify(loader.getExtensions().errors));
  ({ session } = await createAgentSession({
    cwd,
    modelRuntime: runtime,
    model,
    settingsManager: settings,
    sessionManager: SessionManager.inMemory(cwd),
    resourceLoader: loader,
    tools: [],
  }));
  await session.bindExtensions({
    mode: "print",
    uiContext: {
      setWidget: (_key: string, lines: any) => {
        if (Array.isArray(lines)) console.log(lines[0]);
      },
      setStatus: () => {},
      notify: (message: string) => console.log(message),
    } as any,
  });
  console.log(`Live /team fixture: ${cwd}`);
  await session.prompt(
    resume
      ? "/team resume"
      : "/team Fix the add(a, b) function in math.js: it currently subtracts. Make it return a+b. Keep the existing test and API unchanged. Run the configured test command. Review, test and commit the correction. There are no additional requirements or external library dependencies.",
  );
  const state = await new StateStore(cwd).latest();
  if (!state) throw new Error("Command did not create workflow state");
  const report = {
    at: new Date().toISOString(),
    repository: cwd,
    phase: state.phase,
    model: model.id,
    workflowId: state.id,
    commit: state.commit,
    qualityGates: {
      codeReview: (state.results.codeReviewer as any)?.status,
      securityReview: state.results.securityReviewer,
      testing: state.results.tester,
    },
    blocker: state.blocker,
    history: state.history,
  };
  await mkdir("docs", { recursive: true });
  await writeFile(
    "docs/live-validation.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(
    JSON.stringify(
      { phase: state.phase, commit: state.commit, blocker: state.blocker },
      null,
      2,
    ),
  );
  if (state.phase !== "DONE") process.exitCode = 1;
} finally {
  try {
    if (resume) {
      try {
        await session?.extensionRunner.emit({
          type: "session_shutdown",
          reason: "quit",
        });
      } finally {
        session?.dispose();
      }
    } else {
      await disposeSerenaTestRuntime(cwd, session);
    }
  } finally {
    await serenaHome?.dispose();
  }
}
