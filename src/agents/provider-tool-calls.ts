import { redactSecrets } from "../security/secret-patterns.ts";
import { redactVisibleText } from "./redaction.ts";

export type ToolCallLogLevel = "off" | "summary" | "diagnostic" | "trace";

export type RawToolCallEvent = {
  type: "provider_tool_call_raw";
  toolCallIndex: number;
  toolCallId?: string;
  tool?: string;
  rawArguments: string;
  rawArgumentsTruncated?: true;
  parseStatus: "ok" | "error" | "truncated";
  rawArgumentsLength?: number;
  fragmentCount?: number;
  parsedArguments?: unknown;
  parseError?: string;
  finishReason?: string;
  incomplete?: true;
  fragmentLengths?: number[];
};

const memoryLimit = 65536;
const summaryLimit = 4096;
const diagnosticLimit = 16384;
const sensitiveKey =
  /(?:password|passwd|token|secret|authorization|api[-_]?key|app[-_]?key|credential|private[-_]?key)/i;
function isSensitiveWireKey(key: string): boolean {
  try {
    return sensitiveKey.test(JSON.parse(`"${key}"`) as string);
  } catch {
    return sensitiveKey.test(key);
  }
}

/** Redact JSON string values by key without parsing/re-serializing the wire string. */
export function redactRawToolArguments(raw: string): string {
  const keyed = raw.replace(
    /("((?:\\.|[^"\\])*)"\s*:\s*")((?:\\.|[^"\\])*)("|$)/g,
    (match, prefix: string, key: string, _value: string, suffix: string) =>
      isSensitiveWireKey(key) ? `${prefix}[REDACTED]${suffix}` : match,
  );
  // A partial quoted value has no closing quote. Keep its syntax and hide its tail.
  const partial = keyed.replace(
    /("((?:\\.|[^"\\])*)"\s*:\s*")((?:\\.|[^"\\])*)$/g,
    (match, prefix: string, key: string) =>
      isSensitiveWireKey(key) ? `${prefix}[REDACTED]` : match,
  );
  const bare = partial.replace(
    /("((?:\\.|[^"\\])*)"\s*:\s*)(?!")([^\s,}]+)/g,
    (match, prefix: string, key: string) =>
      isSensitiveWireKey(key) ? `${prefix}[REDACTED]` : match,
  );
  const argv = bare.replace(
    /("(?:--?|\/)(?:password|passwd|token|secret|authorization|api[-_]?key|credential|access[-_]?token|auth[-_]?token)"\s*,\s*")((?:\\.|[^"\\])*)("|$)/gi,
    (_match, prefix: string, _value: string, suffix: string) =>
      `${prefix}[REDACTED]${suffix}`,
  );
  return redactSecrets(
    argv
      .replace(/(Bearer\s+)[^\s"\\,}]+/gi, "$1[REDACTED]")
      .replace(
        /\b((?:APP_KEY|API_KEY|TOKEN|SECRET|PASSWORD)\s*[:=]\s*)[^\s"',}]+/gi,
        "$1[REDACTED]",
      ),
  );
}

function safeParsed(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[TRUNCATED]";
  if (Array.isArray(value))
    return value.slice(0, 32).map((item) => safeParsed(item, depth + 1));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 32)
        .map(([key, item]) => [
          redactVisibleText(key.slice(0, 128)),
          sensitiveKey.test(key) ? "[REDACTED]" : safeParsed(item, depth + 1),
        ]),
    );
  return typeof value === "string"
    ? redactVisibleText(value.slice(0, 2048))
    : value;
}

type Call = {
  index: number;
  id: string;
  name: string;
  raw: string;
  length: number;
  count: number;
  fragmentLengths: number[];
};

/** One instance per physical provider request; never combines retry fragments. */
export class RawToolCallCollector {
  private readonly calls = new Map<number, Call>();
  constructor(private readonly level: ToolCallLogLevel) {}

  observe(data: unknown): void {
    if (!data || typeof data !== "object") return;
    const choices = (data as { choices?: unknown }).choices;
    if (!Array.isArray(choices)) return;
    const choice = choices[0] as
      | { delta?: { tool_calls?: unknown }; message?: { tool_calls?: unknown } }
      | undefined;
    const streamed = choice?.delta?.tool_calls;
    const final = choice?.message?.tool_calls;
    const entries = Array.isArray(streamed)
      ? streamed
      : Array.isArray(final)
        ? final
        : [];
    for (const [position, entry] of entries.entries()) {
      if (!entry || typeof entry !== "object") continue;
      const part = entry as {
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      };
      const index =
        Number.isSafeInteger(part.index) && part.index! >= 0
          ? part.index!
          : position;
      if (index > 1024 || (!this.calls.has(index) && this.calls.size >= 64))
        continue;
      let call = this.calls.get(index);
      if (!call) {
        call = {
          index,
          id: "",
          name: "",
          raw: "",
          length: 0,
          count: 0,
          fragmentLengths: [],
        };
        this.calls.set(index, call);
      }
      if (typeof part.id === "string") call.id = part.id.slice(0, 256);
      if (typeof part.function?.name === "string") {
        const name = part.function.name;
        call.name = (call.name + name).slice(0, 256);
      }
      if (typeof part.function?.arguments === "string") {
        const fragment = part.function.arguments;
        call.length += fragment.length;
        call.count++;
        call.raw += fragment.slice(
          0,
          Math.max(0, memoryLimit - call.raw.length),
        );
        if (this.level === "trace" && call.fragmentLengths.length < 16)
          call.fragmentLengths.push(fragment.length);
      }
    }
  }

  events(finishReason?: string, incomplete = false): RawToolCallEvent[] {
    if (this.level === "off" || (incomplete && this.level === "summary"))
      return [];
    return [...this.calls.values()].map((call) => {
      const limit = this.level === "summary" ? summaryLimit : diagnosticLimit;
      const rawArgumentsTruncated = call.length > limit;
      const raw = call.raw.slice(0, limit);
      let parsed: unknown;
      let parseError: string | undefined;
      if (call.length <= memoryLimit) {
        try {
          JSON.parse(call.raw);
          // Parse the redacted wire string for diagnostics so adjacent argv
          // secrets cannot reappear in parsedArguments.
          try {
            parsed = safeParsed(JSON.parse(redactRawToolArguments(call.raw)));
          } catch {
            // The raw parse status is still authoritative; omit this preview.
          }
        } catch (error) {
          const message = String(error);
          parseError = /unexpected end of JSON input/i.test(message)
            ? "Unexpected end of JSON input"
            : "Invalid JSON syntax";
        }
      }
      return {
        type: "provider_tool_call_raw" as const,
        toolCallIndex: call.index,
        ...(call.id ? { toolCallId: redactVisibleText(call.id) } : {}),
        ...(call.name ? { tool: redactVisibleText(call.name) } : {}),
        rawArguments: redactRawToolArguments(raw),
        ...(rawArgumentsTruncated
          ? { rawArgumentsTruncated: true as const }
          : {}),
        parseStatus:
          call.length > memoryLimit
            ? ("truncated" as const)
            : parseError
              ? ("error" as const)
              : ("ok" as const),
        ...(this.level === "summary"
          ? {}
          : {
              rawArgumentsLength: call.length,
              fragmentCount: call.count,
              ...(parseError ? { parseError } : {}),
              ...(!parseError && !rawArgumentsTruncated && parsed !== undefined
                ? { parsedArguments: parsed }
                : {}),
              ...(finishReason
                ? {
                    finishReason: redactVisibleText(finishReason.slice(0, 128)),
                  }
                : {}),
              ...(incomplete ? { incomplete: true as const } : {}),
              ...(this.level === "trace"
                ? { fragmentLengths: call.fragmentLengths }
                : {}),
            }),
      };
    });
  }
}
