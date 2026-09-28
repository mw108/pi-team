import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Model, Api } from "@earendil-works/pi-ai";
import type { TeamConfig } from "../config/schema.ts";

type AgentSampling = Pick<
  TeamConfig["agents"]["orchestrator"],
  "temperature" | "thinking"
>;

// These adapters forward StreamOptions.temperature in the installed pi-ai 0.87.1.
const temperatureApis = new Set<Api>([
  "openai-completions",
  "openai-responses",
  "azure-openai-responses",
  "openai-codex-responses",
  "anthropic-messages",
  "google-generative-ai",
  "google-vertex",
  "bedrock-converse-stream",
  "mistral-conversations",
  "pi-messages",
]);

export function assertTemperatureSupported(
  model: Model<Api>,
  agent: AgentSampling,
): void {
  const { temperature } = agent;
  if (temperature === undefined) return;
  if (!temperatureApis.has(model.api))
    throw new Error(
      `Temperature is not supported by Pi API ${model.api} for ${model.provider}/${model.id}`,
    );
  if (
    model.reasoning &&
    (model.provider === "openai" || model.provider === "openai-codex") &&
    (model.api === "openai-responses" || model.api === "openai-codex-responses")
  )
    throw new Error(
      `Temperature is not supported for reasoning model ${model.provider}/${model.id}`,
    );
  if (model.api === "anthropic-messages") {
    const compat = model.compat as
      | { supportsTemperature?: boolean; supportsMidConvoEffort?: boolean }
      | undefined;
    if (
      compat?.supportsTemperature === false ||
      compat?.supportsMidConvoEffort === true ||
      (model.reasoning && agent.thinking !== "off")
    )
      throw new Error(
        `Temperature is not supported with ${model.provider}/${model.id} and thinking ${agent.thinking}`,
      );
  }
}

export function configureAgentSampling(
  runtime: ModelRuntime,
  model: Model<Api>,
  agent: AgentSampling,
): void {
  assertTemperatureSupported(model, agent);
  const { temperature } = agent;
  if (temperature === undefined) return;
  // A PiRunner creates one runtime per agent session. Pi's SDK calls this method
  // for every turn, including tool continuations and the JSON correction turn.
  const streamSimple = runtime.streamSimple.bind(runtime);
  runtime.streamSimple = (requestModel, context, options) => {
    const requestOptions = { ...options, temperature };
    // Pi applies OpenAI-compatible samplingParams after the named temperature
    // field. Mirror the explicit value there so it wins over model defaults.
    if (
      requestModel.api === "openai-completions" ||
      requestModel.api === "openai-responses" ||
      requestModel.api === "azure-openai-responses"
    )
      requestOptions.samplingParams = {
        ...options?.samplingParams,
        temperature,
      };
    return streamSimple(requestModel, context, requestOptions);
  };
}
