import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

/** The published adapter exposes TypeScript source with unrelated type errors. */
declare module "pi-mcp-adapter" {
  export function createMcpAdapter(options?: {
    config?: unknown;
  }): ExtensionFactory;
}
