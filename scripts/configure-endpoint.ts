import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import YAML from "yaml";
import { packagePath } from "../src/integrations/resources.ts";
import { agentDir } from "../src/config/loader.ts";
const baseUrl = process.argv[2];
if (!baseUrl) throw new Error("Provide the exact endpoint base URL");
const clientPath = pathToFileURL(
  packagePath(
    "@earendil-works/pi-coding-agent",
    "dist/extensions/llama/client.js",
  ),
).href;
const { LlamaClient } = await import(clientPath);
const client = new LlamaClient(baseUrl);
const catalog = await client.list({ signal: AbortSignal.timeout(15000) });
const model = catalog.find((m: any) =>
  ["loaded", "sleeping"].includes(m.status.value),
);
if (!model)
  throw new Error(
    "Endpoint has no loaded model; no model will be loaded or downloaded automatically",
  );
const props = await client.props({
  model: model.id,
  signal: AbortSignal.timeout(15000),
});
const contextWindow =
  props.default_generation_settings?.n_ctx ??
  model.meta?.n_ctx ??
  model.meta?.n_ctx_train ??
  32768;
const path = join(agentDir(), "models.json");
const config = JSON.parse(await readFile(path, "utf8"));
config.providers ??= {};
config.providers.local = {
  baseUrl,
  api: "openai-completions",
  apiKey: "local",
  headers: { "ngrok-skip-browser-warning": "true" },
  models: [
    {
      id: model.id,
      contextWindow,
      maxTokens: Math.min(8192, contextWindow),
      reasoning: false,
      compat: {
        supportsStore: false,
        supportsDeveloperRole: false,
        supportsReasoningEffort: false,
        supportsStrictMode: false,
        maxTokensField: "max_tokens",
      },
    },
  ],
};
await writeFile(path, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
const teamPath = join(agentDir(), "team.yaml"),
  team = YAML.parse(await readFile(teamPath, "utf8"));
for (const role of Object.values(team.agents) as any[]) {
  if (role.provider === "local" && role.model === "configure-model-id")
    role.model = model.id;
}
await writeFile(teamPath, YAML.stringify(team), { mode: 0o600 });
console.log(
  JSON.stringify(
    {
      baseUrl,
      model: model.id,
      contextWindow,
      models: catalog.map((m: any) => ({ id: m.id, status: m.status.value })),
    },
    null,
    2,
  ),
);
