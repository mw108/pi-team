import { writeFile, mkdir } from "node:fs/promises";
import { PiRunner } from "../src/agents/runner.ts";
import { loadConfig } from "../src/config/loader.ts";
import { newState } from "../src/workflow/state.ts";
import { baseline } from "../src/workflow/git.ts";
const { config } = await loadConfig(process.cwd());
const state = newState(
  process.cwd(),
  "Integration smoke test",
  config,
  await baseline(process.cwd()),
);
const runner = new PiRunner();
const results: Record<string, unknown> = {};
async function check(name: string, run: () => Promise<unknown>) {
  try {
    const result = await run();
    results[name] = { status: "PASS", result };
    console.log(`${name}: PASS`);
  } catch (e) {
    results[name] = { status: "FAIL", error: String(e).slice(0, 2000) };
    console.log(`${name}: FAIL — ${String(e).slice(0, 500)}`);
    process.exitCode = 1;
  }
}
const session = await runner.createSession("researcher", state);
try {
  const ctx = session.extensionRunner.createContext();
  const call = async (name: string, args: any) => {
    const tool = session.getToolDefinition(name);
    if (!tool) throw new Error(`Missing tool: ${name}`);
    const result = await tool.execute(
      `smoke-${name}`,
      args,
      AbortSignal.timeout(60000),
      undefined,
      ctx,
    );
    const content = result.content
      .filter((c) => c.type === "text")
      .map((c) => (c as any).text)
      .join("\n");
    if ((result as any).isError || /^(Error|ERROR)|"error"\s*:/m.test(content))
      throw new Error(content.slice(0, 2000));
    return content;
  };
  await check("pi-serena", async () => {
    const result = await call("serena_get_symbols_overview", {
      relative_path: "src/workflow/router.ts",
      depth: 0,
      timeout_ms: 60000,
    });
    if (!result.includes("transition"))
      throw new Error("Expected router symbol missing");
    return { semanticSymbolFound: true };
  });
  await check("context7", async () => {
    const result = await call("mcp", {
      tool: "context7_resolve-library-id",
      args: {
        libraryName: "zod",
        query: "Zod schema validation safeParse TypeScript",
      },
    });
    if (!/zod/i.test(result) || !/\/[^\s]+/.test(result))
      throw new Error("No library result");
    const match = result.match(/(?:Library ID|libraryId)[:\s"']+(\/[\w/.-]+)/i);
    const libraryId = result.includes("/colinhacks/zod")
      ? "/colinhacks/zod"
      : match?.[1];
    if (!libraryId) throw new Error("Cannot extract resolved library ID");
    const docs = await call("mcp", {
      tool: "context7_query-docs",
      args: {
        libraryId,
        query: "How to validate TypeScript data using Zod safeParse?",
      },
    });
    if (!/safeParse/i.test(docs))
      throw new Error("Expected API documentation missing");
    return { resolved: true, documentationRetrieved: true };
  });
  await check("web-search", async () => {
    const result = await call("web_search", {
      query: "site:pi.dev Pi coding agent extensions",
      numResults: 2,
    });
    if (!/https?:\/\//.test(result)) throw new Error("No source URLs returned");
    return { sourceUrlsFound: true };
  });
} finally {
  await session.extensionRunner
    .emit({ type: "session_shutdown", reason: "quit" })
    .catch(() => {});
  session.dispose();
}
await mkdir("docs", { recursive: true });
await writeFile(
  "docs/integration-validation.json",
  JSON.stringify({ at: new Date().toISOString(), results }, null, 2) + "\n",
);
