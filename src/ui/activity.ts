import type { TeamConfig } from "../config/schema.ts";
import type { CommandSummary } from "../agents/command-observability.ts";

export type ToolActivityKind =
  | "serena-symbols"
  | "serena-references"
  | "documentation"
  | "web-search"
  | "web-research"
  | "file-read"
  | "file-search"
  | "local-http"
  | "validation"
  | "git"
  | "mcp"
  | "tool";
export interface ToolActivity {
  kind: ToolActivityKind;
  label: string;
  provider?: string;
}

const categories: Record<string, ToolActivity> = {
  "web-search": { kind: "web-search", label: "Web search" },
  "web-research": { kind: "web-research", label: "Web research" },
  documentation: { kind: "documentation", label: "Documentation" },
  mcp: { kind: "mcp", label: "MCP tool" },
  tool: { kind: "tool", label: "Using tool" },
};
const builtins: Record<string, ToolActivity> = {
  serena_find_symbol: { kind: "serena-symbols", label: "Serena: symbols" },
  serena_find_referencing_symbols: {
    kind: "serena-references",
    label: "Serena: references",
  },
  serena_get_symbols_overview: {
    kind: "serena-symbols",
    label: "Serena: overview",
  },
  serena_find_file: { kind: "file-search", label: "Serena: files" },
  web_search: categories["web-search"],
  fetch_content: categories["web-research"],
  read: { kind: "file-read", label: "Reading files" },
  grep: { kind: "file-search", label: "Searching files" },
  find: { kind: "file-search", label: "Finding files" },
  ls: { kind: "file-read", label: "Listing files" },
  team_local_http: { kind: "local-http", label: "Local HTTP test" },
  team_command: { kind: "validation", label: "Running approved command" },
  team_git_inspect: { kind: "git", label: "Inspecting diff" },
  team_delete: { kind: "tool", label: "Deleting approved file" },
  edit: { kind: "tool", label: "Editing files" },
  write: { kind: "tool", label: "Writing files" },
  validation_test: { kind: "validation", label: "Running tests" },
  validation_static: { kind: "validation", label: "Static validation" },
  commit_inspect: { kind: "git", label: "Inspecting diff" },
  commit_create: { kind: "git", label: "Creating commit" },
};
const safeToolName = (name: string) =>
  /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/.test(name);

export function classifyToolActivity(
  name: string,
  config?: TeamConfig,
  innerToolName?: string,
): ToolActivity {
  const actual =
    name === "mcp" && innerToolName && safeToolName(innerToolName)
      ? innerToolName
      : name;
  const mappings = config?.toolActivity.mappings ?? {};
  const match = Object.keys(mappings)
    .filter((pattern) =>
      pattern.endsWith("*")
        ? actual.startsWith(pattern.slice(0, -1))
        : pattern === actual,
    )
    .sort(
      (a, b) =>
        (b.endsWith("*") ? 0 : 1000) +
        b.length -
        ((a.endsWith("*") ? 0 : 1000) + a.length),
    )[0];
  if (match)
    return {
      ...categories[mappings[match].category],
      provider: mappings[match].provider,
    };
  if (builtins[actual]) return builtins[actual];
  if (
    actual.startsWith("context7_") ||
    (name === "mcp" && /^(resolve-library-id|query-docs)$/.test(actual))
  )
    return { kind: "documentation", label: "Context7", provider: "Context7" };
  if (actual.startsWith("serena_")) return { kind: "tool", label: "Serena" };
  if (name === "mcp" || actual.startsWith("mcp_")) return categories.mcp;
  return categories.tool;
}

export function formatToolActivity(
  name: string,
  config?: TeamConfig,
  innerToolName?: string,
  command?: CommandSummary,
): string {
  if (name === "team_command" && command?.executable)
    return formatApprovedCommand(command)!;
  const activity = classifyToolActivity(name, config, innerToolName);
  return `${activity.label}${config?.ui.progress.showToolProvider && activity.provider && activity.label !== activity.provider ? ` · ${activity.provider}` : ""}`;
}

/** Shared, bounded label for live progress and /team-log. */
export function formatApprovedCommand(summary: unknown): string | undefined {
  if (!summary || typeof summary !== "object") return;
  const command = summary as Partial<CommandSummary>;
  if (typeof command.executable !== "string" || !command.executable) return;
  const labels: Record<string, string> = {
    test: "Test",
    build: "Build",
    static: "Static check",
    lint: "Lint",
  };
  const label = labels[command.purpose ?? ""] ?? "Command";
  const args = Array.isArray(command.args)
    ? command.args.filter((arg): arg is string => typeof arg === "string")
    : [];
  const value = [command.executable, ...args]
    .map((part) => (/[\s"']/.test(part) ? JSON.stringify(part) : part))
    .join(" ");
  const full = `${label}: ${value}`;
  return full.length > 76 ? `${full.slice(0, 75)}…` : full;
}

export function validationActivity(purpose: string): string {
  return purpose === "test" ? "Running tests" : "Static validation";
}
