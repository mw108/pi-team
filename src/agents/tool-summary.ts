import { createHash } from "node:crypto";
import { isAbsolute, relative } from "node:path";

function safePath(value: unknown, cwd: string): string | undefined {
  if (typeof value !== "string" || !value || /[\x00-\x1f\x7f]/.test(value))
    return;
  const path = isAbsolute(value) ? relative(cwd, value) : value;
  if (path === ".." || path.startsWith("../") || isAbsolute(path)) return;
  if (
    path
      .split(/[\\/]/)
      .some(
        (part) =>
          part.length > 64 || /(?:sk-|Bearer\s|[A-Za-z0-9_-]{32,})/.test(part),
      )
  )
    return;
  return path.slice(0, 240);
}

function safePattern(value: unknown): string | undefined {
  if (typeof value !== "string") return;
  const pattern = value.trim();
  if (/^[A-Za-z_][A-Za-z0-9_.-]{0,23}$/.test(pattern)) return pattern;
  return `sha256:${createHash("sha256").update(pattern).digest("hex").slice(0, 12)}`;
}

/** Explicit field allowlist. Never serialize arbitrary input or replacement text. */
export function toolCallSummary(
  tool: string,
  input: unknown,
  cwd: string,
): Record<string, string | number> | undefined {
  if (!input || typeof input !== "object") return;
  const args = input as Record<string, unknown>;
  const path = safePath(args.path ?? args.relative_path ?? args.file_path, cwd);
  const summary: Record<string, string | number> = {};
  const addPath = () => {
    if (path) summary.path = path;
  };
  if (/^(?:read|serena_read_file)$/i.test(tool)) {
    addPath();
    for (const key of ["offset", "limit"] as const)
      if (
        typeof args[key] === "number" &&
        Number.isSafeInteger(args[key]) &&
        args[key] >= 0
      )
        summary[key] = args[key];
  } else if (
    /^(?:grep|search|find|serena_search_for_pattern|glob)$/i.test(tool)
  ) {
    addPath();
    const pattern = safePattern(
      args.pattern ?? args.query ?? args.search_query ?? args.glob,
    );
    if (pattern) summary.pattern = pattern;
  } else if (
    /^(?:edit|write|team_delete|serena_replace_content|serena_write_file)$/i.test(
      tool,
    )
  ) {
    addPath();
  } else if (tool === "team_command") {
    if (
      typeof args.id === "string" &&
      /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(args.id)
    )
      summary.command = args.id;
  }
  return Object.keys(summary).length ? summary : undefined;
}
