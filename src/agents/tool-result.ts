import type {
  ToolResultEvent,
  ToolResultEventResult,
} from "@earendil-works/pi-coding-agent";
import { redactStructured, redactVisibleText } from "./redaction.ts";

/** The same provider-bound result transform applies to native and Serena tools. */
export function sanitizeToolResult(
  event: Pick<ToolResultEvent, "content" | "details" | "structuredContent">,
): ToolResultEventResult {
  return {
    content: event.content.map((item) =>
      item.type === "text"
        ? { ...item, text: redactVisibleText(item.text) }
        : item,
    ),
    details: redactStructured(event.details),
    ...(event.structuredContent !== undefined
      ? { structuredContent: redactStructured(event.structuredContent) }
      : {}),
  };
}
