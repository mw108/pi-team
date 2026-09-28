import { writeFile } from "node:fs/promises";
import { config, repository, FixtureRunner } from "../tests/helpers.ts";
import { WorkflowEngine } from "../src/workflow/engine.ts";
import { ProgressRuntime } from "../src/ui/runtime.ts";
import { renderProgress } from "../src/ui/progress.ts";
import type { Role } from "../src/agents/schemas.ts";
import type { WorkflowState } from "../src/workflow/state.ts";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const runs = [];
for (const pentest of [false, true]) {
  const cwd = await repository();
  const cfg = config();
  cfg.ui.progress.refreshMs = 500;
  cfg.qualityGates.pentest.enabled = pentest;
  const frames: string[] = [];
  const runtime = new ProgressRuntime(() => {
    if (runtime.state)
      frames.push(renderProgress(runtime.state, runtime).join("\n"));
  }, cfg.ui.progress.refreshMs);
  class SlowFixtureRunner extends FixtureRunner {
    override async run(
      role: Role,
      state: WorkflowState,
      _signal?: AbortSignal,
      activity?: (toolName: string | undefined, toolCallId?: string) => void,
    ) {
      if (role === "researcher") {
        activity?.("serena_find_referencing_symbols", "fixture-tool");
        await delay(1150);
        activity?.(undefined, "fixture-tool");
      }
      if (role.startsWith("solver"))
        await delay(
          (
            { solver1: 100, solver2: 700, solver3: 1250 } as Record<
              string,
              number
            >
          )[role],
        );
      return super.run(role, state);
    }
  }
  const engine = new WorkflowEngine(cwd, new SlowFixtureRunner(), {
    progress: (state) => runtime.bind(state),
    agentEvent: (event) => runtime.event(event),
    ask: async () => undefined,
  });
  const state = await engine.start("Fix arithmetic", cfg);
  runtime.bind(state);
  const result = await engine.run(state);
  runtime.dispose();
  if (result.phase !== "DONE")
    throw new Error(`Fixture failed: ${result.phase} ${result.blocker}`);
  const evidence = {
    pentestEnabled: pentest,
    researcherActivity: frames.some((frame) =>
      frame.includes("Serena: references"),
    ),
    elapsedHeartbeat: frames.some((frame) => /● Researcher  00:01/.test(frame)),
    independentSolvers: frames.some(
      (frame) =>
        frame.includes("✓ Solver Architecture") &&
        frame.includes("● Solver Pragmatic") &&
        frame.includes("● Solver Alternative"),
    ),
    pentestDisplay: pentest
      ? frames.some((frame) => frame.includes("Pentest cycle 1/2"))
      : frames.every(
          (frame) =>
            !frame.includes("Pentest cycle") && !frame.includes("Pen Tester"),
        ),
    commit: result.commit?.hash,
  };
  if (
    !evidence.researcherActivity ||
    !evidence.elapsedHeartbeat ||
    !evidence.independentSolvers ||
    !evidence.pentestDisplay ||
    !evidence.commit
  )
    throw new Error(`Progress evidence missing: ${JSON.stringify(evidence)}`);
  runs.push(evidence);
}
const report = { at: new Date().toISOString(), remoteInference: false, runs };
await writeFile(
  "docs/progress-validation.json",
  JSON.stringify(report, null, 2) + "\n",
);
console.log(JSON.stringify(report, null, 2));
