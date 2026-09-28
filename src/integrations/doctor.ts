import {
  DefaultResourceLoader,
  SettingsManager,
  ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import { roles } from "../agents/schemas.ts";
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { agentDir, loadConfig } from "../config/loader.ts";
import { legacyGlobalConfig } from "../config/loader.ts";
import { projectRoot, teamRoot } from "../config/project.ts";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { configSchema } from "../config/schema.ts";
import { localUrl } from "../config/http.ts";
import { discoverCommands } from "../agents/discovery.ts";
import { StateStore } from "../workflow/persistence.ts";
import { git, dirtyPaths } from "../workflow/git.ts";
import { checkAskCompatibility } from "./pi-ask.ts";
import { packagePath } from "./resources.ts";
import { assertTemperatureSupported } from "../agents/sampling.ts";
import { formatAgentTimeout, getAgentTimeoutMs } from "../agents/errors.ts";
export async function doctor(cwd: string) {
  cwd = await projectRoot(cwd);
  const lines: string[] = [
    `OS ${process.platform}/${process.arch}; Node ${process.version}`,
    `Pi Team project root: ${cwd}`,
  ];
  let ok = true;
  const check = async (label: string, run: () => Promise<string>) => {
    try {
      lines.push(`${label}: ${await run()}`);
    } catch (error) {
      ok = false;
      lines.push(`${label}: FAIL — ${String(error)}`);
    }
  };
  await check("pi-ask", async () => {
    const result = await checkAskCompatibility();
    return `${result.version}; compatible ${result.range}; ask_user registration verified`;
  });
  await check(
    "Pi",
    async () =>
      JSON.parse(
        await readFile(
          packagePath("@earendil-works/pi-coding-agent", "package.json"),
          "utf8",
        ),
      ).version,
  );
  await check("Pi Serena", async () => {
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir: agentDir(),
      settingsManager: SettingsManager.inMemory({
        packages: [],
        extensions: [],
      }),
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      additionalExtensionPaths: [
        packagePath("@bacnh85/pi-serena", "extensions/index.ts"),
      ],
    });
    await loader.reload();
    const result = loader.getExtensions();
    if (result.errors.length)
      throw new Error(result.errors.map((e) => e.error).join("; "));
    const names = result.extensions.flatMap((e) => [...e.tools.keys()]);
    for (const name of [
      "serena_get_symbols_overview",
      "serena_find_symbol",
      "serena_find_referencing_symbols",
    ])
      if (!names.includes(name))
        throw new Error(`Required tool missing: ${name}`);
    const version = JSON.parse(
      await readFile(packagePath("@bacnh85/pi-serena", "package.json"), "utf8"),
    ).version;
    const backend = execFileSync("serena", ["--version"], {
      encoding: "utf8",
      timeout: 10000,
    }).trim();
    return `${version}; ${backend}; required semantic tools registered (no worker operation invoked)`;
  });
  await check("Context7", async () => {
    let configured = Boolean(process.env.CONTEXT7_API_KEY);
    try {
      const doc = JSON.parse(
        await readFile(`${agentDir()}/mcp-adapter.json`, "utf8"),
      );
      configured ||= Boolean(doc.mcpServers?.context7);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const adapter = "pi-mcp-adapter";
    await import(adapter);
    return `adapter available; ${configured ? "configured" : "not configured"} (connectivity not probed)`;
  });
  await check("Configuration", async () => {
    const { config, path } = await loadConfig(cwd);
    lines.push(`Configuration: ${path}`);
    for (const role of roles)
      lines.push(
        `Agent ${role}: ${config.agents[role].role} → ${config.agents[role].prompt}`,
      );
    configSchema.parse(config);
    const runtime = await ModelRuntime.create({
      authPath: `${agentDir()}/auth.json`,
      modelsPath: `${agentDir()}/models.json`,
    });
    for (const role of roles) {
      const selection = config.agents[role];
      const model = runtime.getModel(selection.provider, selection.model);
      const present = Boolean(model),
        auth = runtime.hasConfiguredAuth(selection.provider);
      lines.push(
        `${role}: ${selection.provider}/${selection.model}; model ${present ? "registered" : "MISSING"}; auth ${auth ? "configured" : "MISSING"}${selection.temperature === undefined ? "" : `; temperature ${selection.temperature}`}; timeout ${formatAgentTimeout(getAgentTimeoutMs(config, role))}`,
      );
      if (!present || !auth) ok = false;
      if (model)
        try {
          assertTemperatureSupported(model, selection);
        } catch (error) {
          ok = false;
          lines.push(`${role}: FAIL — ${String(error)}`);
        }
    }
    lines.push(
      `Web credential: ${process.env.EXA_API_KEY ? "EXA_API_KEY present" : "EXA_API_KEY unavailable"}`,
    );
    const origins = [
      ...config.pentest.localHttp.allowedOrigins,
      ...config.pentest.localUrls,
    ].map((v) => localUrl(v).origin);
    lines.push(
      `Local HTTP: ${origins.length} approved origins; methods ${config.pentest.localHttp.allowedMethods.join(", ")}; timeout ${config.pentest.localHttp.timeoutMs}ms; no requests sent`,
    );
    // Exercise rejection as well as parsing owner-provided origins.
    for (const invalid of [
      "https://example.com",
      "file:///tmp/test",
      "http://localhost.evil.test",
    ]) {
      let rejected = false;
      try {
        localUrl(invalid);
      } catch {
        rejected = true;
      }
      if (!rejected) throw new Error("External-origin validation failed");
    }
    let state;
    try {
      state = await new StateStore(cwd).latest();
    } catch (error) {
      lines.push(`Legacy state warning: ${String(error)}`);
    }
    lines.push(`Configured commands: ${config.commands.length}`);
    lines.push(`Discovered commands: ${(await discoverCommands(cwd)).length}`);
    lines.push(
      `Approved for current workflow: ${state?.approvedCommands.length ?? 0}${state ? " (" + state.id + ")" : ""}`,
    );
    lines.push(
      `Git hook policy: runHooks=${config.commit.runHooks}${config.commit.runHooks ? " — trusted hooks execute arbitrary local code" : " — automatic commit hooks disabled"}`,
    );
    return path;
  });
  await check("Git", async () => {
    const root = (await git(cwd, ["rev-parse", "--show-toplevel"])).trim();
    const paths = await dirtyPaths(cwd);
    const hooks = (
      await git(cwd, ["config", "--get", "core.hooksPath"]).catch(() => "")
    ).trim();
    return `${root}; ${paths.length} dirty paths; configured hooks ${hooks || "repository default"}`;
  });
  for (const [label, path] of [
    ["Legacy global config", legacyGlobalConfig()],
    ["Legacy project config", join(cwd, ".pi", "team.yaml")],
    ["Legacy state", join(cwd, ".pi", "team-state")],
  ])
    try {
      await access(path);
      lines.push(`${label}: present at ${path}; not used automatically`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        lines.push(`${label}: cannot inspect — ${String(error)}`);
    }
  return { ok, lines };
}
