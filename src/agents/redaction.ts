import { redactSecrets } from "../security/secret-patterns.ts";

export function redactVisibleText(text: string) {
  return redactSecrets(
    text
      .slice(0, 65536)
      .replace(
        /((?:--?|\/)(?:password|passwd|token|secret|authorization|api[-_]?key|credential|credentials|access[-_]?token|auth[-_]?token))(\s+|[=:])([^\s]+)/gi,
        "$1$2[REDACTED]",
      )
      .replace(
        /(-D(?:password|passwd|token|secret|authorization|api[-_]?key|credential|credentials|access[-_]?token|auth[-_]?token)=)([^\s]+)/gi,
        "$1[REDACTED]",
      )
      .replace(/\b(Bearer\s+)\S+/gi, "$1[REDACTED]")
      .replace(/\b(sk-[A-Za-z0-9_-]{8,})\b/g, "[REDACTED]")
      .replace(
        /\b([A-Za-z_][A-Za-z0-9_]*(?:_API_KEY|_TOKEN|_SECRET|_PASSWORD)|APP_KEY|API_KEY|TOKEN|SECRET|PASSWORD)\s*[:=]\s*\S+/gi,
        "$1=[REDACTED]",
      )
      .replace(/\b(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[REDACTED]@")
      .replace(/\b(https?:\/\/[^\s?]+)\?\S+/gi, "$1?[REDACTED]"),
  );
}

export function redactStructured<T>(value: T): T {
  if (typeof value === "string") return redactVisibleText(value) as T;
  if (Array.isArray(value)) return value.map(redactStructured) as T;
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redactStructured(item)]),
    ) as T;
  return value;
}

/** Preserve state object identity while removing free-text fragments. */
export function redactStructuredInPlace<T>(value: T): T {
  if (!value || typeof value !== "object") return value;
  for (const [key, item] of Object.entries(value))
    (value as Record<string, unknown>)[key] =
      typeof item === "string"
        ? redactVisibleText(item)
        : redactStructuredInPlace(item);
  return value;
}
