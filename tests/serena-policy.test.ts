import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { checkTool } from "../src/agents/permissions.ts";
import { serenaCapability } from "../src/agents/serena-policy.ts";
import { sanitizeToolResult } from "../src/agents/tool-result.ts";
import { config, repository } from "./helpers.ts";

test("Serena allows only concrete safe file-scoped semantic reads", async () => {
  const cwd = await repository();
  const cfg = config();
  cfg.integrations.serena.enabled = true;
  await writeFile(join(cwd, "normal.php"), "<?php function normal() {};");
  for (const relative_path of ["math.js", "normal.php"])
    for (const name of [
      "serena_get_symbols_overview",
      "serena_find_symbol",
      "serena_get_diagnostics_for_file",
    ])
      await checkTool(
        "researcher",
        name,
        { relative_path, name_path_pattern: "normal" },
        cwd,
        cfg,
      );
  for (const relative_path of [undefined, ".", "missing.ts", "tests"])
    await assert.rejects(() =>
      checkTool(
        "researcher",
        "serena_find_symbol",
        { relative_path, name_path_pattern: "normal" },
        cwd,
        cfg,
      ),
    );
});

test("Serena file reads use the shared sensitive policy and resolved symlink target", async () => {
  const cwd = await repository();
  const cfg = config();
  cfg.integrations.serena.enabled = true;
  await writeFile(join(cwd, ".env"), "SECRET=value");
  await symlink(".env", join(cwd, "environment-alias"));
  await mkdir(join(cwd, "secrets"));
  await writeFile(join(cwd, "secrets", "private.pem"), "secret");
  for (const relative_path of [
    ".env",
    ".env.local",
    ".PI/team/state/foo.json",
    "secrets/private.pem",
    "id_rsa",
    "nested\\ID_ED25519",
    "environment-alias",
  ])
    for (const name of [
      "serena_get_symbols_overview",
      "serena_find_symbol",
      "serena_get_diagnostics_for_file",
    ])
      await assert.rejects(
        () =>
          checkTool(
            "researcher",
            name,
            { relative_path, name_path_pattern: "secret" },
            cwd,
            cfg,
          ),
        /classified as sensitive/,
      );
  // Serena consumes relative_path. A spurious safe `path` must not override it.
  await assert.rejects(
    () =>
      checkTool(
        "researcher",
        "serena_find_symbol",
        { path: "math.js", relative_path: ".env", name_path_pattern: "secret" },
        cwd,
        cfg,
      ),
    /classified as sensitive/,
  );
});

test("unscoped and cross-file Serena results are denied before execution", async () => {
  const cwd = await repository();
  const cfg = config();
  cfg.integrations.serena.enabled = true;
  for (const [name, input] of [
    ["serena_search_for_pattern", { pattern: "secret" }],
    [
      "serena_search_for_pattern",
      { pattern: "secret", relative_path: "tests" },
    ],
    [
      "serena_find_referencing_symbols",
      { name_path: "add", relative_path: "math.js" },
    ],
    ["serena_find_declaration", { name_path: "add", relative_path: "math.js" }],
    [
      "serena_find_implementations",
      { name_path: "add", relative_path: "math.js" },
    ],
    ["serena_get_current_config", {}],
  ] as const)
    await assert.rejects(
      () => checkTool("researcher", name, input, cwd, cfg),
      /may expose sensitive repository content/,
    );
  await assert.rejects(
    () =>
      checkTool(
        "implementor",
        "serena_replace_content",
        { relative_path: "math.js", needle: "add", repl: "sum" },
        cwd,
        cfg,
      ),
    /Serena mutation is not permitted/,
  );
  assert.equal(serenaCapability("serena_future_new_tool"), "unknown");
  await assert.rejects(
    () => checkTool("researcher", "serena_future_new_tool", {}, cwd, cfg),
    /may expose sensitive repository content/,
  );
});

test("safe Serena results still pass through provider-bound redaction", () => {
  const token = `ghp_${"Ab3d".repeat(8)}`;
  const result = sanitizeToolResult({
    content: [{ type: "text", text: `src/math.js: SECRET=${token}` }],
    details: { result: `SECRET=${token}` },
    structuredContent: { symbol: `SECRET=${token}` },
  });
  assert.match(JSON.stringify(result), /\[REDACTED\]/);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(token));
});
