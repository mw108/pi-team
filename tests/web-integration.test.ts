import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { allowedTools } from "../src/agents/permissions.ts";
import {
  packagePath,
  webAccessExtensionPath,
} from "../src/integrations/resources.ts";
import { config } from "./helpers.ts";

const FAKE_KEY = "exa-test-secret-never-log";

async function requestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function json(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

async function eventually(predicate: () => boolean, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail("Expected cancellation did not reach the fixture server");
}

test("pi-web-access 0.38 extension and Pi-Team boundary remain compatible", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "pi-team-web-"));
  const agentDirectory = join(directory, "agent");
  const originalEnvironment = {
    PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
    PI_WEB_ACCESS_CACHE_ROOT: process.env.PI_WEB_ACCESS_CACHE_ROOT,
    EXA_API_KEY: process.env.EXA_API_KEY,
    EXA_BASE_URL: process.env.EXA_BASE_URL,
  };
  let searchRequest:
    { headers: IncomingMessage["headers"]; body: any } | undefined;
  let slowSearchCancelled = false;
  let slowFetchCancelled = false;

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/search") {
      const body = JSON.parse(await requestBody(request));
      searchRequest = { headers: request.headers, body };
      if (body.query === "empty") return json(response, 200, { results: [] });
      if (body.query === "rate limited") {
        response.writeHead(429, { "content-type": "text/plain" });
        return response.end(`rate limited for ${FAKE_KEY}`);
      }
      if (body.query === "server error") {
        response.writeHead(503, { "content-type": "text/plain" });
        return response.end("provider unavailable");
      }
      if (body.query === "malformed") {
        response.writeHead(200, { "content-type": "application/json" });
        return response.end("{not-json");
      }
      if (body.query === "slow search") {
        request.on("aborted", () => {
          slowSearchCancelled = true;
        });
        response.on("close", () => {
          if (!response.writableEnded) slowSearchCancelled = true;
        });
        return;
      }
      return json(response, 200, {
        results: [
          {
            title: "Alpha result",
            url: "https://example.test/alpha",
            highlights: ["Verified alpha snippet."],
          },
          {
            url: "https://example.test/optional-fields",
            highlights: [],
          },
        ],
      });
    }

    if (url.pathname === "/html") {
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
      });
      return response.end(
        "<!doctype html><html><head><title>Fixture article</title></head><body><main><article><h1>Fixture article</h1><p>The deterministic HTML body is preserved for the agent. This fixture describes a stable test document whose only purpose is to exercise readable content extraction.</p><p>It contains enough readable text for extraction without inventing additional claims. Titles, paragraphs, punctuation, and UTF-8 text remain grounded in this response.</p><p>A third paragraph makes the article representative of an ordinary documentation page. The extension should return these facts and should not add facts that the local server never supplied.</p><p>The final paragraph keeps the fixture above the extractor's incomplete-content threshold while remaining well below the configured response and context limits.</p></article></main></body></html>",
      );
    }
    if (url.pathname === "/text") {
      response.writeHead(200, {
        "content-type": "text/plain; charset=utf-8",
      });
      return response.end("Plain text fixture: Grüße aus Berlin.");
    }
    if (url.pathname === "/binary") {
      response.writeHead(200, { "content-type": "application/octet-stream" });
      return response.end(Buffer.from([0, 1, 2, 3]));
    }
    if (url.pathname === "/oversize") {
      response.writeHead(200, {
        "content-type": "text/plain",
        "content-length": String(6 * 1024 * 1024),
      });
      return response.end();
    }
    if (url.pathname === "/slow-fetch") {
      request.on("aborted", () => {
        slowFetchCancelled = true;
      });
      response.on("close", () => {
        if (!response.writableEnded) slowFetchCancelled = true;
      });
      return;
    }
    const status = Number(url.pathname.slice(1));
    if ([404, 429, 500].includes(status)) {
      response.writeHead(status, { "content-type": "text/plain" });
      return response.end(`fixture ${status}`);
    }
    response.writeHead(404);
    response.end();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  process.env.PI_CODING_AGENT_DIR = agentDirectory;
  process.env.PI_WEB_ACCESS_CACHE_ROOT = join(directory, "cache");
  await mkdir(agentDirectory, { recursive: true });
  delete process.env.EXA_API_KEY;
  delete process.env.EXA_BASE_URL;

  const settings = SettingsManager.inMemory({
    packages: [],
    extensions: [],
    compaction: { enabled: false },
    retry: { enabled: false, maxRetries: 0 },
    cacheWarming: "off",
  });
  const loader = new DefaultResourceLoader({
    cwd: directory,
    agentDir: agentDirectory,
    settingsManager: settings,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    additionalExtensionPaths: [webAccessExtensionPath()],
  });

  try {
    await t.test(
      "loads without optional credentials and registers once",
      async () => {
        await loader.reload();
        let loaded = loader.getExtensions();
        assert.deepEqual(loaded.errors, []);
        assert.equal(loaded.extensions.length, 1);
        for (const name of ["web_search", "fetch_content"]) {
          assert.ok(
            loaded.extensions[0].tools.has(name),
            `${name} must register`,
          );
        }

        const startup = await createAgentSession({
          cwd: directory,
          agentDir: agentDirectory,
          settingsManager: settings,
          resourceLoader: loader,
          sessionManager: SessionManager.inMemory(directory),
          tools: ["web_search", "fetch_content"],
        });
        await startup.session.bindExtensions({ mode: "print" });
        assert.ok(startup.session.getActiveToolNames().includes("web_search"));
        assert.ok(
          startup.session.getActiveToolNames().includes("fetch_content"),
        );
        await startup.session.extensionRunner.emit({
          type: "session_shutdown",
          reason: "quit",
        });
        startup.session.dispose();

        await loader.reload();
        loaded = loader.getExtensions();
        assert.deepEqual(loaded.errors, []);
        assert.equal(loaded.extensions.length, 1);
        assert.equal(
          [...loaded.extensions[0].tools.keys()].filter(
            (name) => name === "web_search",
          ).length,
          1,
        );
        assert.equal(
          [...loaded.extensions[0].tools.keys()].filter(
            (name) => name === "fetch_content",
          ).length,
          1,
        );
      },
    );

    await writeFile(
      join(agentDirectory, "web-search.json"),
      JSON.stringify({
        provider: "exa",
        workflow: "none",
        toolActivation: "eager",
        maxInlineContentChars: 1024,
        fetch: {
          timeout: 1,
          defaultMode: "readable",
          allowedModes: ["readable", "raw"],
        },
        fetchRouting: {
          providers: ["http"],
          allowRemoteHostedProviders: false,
        },
        ssrf: { allowRanges: ["127.0.0.1/32"] },
      }),
      "utf8",
    );
    process.env.EXA_API_KEY = FAKE_KEY;
    process.env.EXA_BASE_URL = baseUrl;
    await loader.reload();

    const extension = loader.getExtensions().extensions[0];
    const { session } = await createAgentSession({
      cwd: directory,
      agentDir: agentDirectory,
      settingsManager: settings,
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(directory),
      tools: ["web_search", "fetch_content"],
    });
    await session.bindExtensions({ mode: "print" });
    const webSearch = session.extensionRunner.getToolDefinition("web_search")!;
    const fetchContent =
      session.extensionRunner.getToolDefinition("fetch_content")!;
    let call = 0;
    const execute = (
      tool: typeof webSearch,
      params: any,
      signal?: AbortSignal,
    ) => {
      const callId = `web-regression-${++call}`;
      const actualSignal = signal ?? new AbortController().signal;
      return tool.execute(
        callId,
        params,
        actualSignal,
        undefined,
        session.extensionRunner.createToolContext(callId, actualSignal),
      ) as Promise<any>;
    };

    await t.test(
      "exposes the expected Pi schemas and agent permissions",
      () => {
        const searchProperties = (webSearch.parameters as any).properties;
        const fetchProperties = (fetchContent.parameters as any).properties;
        for (const name of ["query", "queries", "numResults", "provider"])
          assert.ok(searchProperties[name], `web_search schema lacks ${name}`);
        for (const name of ["url", "urls", "mode"])
          assert.ok(
            fetchProperties[name],
            `fetch_content schema lacks ${name}`,
          );

        const enabled = config();
        enabled.integrations.web.enabled = true;
        assert.ok(allowedTools("researcher", enabled).includes("web_search"));
        assert.ok(
          allowedTools("researcher", enabled).includes("fetch_content"),
        );
        assert.ok(!allowedTools("implementor", enabled).includes("web_search"));
      },
    );

    await t.test("maps successful and empty Exa search results", async () => {
      const success = await execute(webSearch, {
        query: "alpha",
        numResults: 2,
        provider: "exa",
        workflow: "none",
      });
      assert.equal(success.isError, undefined);
      assert.equal(searchRequest?.body.query, "alpha");
      assert.equal(searchRequest?.body.numResults, 2);
      assert.equal(searchRequest?.headers["x-api-key"], FAKE_KEY);
      assert.deepEqual(
        success.structuredContent.queries[0].results.map((result: any) => ({
          title: result.title,
          url: result.url,
        })),
        [
          { title: "Alpha result", url: "https://example.test/alpha" },
          {
            title: "example.test",
            url: "https://example.test/optional-fields",
          },
        ],
      );
      assert.match(success.content[0].text, /Verified alpha snippet/);

      const empty = await execute(webSearch, {
        query: "empty",
        provider: "exa",
        workflow: "none",
      });
      assert.equal(empty.isError, undefined);
      assert.equal(empty.details.successfulQueries, 1);
      assert.equal(empty.details.totalResults, 0);
      assert.deepEqual(empty.structuredContent.queries[0].results, []);
    });

    await t.test(
      "surfaces provider, parse, and cancellation failures safely",
      async () => {
        const captured: string[] = [];
        const originalError = console.error;
        const originalLog = console.log;
        console.error = (...values: unknown[]) =>
          captured.push(values.join(" "));
        console.log = (...values: unknown[]) => captured.push(values.join(" "));
        try {
          for (const [query, pattern] of [
            ["rate limited", /Exa API error 429/],
            ["server error", /Exa API error 503/],
            ["malformed", /JSON|Unexpected|position/i],
          ] as const) {
            const result = await execute(webSearch, {
              query,
              provider: "exa",
              workflow: "none",
            });
            assert.equal(result.isError, true);
            assert.match(result.content[0].text, pattern);
            assert.equal(JSON.stringify(result).includes(FAKE_KEY), false);
          }
        } finally {
          console.error = originalError;
          console.log = originalLog;
        }
        assert.equal(captured.join("\n").includes(FAKE_KEY), false);

        const controller = new AbortController();
        const pending = execute(
          webSearch,
          { query: "slow search", provider: "exa", workflow: "none" },
          controller.signal,
        );
        setTimeout(() => controller.abort(), 30);
        await assert.rejects(pending, /abort/i);
        await eventually(() => slowSearchCancelled);
      },
    );

    await t.test(
      "fetches HTML and UTF-8 plain text without fabrication",
      async () => {
        const html = await execute(fetchContent, { url: `${baseUrl}/html` });
        assert.equal(html.isError, undefined, JSON.stringify(html));
        assert.match(html.content.at(-1).text, /deterministic HTML body/);
        assert.match(
          html.content.at(-1).text,
          /without inventing additional claims/,
        );

        const plain = await execute(fetchContent, {
          url: `${baseUrl}/text`,
          mode: "raw",
        });
        assert.equal(plain.isError, undefined);
        assert.match(plain.content.at(-1).text, /Grüße aus Berlin/);
      },
    );

    await t.test(
      "bounds binary, HTTP, invalid URL, timeout, and oversized failures",
      async () => {
        for (const [path, pattern] of [
          ["binary", /Unsupported content type/i],
          ["404", /HTTP 404/i],
          ["429", /HTTP 429/i],
          ["500", /HTTP 500/i],
          ["oversize", /Response too large/i],
        ] as const) {
          const result = await execute(fetchContent, {
            url: `${baseUrl}/${path}`,
          });
          assert.equal(result.isError, true, path);
          assert.match(result.content[0].text, pattern, path);
        }

        const invalid = await execute(fetchContent, { url: "not a valid URL" });
        assert.equal(invalid.isError, true);
        assert.match(invalid.content[0].text, /invalid|URL|HTTP/i);

        const localFile = await execute(fetchContent, {
          url: "file:///etc/passwd",
        });
        assert.equal(localFile.isError, true);

        const timeout = await execute(fetchContent, {
          url: `${baseUrl}/slow-fetch`,
        });
        assert.equal(timeout.isError, true);
        assert.match(timeout.content[0].text, /abort|timed? out|timeout/i);
        await eventually(() => slowFetchCancelled);
      },
    );

    await t.test(
      "blocks SSRF targets and unsafe redirects by default",
      async () => {
        const moduleUrl = pathToFileURL(
          packagePath("pi-web-access", "ssrf-protection.ts"),
        ).href;
        const { fetchRemoteUrl, validateRemoteUrl } = (await import(
          moduleUrl
        )) as any;
        await assert.rejects(
          validateRemoteUrl("http://127.0.0.1/private"),
          /Blocked internal address/,
        );
        await assert.rejects(
          validateRemoteUrl("https://metadata.example/latest", {
            lookup: async () => [{ address: "169.254.169.254", family: 4 }],
          }),
          /Blocked internal address/,
        );
        await assert.rejects(
          fetchRemoteUrl(
            "https://public.example/start",
            {},
            {
              lookup: async () => [{ address: "93.184.216.34", family: 4 }],
              fetch: async () =>
                new Response(null, {
                  status: 302,
                  headers: { location: "http://127.0.0.1/private" },
                }),
            },
          ),
          /Blocked internal address/,
        );
      },
    );

    await t.test("registers shutdown cleanup", async () => {
      const shutdown = extension.handlers.get("session_shutdown") ?? [];
      assert.ok(shutdown.length > 0);
      await session.extensionRunner.emit({
        type: "session_shutdown",
        reason: "quit",
      });
      session.dispose();
    });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const [name, value] of Object.entries(originalEnvironment)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(directory, { recursive: true, force: true });
  }
});
