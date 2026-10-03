import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { WorkflowEngine } from "../src/workflow/engine.ts";
import { localHttpTool } from "../src/agents/http.ts";
import { config, repository, FixtureRunner } from "./helpers.ts";
import { git, head } from "../src/workflow/git.ts";
import teamExtension from "../src/index.ts";
test("fixture integrates command discovery, implementation, POST pentest, security, real tests and intended commit", async () => {
  const cwd = await repository();
  await writeFile(
    join(cwd, "package.json"),
    JSON.stringify({
      type: "module",
      scripts: { test: "node --test tests/math.test.mjs" },
    }),
  );
  await git(cwd, ["add", "package.json"]);
  await git(cwd, [
    "-c",
    "core.hooksPath=/dev/null",
    "commit",
    "-m",
    "test: declared validation",
  ]);
  let requests = 0;
  const server = createServer(async (req, res) => {
    assert.equal(req.method, "POST");
    assert.equal(req.headers["content-type"], "application/json");
    let body = "";
    for await (const chunk of req) body += chunk;
    assert.deepEqual(JSON.parse(body), { probe: "disposable" });
    requests++;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end('{"accepted":true}');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const cfg = config();
    cfg.qualityGates.pentest.enabled = true;
    const origin = `http://127.0.0.1:${(server.address() as any).port}`;
    cfg.pentest.localHttp.allowedOrigins = [origin];
    cfg.pentest.localHttp.allowedMethods = ["POST"];
    let approvals = 0;
    const runner = new FixtureRunner(async (role, s) => {
      if (role === "pentester") {
        const response = await localHttpTool(s.config).execute(
          "fixture",
          {
            method: "POST",
            url: origin + "/api/probe",
            json: { probe: "disposable" },
          },
          undefined,
          undefined,
          {} as any,
        );
        assert.equal((response.details as any).status, 200);
        return {
          status: "PASS",
          findings: [],
          coverage: ["Real local HTTP POST JSON request"],
          limitations: [
            "Fixture reasoning; not model-generated security analysis",
          ],
        };
      }
    });
    const engine = new WorkflowEngine(cwd, runner, {
        progress: () => {},
        ask: async () => undefined,
        approve: async (request) => {
          approvals++;
          return undefined;
        },
      }),
      s = await engine.start("Fix addition with local POST validation", cfg);
    const before = await head(cwd);
    await engine.run(s);
    assert.equal(s.phase, "DONE", s.blocker);
    assert.equal(approvals, 0);
    assert.equal(requests, 1);
    assert.equal(s.approvedCommands.length, 0);
    assert.equal(s.discoveredCommands.length, 1);
    assert.equal((s.results.tester as any).commands[0].exitCode, 0);
    assert.notEqual(await head(cwd), before);
    assert.deepEqual(s.commit?.files, ["math.js"]);
    assert.ok(runner.calls.includes("securityReviewer"));
    assert.ok(
      runner.calls.indexOf("codeReviewer") < runner.calls.indexOf("pentester"),
    );
    assert.ok(
      runner.calls.indexOf("pentester") <
        runner.calls.indexOf("securityReviewer"),
    );
    assert.ok(
      runner.calls.indexOf("securityReviewer") < runner.calls.indexOf("tester"),
    );
    assert.equal((await git(cwd, ["status", "--short"])).trim(), "");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
test("/team doctor handler reports diagnostics without starting a workflow", async () => {
  const commands = new Map<string, any>();
  teamExtension({
    on: () => {},
    registerCommand: (name: string, definition: any) =>
      commands.set(name, definition),
  } as any);
  assert.ok(commands.has("team"));
  let notice = "";
  const context = {
    cwd: process.cwd(),
    ui: {
      notify: (text: string) => {
        notice = text;
      },
    },
  };
  await commands.get("team").handler("doctor", context);
  assert.match(notice, /ask_user registration verified/);
  assert.match(notice, /required semantic tools registered/);
  assert.match(notice, /Configured commands:/);
  assert.match(notice, /Discovered commands:/);
  assert.match(notice, /Approved for current workflow:/);
  assert.match(notice, /no requests sent/);
});
