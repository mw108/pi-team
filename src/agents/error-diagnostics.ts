/** Allowlisted, bounded provider errors. Never traverse arbitrary enumerable fields. */
export interface ErrorDiagnostics {
  constructor?: string | Function;
  name?: string;
  message?: string;
  code?: string | number | null;
  errno?: string | number;
  syscall?: string;
  type?: string;
  status?: number;
  statusCode?: number;
  stack?: string[];
  cause?: ErrorDiagnostics;
  errors?: ErrorDiagnostics[];
  truncated?: "depth" | "circular";
}

function safeText(value: string, max = 300): string {
  return redactVisibleText(
    value
      .split(/[\r\n]/, 1)[0]
      .slice(0, max)
      .replace(/https?:\/\/[^\s)]+/gi, "[URL REDACTED]"),
  );
}

function get(value: object, key: string): unknown {
  try {
    return (value as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

export function serializeErrorDiagnostics(error: unknown): ErrorDiagnostics {
  const seen = new WeakSet<object>();
  const visit = (value: unknown, depth: number): ErrorDiagnostics => {
    if (depth >= 5) return { truncated: "depth" };
    if (!value || (typeof value !== "object" && typeof value !== "function"))
      return { message: safeText(String(value)) };
    if (seen.has(value)) return { truncated: "circular" };
    seen.add(value);
    const result: ErrorDiagnostics = {};
    try {
      const constructor = get(value, "constructor");
      const constructorName =
        constructor && typeof constructor === "function"
          ? get(constructor, "name")
          : undefined;
      if (typeof constructorName === "string")
        result.constructor = safeText(constructorName, 80);
      for (const key of [
        "name",
        "message",
        "code",
        "errno",
        "syscall",
        "type",
      ] as const) {
        const field = get(value, key);
        if (typeof field === "string") result[key] = safeText(field);
        else if (
          (key === "code" || key === "errno") &&
          typeof field === "number" &&
          Number.isFinite(field)
        )
          result[key] = field;
      }
      for (const key of ["status", "statusCode"] as const) {
        const field = get(value, key);
        if (typeof field === "number" && Number.isFinite(field))
          result[key] = field;
      }
      const stack = get(value, "stack");
      if (typeof stack === "string")
        result.stack = stack
          .split("\n")
          .slice(0, 15)
          .map((line, index) =>
            index === 0 || /^\s*at\s/.test(line)
              ? safeText(line.trim(), 400)
              : "[stack line redacted]",
          );
      const cause = get(value, "cause");
      if (cause !== undefined) result.cause = visit(cause, depth + 1);
      const errors = get(value, "errors");
      if (Array.isArray(errors))
        result.errors = errors
          .slice(0, 10)
          .map((child) => visit(child, depth + 1));
    } catch {
      // Hostile getters or proxies must never replace the original failure.
    }
    return result;
  };
  try {
    return visit(error, 0);
  } catch {
    return { message: "[unavailable]" };
  }
}

export function containsTerminated(error: ErrorDiagnostics): boolean {
  return (
    /\bterminated\b/i.test(error.message ?? "") ||
    (error.cause ? containsTerminated(error.cause) : false) ||
    (error.errors?.some(containsTerminated) ?? false)
  );
}

export function firstErrorCode(error: ErrorDiagnostics): string | undefined {
  if (typeof error.code === "string") return error.code;
  return error.cause
    ? firstErrorCode(error.cause)
    : error.errors?.map(firstErrorCode).find(Boolean);
}
import { redactVisibleText } from "./redaction.ts";
