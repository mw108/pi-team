import { test } from "node:test";
import assert from "node:assert/strict";
import { repository, output, config } from "./helpers.ts";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import YAML from "yaml";
import teamExtension from "../src/index.ts";
import { PiRunner } from "../src/agents/runner.ts";
import { AgentLogStore } from "../src/workflow/agent-logs.ts";
import { StateStore } from "../src/workflow/persistence.ts";
import type { Role } from "../src/agents/schemas.ts";

async function until(predicate: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > deadline)
      throw new Error("Timed out waiting for workflow");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

for (const control of ["steer", "abort", "stop"] as const)
  test(`/team releases dispatch and /team-${control} reaches the active workflow`, async () => {
    const cwd = await repository();
    await writeFile(join(cwd, ".pi/team/team.yaml"), YAML.stringify(config()));
    const commands = new Map<string, any>();
    const notices: string[] = [];
    const steers: string[] = [];
    let entered = false;
    let aborted = false;
    const original = PiRunner.prototype.run;
    PiRunner.prototype.run = async function (
      role: Role,
      state,
      signal,
      _activity,
      _attempt,
      _output,
      _network,
      registry,
    ) {
      if (role !== "researcher") return output(role);
      const entry = {
        workflowId: state.id,
        agentId: role,
        attempt: 1,
        startedAt: Date.now(),
        state: "running" as const,
        session: {
          async steer(message: string) {
            steers.push(message);
          },
          getSteeringMessages() {
            return [];
          },
        },
      };
      registry?.register(entry as any);
      entered = true;
      try {
        await new Promise<never>((_resolve, reject) => {
          const cancel = () => {
            aborted = true;
            reject(new Error("terminated"));
          };
          if (signal?.aborted) cancel();
          else signal?.addEventListener("abort", cancel, { once: true });
        });
      } finally {
        registry?.remove(entry as any);
      }
    } as typeof PiRunner.prototype.run;
    try {
      teamExtension({
        on: () => {},
        registerCommand: (name: string, command: any) =>
          commands.set(name, command),
        appendEntry: () => {},
      } as any);
      const ctx = {
        cwd,
        waitForIdle: async () => {},
        ui: {
          notify: (message: string) => notices.push(message),
          setStatus: () => {},
          setWidget: () => {},
        },
      };
      await commands.get("team").handler("Fix addition", ctx);
      await until(() => entered || notices.length > 0);
      assert.equal(entered, true, notices.join("\n"));
      await commands.get("team").handler("Duplicate", ctx);
      assert.match(notices.at(-1) ?? "", /already active/);
      if (control === "steer") {
        await commands
          .get("team-steer")
          .handler("researcher Focus on the result", ctx);
        assert.deepEqual(steers, ["Focus on the result"]);
        const state = await new StateStore(cwd).latest();
        const events = await new AgentLogStore(cwd).read(
          state!.id,
          "researcher",
          1,
        );
        assert.ok(
          events.some((event) => event.type === "agent_steer_requested"),
        );
        await commands.get("team-stop").handler("", ctx);
      } else if (control === "abort") {
        await commands.get("team-abort").handler("researcher", ctx);
      } else {
        await commands.get("team-stop").handler("", ctx);
      }
      await until(() => aborted);
      await until(() =>
        notices.some((notice) =>
          /Team BLOCKED|Next action|Agent execution failed|interruption/i.test(
            notice,
          ),
        ),
      );
    } finally {
      PiRunner.prototype.run = original;
    }
  });
