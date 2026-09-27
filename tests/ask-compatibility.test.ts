import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkAskCompatibility,
  approvalParams,
  approvalValues,
} from "../src/integrations/pi-ask.ts";
async function packageFixture(version = "1.2.0") {
  const root = await mkdtemp(join(tmpdir(), "pi-ask-probe-"));
  await mkdir(join(root, "src"));
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ name: "@eko24ive/pi-ask", version }),
  );
  await writeFile(join(root, "src/ask-tool.ts"), "// fixture");
  return root;
}
test("installed compatible pi-ask registers the real ask_user definition", async () => {
  const result = await checkAskCompatibility();
  assert.equal(result.version, "1.2.0");
  assert.equal(result.tool.name, "ask_user");
  assert.equal(typeof result.tool.execute, "function");
});
test("missing pi-ask gives actionable doctor and README error", async () => {
  await assert.rejects(
    () => checkAskCompatibility({ root: "/does-not-exist/pi-ask" }),
    (error) =>
      /npm run doctor/.test(String(error)) && /README/.test(String(error)),
  );
});
test("missing pi-ask export or wrong tool registration fails clearly", async () => {
  const root = await packageFixture();
  await assert.rejects(
    () => checkAskCompatibility({ root, importModule: async () => ({}) }),
    /Required export registerAskTool/,
  );
  await assert.rejects(
    () =>
      checkAskCompatibility({
        root,
        importModule: async () => ({ registerAskTool: () => {} }),
      }),
    /ask_user registration failed/,
  );
  await assert.rejects(
    () =>
      checkAskCompatibility({
        root,
        importModule: async () => ({
          registerAskTool: (pi: any) =>
            pi.registerTool({
              name: "ask_user",
              parameters: {},
              execute: () => {},
            }),
        }),
      }),
    /ask_user registration failed/,
  );
});
test("compatible patch range accepted; unverified minor rejected cleanly", async () => {
  const root = await packageFixture("1.2.9");
  const result = await checkAskCompatibility({
    root,
    importModule: async () => ({
      registerAskTool: (pi: any) =>
        pi.registerTool({
          name: "ask_user",
          parameters: { properties: { questions: { type: "array" } } },
          execute: () => {},
        }),
    }),
  });
  assert.equal(result.version, "1.2.9");
  const incompatible = await packageFixture("1.3.0");
  await assert.rejects(
    () => checkAskCompatibility({ root: incompatible }),
    /Unsupported version/,
  );
});
test("pi-ask multi-selection grants only exact listed values; cancellation and notes grant nothing", () => {
  const request = {
    kind: "commands" as const,
    title: "Approve",
    prompt: "Select",
    options: [
      { value: "test", label: "npm test", description: "package.json" },
    ],
  };
  assert.equal(approvalParams(request).questions[0].type, "multi");
  assert.deepEqual(
    approvalValues(request, {
      mode: "submit",
      answers: { approval: { values: ["test"] } },
    }),
    ["test"],
  );
  assert.deepEqual(
    approvalValues(request, {
      mode: "submit",
      answers: { approval: { values: [], note: "approve all" } },
    }),
    [],
  );
  assert.equal(
    approvalValues(request, { cancelled: true, mode: "submit" }),
    undefined,
  );
  assert.throws(
    () =>
      approvalValues(request, {
        mode: "submit",
        answers: { approval: { values: ["*"] } },
      }),
    /listed options/,
  );
  assert.throws(
    () =>
      approvalValues(request, {
        mode: "submit",
        answers: { approval: { values: ["test"], customText: "extra" } },
      }),
    /freeform/,
  );
});
