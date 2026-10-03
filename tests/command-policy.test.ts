import { test } from "node:test";
import assert from "node:assert/strict";
import { commandSchema, configSchema } from "../src/config/schema.ts";
import { roles } from "../src/agents/schemas.ts";
import {
  allowedCommandCategories,
  commandCategories,
} from "../src/agents/command-policy.ts";
import { approvedCommandsForRole } from "../src/agents/commands.ts";
import { normalizedRuntimeCommand } from "../src/agents/runtime-commands.ts";
import { config } from "./helpers.ts";

test("configured and runtime commands reject the same forbidden executables", () => {
  for (const executable of [
    "eval",
    "/usr/bin/EVAL",
    "C:\\bin\\GiT.exe",
    "BASH",
  ]) {
    const command = {
      id: "unsafe",
      executable,
      args: [],
      purpose: "development" as const,
    };
    assert.equal(commandSchema.safeParse(command).success, false);
    assert.equal(
      configSchema.safeParse({ ...config(), commands: [command] }).success,
      false,
    );
    assert.throws(() =>
      normalizedRuntimeCommand(
        { executable, args: [], purpose: "Inspect", category: "development" },
        "implementor",
      ),
    );
  }
});

test("role category policy is shared by configured and runtime approval paths", () => {
  const commands = commandCategories.map((purpose) => ({
    id: purpose,
    executable: process.execPath,
    args: [],
    purpose,
    timeoutMs: 1000,
  }));
  const cfg = { ...config(), commands };
  for (const role of roles) {
    const configured = approvedCommandsForRole(role, cfg).map(
      (item) => item.purpose,
    );
    assert.deepEqual(configured, [...allowedCommandCategories(role)]);
    for (const purpose of commandCategories) {
      const request = {
        executable: process.execPath,
        args: [],
        purpose: "Inspect",
        category: purpose,
      };
      if (configured.includes(purpose))
        assert.equal(
          normalizedRuntimeCommand(request, role).command.purpose,
          purpose,
        );
      else
        assert.throws(
          () => normalizedRuntimeCommand(request, role),
          /not permitted/,
        );
    }
  }
});
