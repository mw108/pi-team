import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { WorkflowEngine } from "../src/workflow/engine.ts";
import { git, unexpectedWorkflowChanges } from "../src/workflow/git.ts";
import { packageManagerContractGuidance } from "../src/workflow/package-manager.ts";
import {
  config,
  contract,
  FixtureRunner,
  output,
  repository,
} from "./helpers.ts";

async function generatedWorkflow(decisions: Array<string[] | undefined>) {
  const cwd = await repository();
  const requests: any[] = [];
  const runner = new FixtureRunner(async (role) => {
    if (role === "tester") {
      await writeFile(join(cwd, "generated.txt"), "generated\n");
      return output(role);
    }
    return undefined;
  });
  const engine = new WorkflowEngine(cwd, runner, {
    progress: () => {},
    ask: async () => undefined,
    approve: async (request) => {
      requests.push(request);
      if (request.kind === "contractExtension") return decisions.shift();
      return ["allow"];
    },
  });
  const state = await engine.start("Generate an additional fixture", config());
  await engine.run(state);
  return { cwd, engine, requests, runner, state };
}

test("unexpected create pauses, Include persists exact scope, and resumes without rerunning implementation", async () => {
  const { cwd, state, requests, runner } = await generatedWorkflow([
    ["include"],
  ]);
  assert.equal(state.phase, "DONE", state.blocker);
  assert.deepEqual(state.workflowApprovedContractPaths, [
    {
      path: "generated.txt",
      operation: "create",
      source: "repository_change_user_approval",
    },
  ]);
  assert.equal(runner.counts.implementor, 1);
  assert.equal(runner.counts.tester, 2);
  assert.equal(runner.counts.commitAgent, 1);
  assert.equal(
    requests.find((request) => request.kind === "contractExtension")?.title,
    "File outside Implementation Contract",
  );
  assert.match(
    await git(cwd, ["show", "--format=", "--name-only", "HEAD"]),
    /generated\.txt/,
  );
  for (const event of [
    "contract_extension_approval_requested",
    "contract_extension_approval_granted",
    "contract_extension_revalidated",
    "contract_extension_resume",
  ])
    assert.ok(
      state.history.some((entry) => entry.event === event),
      event,
    );
});

test("Deny produces a controlled block and preserves the unexpected file", async () => {
  const { cwd, state, runner } = await generatedWorkflow([["deny"]]);
  assert.equal(state.phase, "BLOCKED");
  assert.match(
    state.blocker ?? "",
    /Contract extension denied: generated\.txt \(create\)/,
  );
  assert.equal(
    await readFile(join(cwd, "generated.txt"), "utf8"),
    "generated\n",
  );
  assert.equal(state.agentFailures, 0);
  assert.equal(runner.counts.commitAgent, undefined);
  assert.ok(
    state.history.some(
      (entry) => entry.event === "contract_extension_approval_denied",
    ),
  );
});

test("multiple files keep independent decisions and retain an earlier Include when a later file is denied", async () => {
  const cwd = await repository();
  const requests: any[] = [];
  const choices = [["include"], ["deny"]];
  const runner = new FixtureRunner(async (role) => {
    if (role === "tester") {
      await writeFile(join(cwd, "generated-a.txt"), "a\n");
      await writeFile(join(cwd, "generated-b.txt"), "b\n");
      return output(role);
    }
    return undefined;
  });
  const engine = new WorkflowEngine(cwd, runner, {
    progress: () => {},
    ask: async () => undefined,
    approve: async (request) => {
      if (request.kind !== "contractExtension") return ["allow"];
      requests.push(request);
      return choices.shift();
    },
  });
  const state = await engine.start("Generate two fixtures", config());
  await engine.run(state);
  assert.equal(state.phase, "BLOCKED");
  assert.equal(requests.length, 2);
  assert.deepEqual(
    state.workflowApprovedContractPaths.map(({ path, operation }) => ({
      path,
      operation,
    })),
    [{ path: "generated-a.txt", operation: "create" }],
  );
  assert.match(state.blocker ?? "", /generated-b\.txt \(create\)/);
  assert.equal(await readFile(join(cwd, "generated-a.txt"), "utf8"), "a\n");
  assert.equal(await readFile(join(cwd, "generated-b.txt"), "utf8"), "b\n");
});

test("dismissal remains WAITING_USER and the persisted request resumes after restart", async () => {
  const first = await generatedWorkflow([undefined]);
  assert.equal(first.state.phase, "WAITING_USER");
  assert.equal(first.state.pendingContractExtensions.length, 1);
  const requestId = first.state.pendingContractExtensions[0].requestId;
  const restarted = new WorkflowEngine(first.cwd, first.runner, {
    progress: () => {},
    ask: async () => undefined,
    approve: async (request) =>
      request.kind === "contractExtension" ? ["include"] : ["allow"],
  });
  const loaded = await restarted.store.load(first.state.id);
  assert.equal(loaded.pendingContractExtensions[0].requestId, requestId);
  await restarted.run(loaded);
  assert.equal(loaded.phase, "DONE", loaded.blocker);
  assert.equal(first.runner.counts.implementor, 1);
  assert.equal(first.runner.counts.tester, 2);
});

test("a legacy hard block is recovered into the approval flow without repeating implementation", async () => {
  const cwd = await repository();
  const runner = new FixtureRunner(async (role) => {
    if (role === "implementor") {
      await writeFile(
        join(cwd, "math.js"),
        "export const add = (a, b) => a + b;\n",
      );
      await writeFile(join(cwd, "package-lock.json"), "{}\n");
      return output(role);
    }
    return undefined;
  });
  const waiting = new WorkflowEngine(cwd, runner, {
    progress: () => {},
    ask: async () => undefined,
    approve: async (request) =>
      request.kind === "contractExtension" ? undefined : ["allow"],
  });
  const state = await waiting.start("Legacy npm install workflow", config());
  await waiting.run(state);
  assert.equal(state.phase, "WAITING_USER");
  state.pendingContractExtensions = [];
  delete state.resumePhase;
  state.phase = "BLOCKED";
  state.blocker =
    "Repository contains changes outside the Implementation Contract: package-lock.json";
  state.history.push({
    at: new Date().toISOString(),
    phase: "CODE_REVIEW",
    event: "blocked",
    detail: state.blocker,
  });
  await waiting.store.save(state);

  const restarted = new WorkflowEngine(cwd, runner, {
    progress: () => {},
    ask: async () => undefined,
    approve: async (request) =>
      request.kind === "contractExtension" ? ["include"] : ["allow"],
  });
  const loaded = await restarted.store.load(state.id);
  await restarted.continueBlocked(loaded);
  assert.equal(loaded.phase, "DONE", loaded.blocker);
  assert.equal(runner.counts.implementor, 1);
  assert.ok(
    loaded.history.some(
      (entry) => entry.event === "contract_extension_approval_granted",
    ),
  );
});

test("modify approval does not authorize a later deletion", async () => {
  const cwd = await repository();
  await writeFile(join(cwd, "extra.txt"), "before\n");
  await git(cwd, ["add", "extra.txt"]);
  await git(cwd, [
    "-c",
    "core.hooksPath=/dev/null",
    "commit",
    "-m",
    "fixture extra",
  ]);
  const engine = new WorkflowEngine(cwd, new FixtureRunner(), {
    progress: () => {},
    ask: async () => undefined,
  });
  const state = await engine.start("Change extra", config());
  state.results.reviewer = contract;
  await writeFile(join(cwd, "extra.txt"), "modified\n");
  assert.deepEqual(await unexpectedWorkflowChanges(state), [
    { path: "extra.txt", operation: "modify" },
  ]);
  state.workflowApprovedContractPaths.push({
    path: "extra.txt",
    operation: "modify",
    source: "repository_change_user_approval",
  });
  assert.deepEqual(await unexpectedWorkflowChanges(state), []);
  await unlink(join(cwd, "extra.txt"));
  assert.deepEqual(await unexpectedWorkflowChanges(state), [
    { path: "extra.txt", operation: "delete" },
  ]);
});

test("a stale Include decision is rejected when the pending operation changes", async () => {
  const cwd = await repository();
  await writeFile(join(cwd, "extra.txt"), "before\n");
  await git(cwd, ["add", "extra.txt"]);
  await git(cwd, [
    "-c",
    "core.hooksPath=/dev/null",
    "commit",
    "-m",
    "fixture extra",
  ]);
  let firstPrompt = true;
  const runner = new FixtureRunner(async (role) => {
    if (role === "implementor") {
      await writeFile(
        join(cwd, "math.js"),
        "export const add = (a, b) => a + b;\n",
      );
      await writeFile(join(cwd, "extra.txt"), "modified\n");
      return output(role);
    }
    return undefined;
  });
  const engine = new WorkflowEngine(cwd, runner, {
    progress: () => {},
    ask: async () => undefined,
    approve: async (request) => {
      if (request.kind !== "contractExtension") return ["allow"];
      if (firstPrompt) {
        firstPrompt = false;
        return undefined;
      }
      return ["include"];
    },
  });
  const state = await engine.start("Modify extra", config());
  await engine.run(state);
  assert.equal(state.pendingContractExtensions[0]?.operation, "modify");
  await unlink(join(cwd, "extra.txt"));
  const resumed = new WorkflowEngine(cwd, runner, {
    progress: () => {},
    ask: async () => undefined,
    approve: async (request) =>
      request.kind === "contractExtension" ? ["include"] : ["allow"],
  });
  const loaded = await resumed.store.load(state.id);
  await resumed.run(loaded);
  assert.equal(loaded.phase, "DONE", loaded.blocker);
  assert.equal(
    loaded.workflowApprovedContractPaths.some(
      (approval) =>
        approval.path === "extra.txt" && approval.operation === "modify",
    ),
    false,
  );
  assert.equal(
    loaded.workflowApprovedContractPaths.some(
      (approval) =>
        approval.path === "extra.txt" && approval.operation === "delete",
    ),
    true,
  );
  assert.ok(
    loaded.history.some(
      (entry) => entry.event === "contract_extension_approval_cancelled",
    ),
  );
});

test("Reviewer receives package-manager-specific lockfile guidance, including a missing npm lockfile", async () => {
  const cwd = await repository();
  await writeFile(
    join(cwd, "package.json"),
    JSON.stringify({ type: "module", packageManager: "npm@11.0.0" }),
  );
  const engine = new WorkflowEngine(cwd, new FixtureRunner(), {
    progress: () => {},
    ask: async () => undefined,
  });
  const state = await engine.start(
    "Run npm install example-package and update dependencies",
    config(),
  );
  const guidance = await packageManagerContractGuidance(state);
  const project = guidance.projects.find(
    (entry) => entry.manifest === "package.json",
  );
  assert.equal(guidance.dependencyChangeRequired, true);
  assert.equal(project?.manager, "npm");
  assert.equal(project?.lockfile, "package-lock.json");
  assert.equal(project?.lockfileExists, false);
  assert.doesNotMatch(JSON.stringify(guidance), /pnpm-lock\.yaml.*yarn\.lock/);
});

test("npm lockfile is either in the initial Contract or approved after install side effects", async (t) => {
  for (const proactive of [true, false])
    await t.test(
      proactive ? "initial Contract" : "runtime Include",
      async () => {
        const cwd = await repository();
        const requests: any[] = [];
        const runner = new FixtureRunner(async (role) => {
          if (role === "reviewer")
            return {
              ...contract,
              goal: "Install an npm dependency",
              filesToModify: ["math.js", "package.json"],
              filesToCreate: proactive ? ["package-lock.json"] : [],
            };
          if (role === "implementor") {
            await writeFile(
              join(cwd, "math.js"),
              "export const add = (a, b) => a + b;\n",
            );
            await writeFile(
              join(cwd, "package.json"),
              JSON.stringify({
                type: "module",
                dependencies: { example: "1.0.0" },
              }),
            );
            await writeFile(
              join(cwd, "package-lock.json"),
              JSON.stringify({ lockfileVersion: 3, packages: {} }),
            );
            return {
              ...output(role),
              changedFiles: ["math.js", "package.json", "package-lock.json"],
            };
          }
          return undefined;
        });
        const engine = new WorkflowEngine(cwd, runner, {
          progress: () => {},
          ask: async () => undefined,
          approve: async (request) => {
            requests.push(request);
            if (request.kind === "contractExtension") return ["include"];
            if (request.kind === "sensitivePaths") return ["allow"];
            return undefined;
          },
        });
        const state = await engine.start(
          "npm install example@1 --no-audit --no-fund",
          config(),
        );
        await engine.run(state);
        assert.equal(state.phase, "DONE", state.blocker);
        assert.equal(runner.counts.implementor, 1);
        assert.equal(
          requests.filter((request) => request.kind === "contractExtension")
            .length,
          proactive ? 0 : 1,
        );
        assert.equal(
          state.workflowApprovedContractPaths.some(
            (approval) =>
              approval.path === "package-lock.json" &&
              approval.operation === "create",
          ),
          !proactive,
        );
        assert.match(
          await git(cwd, ["show", "--format=", "--name-only", "HEAD"]),
          /package-lock\.json/,
        );
      },
    );
});
