import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { localHttpTool } from "../src/agents/http.ts";
import { config } from "./helpers.ts";
import { configSchema } from "../src/config/schema.ts";
async function fixture(host = "127.0.0.1") {
  const server = createServer(async (req, res) => {
    if (req.url === "/slow") {
      setTimeout(() => res.end("late"), 150).unref();
      return;
    }
    if (req.url?.startsWith("/redirect")) {
      res.writeHead(302, {
        location: req.url.endsWith("external") ? "https://example.com/" : "/",
      });
      res.end();
      return;
    }
    if (req.url === "/large") {
      res.end("x".repeat(100));
      return;
    }
    let body = "";
    for await (const data of req) body += data;
    res.setHeader("x-test", "yes");
    res.end(JSON.stringify({ method: req.method, headers: req.headers, body }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, resolve);
  });
  const address = server.address() as any,
    origin = `http://${host === "::1" ? "[::1]" : host}:${address.port}`;
  const cfg = config();
  cfg.pentest.localHttp.allowedOrigins = [origin];
  cfg.pentest.localHttp.allowedMethods = [
    "GET",
    "POST",
    "PUT",
    "PATCH",
    "DELETE",
    "HEAD",
    "OPTIONS",
  ];
  const call = async (input: any) =>
    (
      await localHttpTool(cfg).execute(
        "test",
        { url: origin, ...input },
        undefined,
        undefined,
        {} as any,
      )
    ).details as any;
  return {
    cfg,
    origin,
    call,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
for (const method of [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
])
  test(`local HTTP ${method} is permitted only by policy`, async () => {
    const f = await fixture();
    try {
      assert.equal((await f.call({ method })).status, 200);
    } finally {
      await f.close();
    }
  });
test("HTTP forwards application headers and JSON with explicit content-type precedence", async () => {
  const f = await fixture();
  try {
    const result = await f.call({
      method: "POST",
      headers: {
        Authorization: "Bearer test",
        Cookie: "session=test",
        "Content-Type": "application/custom",
      },
      json: { name: "value" },
    });
    const body = JSON.parse(result.body);
    assert.equal(body.headers.authorization, "Bearer test");
    assert.equal(body.headers.cookie, "session=test");
    assert.equal(body.headers["content-type"], "application/custom");
    assert.equal(body.body, '{"name":"value"}');
    assert.equal(result.headers["x-test"], "yes");
    assert.equal(result.truncated, false);
  } finally {
    await f.close();
  }
});
test("HTTP accepts raw malformed body and rejects ambiguous JSON/body or GET body", async () => {
  const f = await fixture();
  try {
    assert.equal(
      JSON.parse((await f.call({ method: "POST", body: "{broken" })).body).body,
      "{broken",
    );
    await assert.rejects(
      () => f.call({ method: "POST", body: "x", json: null }),
      /mutually exclusive/,
    );
    await assert.rejects(() => f.call({ body: "x" }), /GET\/HEAD/);
  } finally {
    await f.close();
  }
});
test("HTTP enforces total timeout and response byte truncation", async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      () => f.call({ url: f.origin + "/slow", timeoutMs: 20 }),
      /timeout/,
    );
    f.cfg.pentest.localHttp.maxResponseBodyBytes = 12;
    const result = await f.call({ url: f.origin + "/large" });
    assert.equal(result.body, "x".repeat(12));
    assert.equal(result.truncated, true);
    assert.ok(result.durationMs >= 0);
  } finally {
    await f.close();
  }
});
test("HTTP rejects disallowed method, unsafe headers and oversized requests", async () => {
  const f = await fixture();
  try {
    f.cfg.pentest.localHttp.allowedMethods = ["GET"];
    await assert.rejects(() => f.call({ method: "DELETE" }), /method/);
    await assert.rejects(
      () => f.call({ headers: { Host: "external.com" } }),
      /Unsafe/,
    );
    await assert.rejects(() => f.call({ headers: { X: "a\r\nb" } }), /Unsafe/);
    await assert.rejects(
      () =>
        f.call({
          headers: Object.fromEntries(
            Array.from({ length: 33 }, (_, i) => ["x" + i, "v"]),
          ),
        }),
      /Too many/,
    );
    await assert.rejects(
      () => f.call({ headers: { X: "a".repeat(9000) } }),
      /byte limit/,
    );
    f.cfg.pentest.localHttp.allowedMethods.push("POST");
    f.cfg.pentest.localHttp.maxRequestBodyBytes = 1;
    await assert.rejects(
      () => f.call({ method: "POST", body: "é" }),
      /byte limit/,
    );
  } finally {
    await f.close();
  }
});
test("HTTP rejects external targets, malformed URLs, credentials and unapproved origins", async () => {
  const f = await fixture();
  try {
    for (const url of [
      "https://example.com",
      "http://localhost:12345",
      "bad url",
      "file:///tmp/file",
      "ftp://127.0.0.1",
      "http://localhost.evil.test",
      "http://user:pass@127.0.0.1",
      "http://127.0.0.1:1",
    ])
      await assert.rejects(() => f.call({ url }));
  } finally {
    await f.close();
  }
});
test("HTTP rejects both local and external redirects without following them", async () => {
  const f = await fixture();
  try {
    for (const path of ["/redirect", "/redirect-external"])
      await assert.rejects(() => f.call({ url: f.origin + path }), /Redirect/);
  } finally {
    await f.close();
  }
});
test("HTTP handles configured IPv6 loopback", async () => {
  const f = await fixture("::1");
  try {
    assert.equal((await f.call({})).status, 200);
  } finally {
    await f.close();
  }
});
test("HTTP handles configured localhost and legacy localUrls", async () => {
  const f = await fixture();
  try {
    const url = f.origin.replace("127.0.0.1", "localhost");
    await assert.rejects(() => f.call({ url }), /origin/);
    f.cfg.pentest.localHttp.allowedOrigins = [url];
    assert.equal((await f.call({ url })).status, 200);
    f.cfg.pentest.localHttp.allowedOrigins = [];
    f.cfg.pentest.localUrls = [f.origin + "/old/path"];
    assert.equal((await f.call({})).status, 200);
  } finally {
    await f.close();
  }
});
test("HTTP configuration rejects external origins and non-origin URL values", () => {
  for (const origin of [
    "http://example.com",
    "http://127.0.0.1/path",
    "gopher://localhost",
    "http://user:pass@localhost",
  ]) {
    const cfg = config();
    cfg.pentest.localHttp.allowedOrigins = [origin];
    assert.throws(() => configSchema.parse(cfg), /loopback/);
  }
});
