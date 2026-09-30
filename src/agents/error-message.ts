/** Preserve typed errors for diagnostics while using their message at display boundaries. */
export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function formatErrorForUser(error: unknown): string {
  const name = error instanceof Error ? error.name || "Error" : "Error";
  let message = getErrorMessage(error);
  for (let i = 0; i < 3; i++) {
    const prefix = [`${name}: `, "Error: "].find((value) =>
      message.startsWith(value),
    );
    if (!prefix) break;
    message = message.slice(prefix.length);
  }
  return `${name}: ${message}`;
}
