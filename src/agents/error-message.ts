import { redactVisibleText } from "./redaction.ts";

/** Preserve typed errors for diagnostics while using their message at display boundaries. */
export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function formatErrorForUser(error: unknown): string {
  const name = error instanceof Error ? error.name || "Error" : "Error";
  let message = getErrorMessage(error);
  while (true) {
    const prefix = [`${name}: `, "Error: "].find((value) =>
      message.startsWith(value),
    );
    if (!prefix) break;
    message = message.slice(prefix.length);
  }
  return redactVisibleText(`${name}: ${message}`);
}

/** Pi adds `Error: ` when it renders an error notification. */
export function formatErrorForPiNotification(error: unknown): string {
  return formatErrorForUser(error).replace(/^Error: /, "");
}
