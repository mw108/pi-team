import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import YAML from "yaml";
import { configSchema } from "../src/config/schema.ts";
import { loadConfig } from "../src/config/loader.ts";
import { teamRoot } from "../src/config/project.ts";
import { newState, validateState } from "../src/workflow/state.ts";
import { baseline } from "../src/workflow/git.ts";
import { WorkflowEngine } from "../src/workflow/engine.ts";
import { doctor } from "../src/integrations/doctor.ts";
import { configureAgentSampling } from "../src/agents/sampling.ts";
import { config, repository, FixtureRunner } from "./helpers.ts";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Model, Api } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/compat";

const model = {
  provider: "local",
  id: "fixture",
  api: "openai-completions",
  reasoning: false,
} as Model<Api>;

test("temperature schema accepts boundaries, rejects invalid values, and permits omission", () => {
  for (const temperature of [0, 0.1, 1, 2]) {
    const value = config();
    value.agents.solver1.temperature = temperature;
    assert.equal(
      configSchema.parse(value).agents.solver1.temperature,
      temperature,
    );
  }
  for (const temperature of [-0.1, 2.1, NaN, "0.2"]) {
    const value = config();
    value.agents.solver1.temperature = temperature as number;
    const result = configSchema.safeParse(value);
    assert.equal(result.success, false);
    if (!result.success)
      assert.deepEqual(result.error.issues[0].path, [
        "agents",
        "solver1",
        "temperature",
      ]);
  }
  const value = config();
  for (const agent of Object.values(value.agents)) delete agent.temperature;
  for (const agent of Object.values(configSchema.parse(value).agents))
    assert.equal(agent.temperature, undefined);
});

test("project config retains independent agent temperatures and state snapshot", async () => {
  const cwd = await repository();
  const path = join(teamRoot(cwd), "team.yaml");
  const raw = YAML.parse(await readFile(path, "utf8"));
  raw.agents.solver1.temperature = 0.2;
  raw.agents.solver2.temperature = 0.5;
  raw.agents.solver3.temperature = 0.8;
  delete raw.agents.researcher.temperature;
  await writeFile(path, YAML.stringify(raw));
  const loaded = await loadConfig(cwd);
  assert.deepEqual(
    ["solver1", "solver2", "solver3"].map(
      (role) => loaded.config.agents[role as "solver1"].temperature,
    ),
    [0.2, 0.5, 0.8],
  );
  assert.equal(loaded.config.agents.researcher.temperature, undefined);
  const state = newState(cwd, "task", loaded.config, await baseline(cwd));
  assert.equal(
    validateState(JSON.parse(JSON.stringify(state))).config.agents.solver2
      .temperature,
    0.5,
  );
  const oldHash = loaded.configHash;
  raw.agents.solver1.temperature = 0.8;
  await writeFile(path, YAML.stringify(raw));
  assert.notEqual((await loadConfig(cwd)).configHash, oldHash);
});

test("temperature edit pauses an interrupted workflow as config drift", async () => {
  const cwd = await repository();
  const path = join(teamRoot(cwd), "team.yaml");
  const cfg = config();
  await writeFile(path, YAML.stringify(cfg));
  const runner = new FixtureRunner();
  const engine = new WorkflowEngine(cwd, runner, {
    progress: () => {},
    ask: async () => undefined,
  });
  const state = await engine.start("task", cfg);
  state.phase = "RESEARCH";
  state.inFlight = { phase: "RESEARCH", roles: ["researcher"] };
  await engine.store.save(state);
  const changed = YAML.parse(await readFile(path, "utf8"));
  changed.agents.solver2.temperature = 0.8;
  await writeFile(path, YAML.stringify(changed));
  await engine.run(state);
  assert.equal(state.phase, "WAITING_USER");
  assert.equal(state.pendingApproval?.kind, "configDrift");
  assert.ok(state.driftCandidate?.changed.includes("team.yaml"));
  assert.equal(runner.calls.length, 0);
});

test("doctor identifies an invalid agent temperature", async () => {
  const cwd = await repository();
  const path = join(teamRoot(cwd), "team.yaml");
  const raw = YAML.parse(await readFile(path, "utf8"));
  raw.agents.solver3.temperature = 3.5;
  await writeFile(path, YAML.stringify(raw));
  const result = await doctor(cwd);
  assert.equal(result.ok, false);
  assert.match(result.lines.join("\n"), /Configuration: FAIL/);
  assert.match(result.lines.join("\n"), /solver3[\s\S]*temperature/);
});

test("session runtime forwards temperature on every request without changing omitted defaults", () => {
  const calls: unknown[] = [];
  const runtime = {
    streamSimple: (_model: unknown, _context: unknown, options?: unknown) => {
      calls.push(options);
      return {};
    },
  } as unknown as ModelRuntime;
  configureAgentSampling(runtime, model, { temperature: 0.2, thinking: "off" });
  runtime.streamSimple(model, { messages: [] }, { reasoning: "low" });
  runtime.streamSimple(model, { messages: [] }, { reasoning: "medium" });
  assert.deepEqual(calls, [
    {
      reasoning: "low",
      temperature: 0.2,
      samplingParams: { temperature: 0.2 },
    },
    {
      reasoning: "medium",
      temperature: 0.2,
      samplingParams: { temperature: 0.2 },
    },
  ]);

  const omitted: unknown[] = [];
  const defaultRuntime = {
    streamSimple: (_model: unknown, _context: unknown, options?: unknown) => {
      omitted.push(options);
      return {};
    },
  } as unknown as ModelRuntime;
  const original = defaultRuntime.streamSimple;
  configureAgentSampling(defaultRuntime, model, { thinking: "off" });
  assert.equal(defaultRuntime.streamSimple, original);
  defaultRuntime.streamSimple(model, { messages: [] }, { reasoning: "medium" });
  assert.deepEqual(omitted, [{ reasoning: "medium" }]);
});

test("unsupported API and Anthropic thinking reject explicit temperature", () => {
  const runtime = { streamSimple: () => ({}) } as unknown as ModelRuntime;
  assert.throws(
    () =>
      configureAgentSampling(
        runtime,
        { ...model, api: "unsupported" },
        { temperature: 0.2, thinking: "off" },
      ),
    /not supported by Pi API/,
  );
  assert.throws(
    () =>
      configureAgentSampling(
        runtime,
        { ...model, api: "anthropic-messages", reasoning: true },
        { temperature: 0.2, thinking: "high" },
      ),
    /not supported with/,
  );
  assert.throws(
    () =>
      configureAgentSampling(
        runtime,
        {
          ...model,
          api: "openai-codex-responses",
          provider: "openai-codex",
          reasoning: true,
        },
        { temperature: 0.2, thinking: "off" },
      ),
    /not supported for reasoning model/,
  );
});

test("Pi OpenAI-compatible adapter sends configured temperature in request JSON", async () => {
  const payloads: Record<string, unknown>[] = [];
  const localModel = {
    ...model,
    name: "Fixture",
    baseUrl: "http://127.0.0.1:9/v1",
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 32768,
    maxTokens: 100,
    samplingParams: { temperature: 1.3, top_p: 0.9 },
  } as Model<Api>;
  const fetchMock = async (_input: RequestInfo | URL, init?: RequestInit) => {
    payloads.push(JSON.parse(String(init?.body)));
    const chunk = `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 0, model: "fixture", choices: [{ index: 0, delta: { content: "ok" }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 0, model: "fixture", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`;
    return new Response(chunk, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  };
  const runtime = {
    streamSimple: (requestModel: Model<Api>, context: any, options: any) =>
      streamSimple(requestModel, context, options),
  } as unknown as ModelRuntime;
  configureAgentSampling(runtime, localModel, {
    temperature: 0.2,
    thinking: "off",
  });
  const context = {
    messages: [
      {
        role: "user" as const,
        content: [{ type: "text" as const, text: "hi" }],
        timestamp: Date.now(),
      },
    ],
  };
  await runtime
    .streamSimple(localModel, context, { apiKey: "local", fetch: fetchMock })
    .result();
  const defaultRuntime = {
    streamSimple: (requestModel: Model<Api>, context: any, options: any) =>
      streamSimple(requestModel, context, options),
  } as unknown as ModelRuntime;
  configureAgentSampling(defaultRuntime, localModel, { thinking: "off" });
  await defaultRuntime
    .streamSimple(localModel, context, { apiKey: "local", fetch: fetchMock })
    .result();
  assert.equal(payloads.length, 2);
  assert.equal(payloads[0].temperature, 0.2);
  assert.equal(payloads[0].top_p, 0.9);
  assert.equal(payloads[1].temperature, 1.3);
});
