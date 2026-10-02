import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { config } from "./helpers.ts";
import { newState, record } from "../src/workflow/state.ts";
import { ProgressRuntime } from "../src/ui/runtime.ts";
import { renderLiveProgress, renderProgress } from "../src/ui/progress.ts";
import type { Role } from "../src/agents/schemas.ts";

function state() {
  const s = newState("/tmp/test", "task", config(), {
    head: null,
    dirtyPaths: [],
    status: "",
    diff: "",
    cachedDiff: "",
  });
  s.config.qualityGates.pentest.enabled = true;
  return s;
}
function complete(s: ReturnType<typeof state>, role: Role, attempt = 1) {
  s.results[role] = { completed: true };
  record(s, "agent_attempt_completed", role, { agent: role, attempt });
}
test("sequential live widget shows recent completions, current agent and next step", () => {
  const s = state();
  for (const role of [
    "orchestrator",
    "researcher",
    "implementor",
    "codeReviewer",
    "pentester",
  ] as const)
    complete(s, role);
  s.phase = "SECURITY_REVIEW";
  const runtime = new ProgressRuntime(() => {}, 2000, Date.now, false);
  runtime.bind(s);
  runtime.event({ type: "start", role: "securityReviewer", attempt: 1 });
  const live = renderLiveProgress(s, runtime).join("\n");
  assert.match(live, /✓ Code Reviewer/);
  assert.match(live, /✓ Pen Tester/);
  assert.match(live, /● Security Reviewer/);
  assert.match(live, /Next: Tester/);
  assert.doesNotMatch(live, /Orchestrator|Researcher|Implementor/);
  assert.match(renderProgress(s, runtime).join("\n"), /Orchestrator/);
  assert.match(renderProgress(s, runtime).join("\n"), /○ Commit Agent/);
  runtime.dispose();
});
test("parallel Solvers stay visible under a short widget budget", () => {
  const s = state();
  complete(s, "orchestrator");
  complete(s, "researcher");
  s.phase = "SOLVE";
  const runtime = new ProgressRuntime(() => {}, 2000, Date.now, false);
  runtime.bind(s);
  runtime.event({
    type: "start",
    role: "solver1",
    attempt: 2,
    retryNumber: 1,
    trigger: "manual_retry",
  });
  runtime.event({ type: "start", role: "solver2", attempt: 1 });
  const live = renderLiveProgress(s, runtime, 6).join("\n");
  assert.match(live, /● Solver Architecture.*run 2 · retry 1/);
  assert.match(live, /● Solver Pragmatic/);
  assert.match(live, /Next: Critic/);
  assert.doesNotMatch(live, /✓ Orchestrator/);
  runtime.dispose();
});
test("waiting command approval remains visible without a provider request", () => {
  const s = state();
  s.phase = "IMPLEMENT";
  s.pendingRuntimeCommands.push({
    workflowId: s.id,
    agentId: "implementor",
    run: 1,
    requestId: randomUUID(),
    command: {
      id: "routes",
      executable: "php",
      args: ["artisan", "route:list"],
      purpose: "development",
      timeoutMs: 1000,
    },
    purpose: "Inspect routes",
  });
  const live = renderLiveProgress(s).join("\n");
  assert.match(live, /◉ Implementor.*waiting for command approval/);
  assert.match(live, /php artisan route:list/);
});
test("blocked widget drops completed history before the blocker under a short budget", () => {
  const s = state();
  for (const role of [
    "orchestrator",
    "researcher",
    "codeReviewer",
    "pentester",
  ] as const)
    complete(s, role);
  s.results.pentester = {
    status: "BLOCKED",
    findings: [],
    coverage: ["Static review"],
    limitations: [],
    blocker: {
      code: "NO_AUTHORIZED_HTTP_ORIGIN",
      message: "No local origin is authorized.",
    },
  };
  s.phase = "BLOCKED";
  s.blocker = "Pentest blocked: No local origin is authorized.";
  const live = renderLiveProgress(s, undefined, 6).join("\n");
  assert.match(live, /✗ Pen Tester/);
  assert.match(live, /No local origin is authorized/);
  assert.match(live, /\/team-retry pentester/);
  assert.doesNotMatch(live, /Orchestrator|Researcher|Code Reviewer/);
  assert.match(renderProgress(s).join("\n"), /✗ Pen Tester/);
});
