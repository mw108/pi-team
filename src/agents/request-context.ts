import type { Context } from "@earendil-works/pi-ai";
import { redactStructured, redactVisibleText } from "./redaction.ts";

const secretKey =
  /^(?:password|passwd|token|secret(?:Url)?|authorization|api[_-]?key|app[_-]?key|private[_-]?key|credentials?|access[_-]?token)$/i;

function redactRequestStructure(
  value: unknown,
  protectedField = false,
  fieldName = "",
): unknown {
  if (Array.isArray(value))
    return value.map((item, index) =>
      /^(?:args|argv|argsPrefix)$/i.test(fieldName) &&
      index > 0 &&
      typeof value[index - 1] === "string" &&
      /^--?(?:password|passwd|token|secret|authorization|api[_-]?key|app[_-]?key|private[_-]?key|credential)$/i.test(
        value[index - 1],
      )
        ? "[REDACTED]"
        : redactRequestStructure(item, protectedField),
    );
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => {
        const sensitive = protectedField || secretKey.test(key);
        return [
          key,
          sensitive &&
          (typeof item !== "object" || item === null) &&
          key !== "type"
            ? "[REDACTED]"
            : redactRequestStructure(item, sensitive, key),
        ];
      }),
    );
  return redactStructured(value);
}

function bounded(value: string, limit: number) {
  const safe = redactVisibleText(value);
  return safe.length > limit || value.length > 65536
    ? `${safe.slice(0, limit)}...[TRUNCATED ${Math.max(0, value.length - limit)} chars]`
    : safe;
}

function boundedStructure(value: unknown, limit: number): unknown {
  const safe = redactRequestStructure(value);
  const serialized = JSON.stringify(safe);
  return serialized.length > limit ? bounded(serialized, limit) : safe;
}

function contentText(content: unknown) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part && part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

/** Project only request-visible fields; assistant thinking is never inspected. */
export function providerRequestContext(
  context: Context,
  level: "off" | "summary" | "diagnostic" | "trace",
) {
  const messages = context.messages;
  const systemParts = [context.systemPrompt ?? ""];
  const sections = new Map<string, string>();
  for (const message of messages) {
    if (message.role !== "system") continue;
    systemParts.push(contentText(message.content));
    for (const [name, value] of Object.entries(message.sections ?? {})) {
      if (value === null) sections.delete(name);
      else sections.set(name, value);
    }
  }
  const system = [
    ...systemParts,
    ...[...sections].map(([name, value]) => `${name}: ${value}`),
  ]
    .filter(Boolean)
    .join("\n");
  const user = messages.filter((message) => message.role === "user").at(-1);
  const userText = user ? contentText(user.content) : "";
  let parsed: Record<string, unknown> = {};
  try {
    const value = JSON.parse(userText);
    if (value && typeof value === "object" && !Array.isArray(value))
      parsed = value;
  } catch {}
  const safeUserText = Object.keys(parsed).length
    ? JSON.stringify(redactRequestStructure(parsed))
    : userText;
  const tools = new Map((context.tools ?? []).map((tool) => [tool.name, tool]));
  for (const message of messages) {
    if (message.role !== "system") continue;
    for (const removed of message.toolsRemoved ?? [])
      tools.delete(removed.name);
    for (const added of message.toolsAdded ?? []) tools.set(added.name, added);
  }
  const long = level === "diagnostic" || level === "trace";
  const projectInstructions = parsed.projectInstructions as
    { source?: unknown; sha256?: unknown; content?: unknown } | undefined;
  return {
    systemPromptPreview: bounded(system, long ? 32768 : 8192),
    userContextPreview: bounded(safeUserText, long ? 65536 : 16384),
    contextSummary: Object.fromEntries(
      [
        "task",
        "projectInstructions",
        "requirements",
        "reviewer",
        "implementor",
        "candidateValidationCommands",
        "verifiedCommandResults",
        "approvedCommandIds",
        "commandAuthorizationHints",
      ]
        .filter((key) => key in parsed)
        .map((key) => [
          key,
          boundedStructure(parsed[key], long ? 16384 : 8192),
        ]),
    ),
    ...(projectInstructions
      ? {
          projectInstructions: {
            source: projectInstructions.source,
            sha256: projectInstructions.sha256,
            contentPreview:
              typeof projectInstructions.content === "string"
                ? bounded(projectInstructions.content, long ? 8192 : 2048)
                : undefined,
          },
        }
      : {}),
    tools: [...tools.values()].slice(0, 64).map((tool) => ({
      name: bounded(tool.name, 256),
      description: bounded(tool.description, long ? 8192 : 2048),
      parameters: boundedStructure(tool.parameters, long ? 32768 : 16384),
    })),
    ...(tools.size > 64 ? { toolsTruncated: tools.size - 64 } : {}),
  };
}
