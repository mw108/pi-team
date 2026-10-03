import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import {
  detectSecrets,
  redactSecrets,
} from "../src/security/secret-patterns.ts";
import { scanCommitSecrets } from "../src/security/secret-scan.ts";
import { redactVisibleText } from "../src/agents/redaction.ts";
import { checkTool } from "../src/agents/permissions.ts";
import { contextFor } from "../src/agents/context.ts";
import { WorkflowEngine } from "../src/workflow/engine.ts";
import { prepareCommit } from "../src/workflow/git.ts";
import { StateStore } from "../src/workflow/persistence.ts";
import { block, record, newState } from "../src/workflow/state.ts";
import { serializeErrorDiagnostics } from "../src/agents/error-diagnostics.ts";
import { formatErrorForPiNotification } from "../src/agents/error-message.ts";
import { AgentLogStore } from "../src/workflow/agent-logs.ts";
import {
  config,
  contract,
  output,
  repository,
  FixtureRunner,
} from "./helpers.ts";

const aws = `AKIA${"A1B2C3D4E5F6G7H8"}`;
const github = `ghp_${"Ab3d".repeat(8)}`;
const provider = `sk-ant-${"aB3_".repeat(8)}`;
const openai = `sk-proj-${"pQ7_".repeat(8)}`;
const jwt = `eyJ${"aB3_".repeat(4)}.${"cD4_".repeat(5)}.${"eF5_".repeat(5)}`;
const examples = [
  `API_KEY="${"Ab3d".repeat(8)}"`,
  `SECRET=${"Q7w9".repeat(8)}`,
  `SECRET_KEY=${"R8t2".repeat(8)}`,
  aws,
  github,
  provider,
  openai,
  jwt,
  "-----BEGIN OPENSSH PRIVATE KEY-----\nsecret-body\n-----END OPENSSH PRIVATE KEY-----",
];

test("shared patterns detect high-signal secrets and leave placeholders alone", () => {
  for (const example of examples) {
    assert.ok(detectSecrets(example).length, example.slice(0, 12));
    assert.match(redactSecrets(example), /\[REDACTED\]/);
    assert.doesNotMatch(
      redactVisibleText(example),
      /Ab3dAb3d|AKIAA1B2|ghp_Ab3d|sk-ant-aB3_/,
    );
  }
  for (const benign of [
    "API_KEY=example",
    "TOKEN=changeme",
    "version 1.2.3",
    "--filter=test_token_parser",
  ])
    assert.equal(detectSecrets(benign).length, 0);
});

test("scanner falls back when gitleaks is absent and scans only requested files", async () => {
  const cwd = await repository();
  await writeFile(join(cwd, "math.js"), `export const key = "${github}";\n`);
  await writeFile(join(cwd, "unrelated.txt"), aws);
  const result = await scanCommitSecrets(cwd, ["math.js"], async () => {
    throw Object.assign(new Error("missing"), { code: "ENOENT" });
  });
  assert.equal(result.scanner, "builtin");
  assert.deepEqual(
    result.findings.map((finding) => finding.path),
    ["math.js"],
  );
  assert.doesNotMatch(JSON.stringify(result), new RegExp(github));
});

test("available gitleaks runs on isolated commit files and returns safe metadata", async () => {
  const cwd = await repository();
  await writeFile(join(cwd, "math.js"), github);
  await writeFile(join(cwd, "unrelated.txt"), aws);
  const calls: string[][] = [];
  const result = await scanCommitSecrets(
    cwd,
    ["math.js"],
    async (_exe, args) => {
      calls.push(args);
      if (args[0] === "version") return;
      assert.equal(args[0], "dir");
      assert.equal(await readFile(join(args[1], "math.js"), "utf8"), github);
      await assert.rejects(() => readFile(join(args[1], "unrelated.txt")));
      const report = args[args.indexOf("--report-path") + 1];
      await writeFile(
        report,
        JSON.stringify([
          {
            File: join(args[1], "math.js"),
            StartLine: 1,
            RuleID: "github-token",
            Secret: github,
          },
        ]),
      );
      throw Object.assign(new Error("finding"), { code: 1 });
    },
  );
  assert.equal(calls.length, 2);
  assert.equal(result.scanner, "gitleaks");
  assert.deepEqual(result.findings, [
    { path: "math.js", line: 1, kind: "github-token" },
  ]);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(github));
});

test("sensitive direct reads and broad grep are denied while ordinary files remain readable", async () => {
  const cwd = await repository();
  const cfg = config();
  for (const path of [
    ".env",
    ".env.local",
    "private.pem",
    "id_rsa",
    ".pi/team/state/foo.json",
    "AUTH.JSON",
    "nested\\ID_ED25519",
  ])
    await assert.rejects(
      () => checkTool("researcher", "read", { path }, cwd, cfg),
      /denied|private/i,
    );
  await checkTool("researcher", "read", { path: "math.js" }, cwd, cfg);
  await checkTool(
    "researcher",
    "read",
    { path: "tests/math.test.mjs" },
    cwd,
    cfg,
  );
  await writeFile(join(cwd, "normal.php"), "<?php echo 1;");
  await writeFile(join(cwd, "notes.md"), "Notes");
  await checkTool("researcher", "read", { path: "normal.php" }, cwd, cfg);
  await checkTool("researcher", "read", { path: "notes.md" }, cwd, cfg);
  await writeFile(join(cwd, ".env"), `SECRET=${github}`);
  await symlink(".env", join(cwd, "environment-alias"));
  await assert.rejects(
    () =>
      checkTool("researcher", "read", { path: "environment-alias" }, cwd, cfg),
    /classified as sensitive/,
  );
  await assert.rejects(
    () => checkTool("researcher", "grep", { pattern: "key" }, cwd, cfg),
    /specific/,
  );
  await checkTool(
    "researcher",
    "grep",
    { path: "math.js", pattern: "add" },
    cwd,
    cfg,
  );
  cfg.integrations.serena.enabled = true;
  await assert.rejects(
    () =>
      checkTool(
        "researcher",
        "serena_search_for_pattern",
        { pattern: "secret" },
        cwd,
        cfg,
      ),
    /denied/,
  );
});

test("legacy persisted errors are redacted on load without rewriting the old file", async () => {
  const cwd = await repository();
  const state = newState(cwd, "Fix", config(), {
    head: null,
    dirtyPaths: [],
    status: "",
    diff: "",
    cachedDiff: "",
  });
  state.phase = "BLOCKED";
  state.blocker = `Provider failed with ${github}`;
  state.history.push({
    at: new Date().toISOString(),
    phase: "BLOCKED",
    event: "agent_failure",
    detail: github,
  });
  const store = new StateStore(cwd);
  await writeFile(store.path(state.id), JSON.stringify(state));
  const loaded = await store.load(state.id);
  assert.doesNotMatch(JSON.stringify(loaded), new RegExp(github));
  assert.match(
    await readFile(store.path(state.id), "utf8"),
    new RegExp(github),
  );
});

test("review context excludes unrelated dirty content and redacts allowed diff secrets", async () => {
  const cwd = await repository();
  await writeFile(join(cwd, "unrelated.txt"), `UNRELATED_MARKER ${aws}`);
  await writeFile(join(cwd, ".env"), `SECRET=${github}`);
  const engine = new WorkflowEngine(cwd, new FixtureRunner(), {
    progress: () => {},
    ask: async () => undefined,
  });
  const state = await engine.start("Fix", config());
  state.results.reviewer = contract;
  state.results.implementor = output("implementor");
  await writeFile(join(cwd, "math.js"), `export const key = "${provider}";\n`);
  const context = JSON.stringify(await contextFor("codeReviewer", state));
  assert.match(context, /\[REDACTED\]/);
  assert.doesNotMatch(context, new RegExp(provider));
  assert.doesNotMatch(context, /UNRELATED_MARKER/);
  assert.doesNotMatch(context, new RegExp(github));
  assert.equal(state.baseline.diff, "");
});

test("commit preparation blocks a secret without exposing its value", async () => {
  const cwd = await repository();
  const engine = new WorkflowEngine(cwd, new FixtureRunner(), {
    progress: () => {},
    ask: async () => undefined,
  });
  const state = await engine.start("Fix", config());
  state.results.reviewer = contract;
  state.results.codeReviewer = output("codeReviewer");
  state.results.securityReviewer = output("securityReviewer");
  state.results.tester = output("tester");
  await writeFile(join(cwd, "math.js"), `export const key = "${github}";\n`);
  await assert.rejects(
    () => prepareCommit(state, ["math.js"], "fix: math"),
    (error: Error) => {
      assert.match(error.message, /Commit blocked: possible/);
      assert.doesNotMatch(error.message, new RegExp(github));
      return true;
    },
  );
});

test("state, nested provider errors, notifications and JSONL redact secrets", async () => {
  const cwd = await repository();
  const engine = new WorkflowEngine(cwd, new FixtureRunner(), {
    progress: () => {},
    ask: async () => undefined,
  });
  const state = await engine.start("Fix", config());
  const raw = `HTTP 503 Authorization: Bearer ${github}`;
  const error = Object.assign(new Error(raw), {
    code: "EAI_AGAIN",
    cause: new Error(`cause ${provider}`),
  });
  error.stack = `Error: ${raw}\n    at request (${provider})`;
  const diagnostic = serializeErrorDiagnostics(error);
  record(state, "agent_failure", `researcher: ${raw}`, {
    agent: "researcher",
    attempt: 1,
    finalError: { message: raw, causeMessage: String(error.cause) },
  });
  block(state, `Agent execution failed: ${raw}`);
  await engine.store.save(state);
  const stored = await readFile(new StateStore(cwd).path(state.id), "utf8");
  const loaded = await engine.store.load(state.id);
  const log = await new AgentLogStore(cwd).create(state.id, "researcher");
  log.logger.append({
    type: "provider_error",
    error: { message: raw, cause: { message: provider } },
    code: 503,
  });
  await log.logger.flush();
  const jsonl = await readFile(log.logger.path, "utf8");
  for (const visible of [
    stored,
    JSON.stringify(loaded),
    JSON.stringify(diagnostic),
    formatErrorForPiNotification(error),
    jsonl,
  ]) {
    assert.doesNotMatch(visible, new RegExp(github));
    assert.doesNotMatch(visible, new RegExp(provider));
  }
  assert.match(stored, /HTTP 503/);
  assert.match(JSON.stringify(diagnostic), /EAI_AGAIN/);
  assert.match(jsonl, /"code":503/);
});
