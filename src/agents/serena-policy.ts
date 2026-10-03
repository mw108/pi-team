/** Capabilities of the tools registered by @bacnh85/pi-serena's extension. */
const capabilities = {
  serena_status: "metadata",
  serena_list_tools: "metadata",
  serena_get_symbols_overview: "file-read",
  serena_find_symbol: "file-read",
  serena_get_diagnostics_for_file: "file-read",
  // References can return snippets from any file. A source symbol's path does
  // not limit their output. Declaration/implementation results also vary by
  // backend (LSP locations versus unconstrained JetBrains text).
  serena_find_referencing_symbols: "cross-file-results",
  serena_find_declaration: "cross-file-results",
  serena_find_implementations: "cross-file-results",
  serena_search_for_pattern: "unbounded-content",
  serena_get_current_config: "unbounded-content",
  serena_replace_symbol_body: "mutation",
  serena_insert_before_symbol: "mutation",
  serena_insert_after_symbol: "mutation",
  serena_rename_symbol: "mutation",
  serena_safe_delete_symbol: "mutation",
  serena_replace_content: "mutation",
} as const;

export type SerenaCapability =
  (typeof capabilities)[keyof typeof capabilities] | "unknown";

export function serenaCapability(name: string): SerenaCapability {
  return Object.hasOwn(capabilities, name)
    ? capabilities[name as keyof typeof capabilities]
    : "unknown";
}

export const serenaRead = [
  "serena_status",
  "serena_list_tools",
  "serena_get_symbols_overview",
  "serena_find_symbol",
  "serena_find_referencing_symbols",
  "serena_find_declaration",
  "serena_find_implementations",
  "serena_search_for_pattern",
  "serena_get_current_config",
  "serena_get_diagnostics_for_file",
];

export const serenaWrite = [
  "serena_replace_symbol_body",
  "serena_insert_before_symbol",
  "serena_insert_after_symbol",
  "serena_rename_symbol",
  "serena_safe_delete_symbol",
  "serena_replace_content",
];
