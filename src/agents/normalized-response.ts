import type { AssistantMessage } from "@earendil-works/pi-ai";
import { redactCommandArgs } from "./command-observability.ts";
import { redactVisibleText } from "./redaction.ts";

const sensitiveKey =
  /(?:password|passwd|token|secret|authorization|api[-_]?key|credential|private[-_]?key)/i;
const reasoningKey =
  /^(?:thinking|reasoning|reasoning_delta|internal[_-]?thoughts?)$/i;

export type NormalizedResponseEvent = {
  type: "assistant_response";
  providerRequest: number;
  finishReason: AssistantMessage["stopReason"];
  content: Array<
    | { type: "text"; contentIndex: number; text: string; truncated?: true }
    | {
        type: "tool_call";
        contentIndex: number;
        toolCallId: string;
        tool: string;
        arguments: unknown;
        truncated?: true;
      }
  >;
  hasReasoning?: true;
  reasoningChars?: number;
  truncated?: true;
  rawStopReason?: string;
};

/** Copy only visible, bounded Pi content. Never copy thinking blocks or signatures. */
export function normalizedResponseForLog(
  message: AssistantMessage,
  providerRequest: number,
  level: "summary" | "diagnostic" | "trace" = "summary",
): NormalizedResponseEvent {
  const limit = level === "summary" ? 4096 : 16384;
  let remaining = limit;
  let remainingNodes = 512;
  let truncated = false;
  const take = (value: string, max = 2048) => {
    const safe = redactVisibleText(value);
    const result = safe.slice(0, Math.min(remaining, max));
    remaining -= result.length;
    if (result.length < safe.length || value.length > 65536) truncated = true;
    return result;
  };
  const sanitize = (value: unknown, depth = 0, key = ""): unknown => {
    if (remainingNodes-- <= 0) {
      truncated = true;
      return "[TRUNCATED]";
    }
    if (reasoningKey.test(key)) return "[REDACTED]";
    if (sensitiveKey.test(key)) return "[REDACTED]";
    if (typeof value === "string") return take(value);
    if (
      value === null ||
      typeof value === "number" ||
      typeof value === "boolean"
    )
      return value;
    if (depth >= 8 || remaining <= 0) {
      truncated = true;
      return "[TRUNCATED]";
    }
    if (Array.isArray(value)) {
      const prefix = value.slice(0, 64);
      const items =
        key === "args" && prefix.every((item) => typeof item === "string")
          ? redactCommandArgs(prefix as string[])
          : prefix;
      if (value.length > 64) truncated = true;
      const result: unknown[] = [];
      for (const item of items) {
        if (remainingNodes <= 0) {
          truncated = true;
          break;
        }
        result.push(sanitize(item, depth + 1));
      }
      return result;
    }
    if (value && typeof value === "object") {
      const entries: Array<[string, unknown]> = [];
      let count = 0;
      for (const name in value) {
        if (!Object.hasOwn(value, name)) continue;
        if (count++ >= 64) {
          truncated = true;
          break;
        }
        if (remainingNodes <= 0) {
          truncated = true;
          break;
        }
        entries.push([
          take(name),
          sanitize((value as Record<string, unknown>)[name], depth + 1, name),
        ]);
      }
      return Object.fromEntries(entries);
    }
    truncated = true;
    return "[UNSUPPORTED]";
  };
  const content: NormalizedResponseEvent["content"] = [];
  let reasoningChars = 0;
  for (const [contentIndex, block] of message.content.entries()) {
    if (block.type === "thinking") {
      reasoningChars += block.thinking.length;
      continue;
    }
    if (content.length >= 64) {
      truncated = true;
      break;
    }
    const before = truncated;
    if (block.type === "text") {
      const text = take(block.text, level === "summary" ? 2048 : 8192);
      content.push({
        type: "text",
        contentIndex,
        text,
        ...(!before && truncated ? { truncated: true } : {}),
      });
    } else if (block.type === "toolCall") {
      const toolCallId = take(block.id);
      const tool = take(block.name);
      const args = sanitize(block.arguments);
      content.push({
        type: "tool_call",
        contentIndex,
        toolCallId,
        tool,
        arguments: args,
        ...(!before && truncated ? { truncated: true } : {}),
      });
    }
  }
  const rawStopReason =
    level !== "summary" && message.rawStopReason
      ? take(message.rawStopReason)
      : undefined;
  return {
    type: "assistant_response",
    providerRequest,
    finishReason: message.stopReason,
    content,
    ...(reasoningChars ? { hasReasoning: true, reasoningChars } : {}),
    ...(truncated ? { truncated: true } : {}),
    ...(rawStopReason === undefined ? {} : { rawStopReason }),
  };
}
