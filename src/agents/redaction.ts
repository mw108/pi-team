export function redactVisibleText(text: string) {
  return text
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
      /\b([A-Za-z_][A-Za-z0-9_]*(?:_API_KEY|_TOKEN|_SECRET|_PASSWORD)|API_KEY|TOKEN|SECRET|PASSWORD)\s*[:=]\s*\S+/gi,
      "$1=[REDACTED]",
    )
    .replace(/\b(https?:\/\/[^\s?]+)\?\S+/gi, "$1?[REDACTED]");
}
