import { open, lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { parse as parseYaml } from "yaml";
import {
  commandSchema,
  type DiscoveredCommand,
  type Command,
} from "../config/schema.ts";
import { assertWithin } from "./permissions.ts";
import type { WorkflowState } from "../workflow/state.ts";
export function commandKey(c: Pick<Command, "executable" | "args">) {
  return JSON.stringify([c.executable, c.args]);
}
export function detectedCommandId(c: Pick<Command, "executable" | "args">) {
  return (
    "detected-" +
    createHash("sha256").update(commandKey(c)).digest("hex").slice(0, 12)
  );
}
export function effectiveConfig(s: WorkflowState) {
  const config = {
    ...s.config,
    commands: [...s.config.commands, ...(s.approvedCommands ?? [])].filter(
      (c, i, all) =>
        all.findIndex((other) => commandKey(other) === commandKey(c)) === i,
    ),
  };
  if (
    new Set(config.commands.map((command) => command.id)).size !==
    config.commands.length
  )
    throw new Error(
      "Approved command ID conflicts with configured command ID; choose distinct configured IDs",
    );
  return config;
}
export async function discoverCommands(
  cwd: string,
): Promise<DiscoveredCommand[]> {
  const found: DiscoveredCommand[] = [];
  const read = async (path: string) => {
    try {
      await assertWithin(cwd, path);
      const filePath = join(cwd, path),
        info = await lstat(filePath);
      if (!info.isFile() || info.size > 262144) return undefined;
      const file = await open(filePath, "r");
      try {
        const bytes = Buffer.alloc(262145);
        const result = await file.read(bytes, 0, bytes.length, 0);
        return result.bytesRead <= 262144
          ? bytes.subarray(0, result.bytesRead).toString("utf8")
          : undefined;
      } finally {
        await file.close();
      }
    } catch {
      return undefined;
    }
  };
  function add(
    executable: string,
    args: string[],
    source: string,
    category: DiscoveredCommand["category"],
    confidence: DiscoveredCommand["confidence"] = "high",
  ) {
    const id = detectedCommandId({ executable, args });
    const value = commandSchema.safeParse({
      id,
      executable,
      args,
      purpose: category === "test" ? "test" : "static",
      timeoutMs: 120000,
    });
    if (
      value.success &&
      !found.some((c) => commandKey(c.command) === commandKey(value.data))
    )
      found.push({ command: value.data, source, category, confidence });
  }
  function category(name: string): DiscoveredCommand["category"] | undefined {
    if (/^(test|tests)(?:[:_-]|$)/.test(name) && !/watch/.test(name))
      return "test";
    if (/^(typecheck|type-check|check-types|tsc)$/.test(name))
      return "typecheck";
    if (/^lint(?:[:_-]check)?$/.test(name)) return "lint";
    if (/^(build|compile)$/.test(name)) return "build";
    if (/^(format[:_-]check|check[:_-]format)$/.test(name))
      return "format-check";
    if (/^(check|analyse|analyze|static-analysis)$/.test(name))
      return "static-analysis";
  }
  for (const file of ["package.json", "composer.json"]) {
    try {
      const doc = JSON.parse((await read(file)) ?? "");
      if (
        doc.scripts &&
        typeof doc.scripts === "object" &&
        !Array.isArray(doc.scripts)
      )
        for (const [name, value] of Object.entries(doc.scripts)) {
          const purpose = category(name);
          if (
            purpose &&
            /^[\w:-]+$/.test(name) &&
            (typeof value === "string" ||
              (file === "composer.json" &&
                Array.isArray(value) &&
                value.every((v) => typeof v === "string")))
          )
            add(
              file === "package.json" ? "npm" : "composer",
              file === "package.json" && name === "test"
                ? ["test"]
                : ["run", name],
              `${file} scripts.${name}`,
              purpose,
            );
        }
    } catch {
      /* malformed repository data is not an instruction */
    }
  }
  const cargo = await read("Cargo.toml");
  if (
    cargo &&
    /^\[package\]/m.test(cargo) &&
    /^name\s*=\s*"[^"\n]+"/m.test(cargo)
  ) {
    add("cargo", ["test"], "Cargo.toml", "test");
    add("cargo", ["clippy"], "Cargo.toml", "static-analysis");
  }
  const go = await read("go.mod");
  if (go && /^module\s+\S+/m.test(go))
    add("go", ["test", "./..."], "go.mod", "test");
  const py = await read("pyproject.toml");
  if (py && /^\[tool\.pytest\.ini_options\]/m.test(py))
    add(
      "python3",
      ["-m", "pytest"],
      "pyproject.toml [tool.pytest.ini_options]",
      "test",
    );
  for (const file of ["phpunit.xml", "phpunit.xml.dist"])
    if ((await read(file))?.includes("<phpunit"))
      add("vendor/bin/phpunit", [], file, "test", "medium");
  for (const file of ["Makefile", "justfile"]) {
    const text = await read(file);
    if (text)
      for (const line of text.split("\n")) {
        const match = line.match(/^([\w-]+)\s*:/);
        if (match) {
          const purpose = category(match[1]);
          if (purpose)
            add(
              file === "Makefile" ? "make" : "just",
              [match[1]],
              `${file} target ${match[1]}`,
              purpose,
              "medium",
            );
        }
      }
  }
  for (const file of ["Taskfile.yml", "Taskfile.yaml"])
    try {
      const doc = parseYaml((await read(file)) ?? "");
      if (doc?.tasks)
        for (const name of Object.keys(doc.tasks)) {
          const purpose = category(name);
          if (purpose && /^[\w:-]+$/.test(name))
            add("task", [name], `${file} tasks.${name}`, purpose, "medium");
        }
    } catch {}
  // Documentation/CI contributes only recognized argv forms, never arbitrary shell text.
  const files = (await readdir(cwd).catch(() => [])).filter((v) =>
    /^(README|CONTRIBUTING)(?:\.|$)/i.test(v),
  );
  files.push(
    ".gitlab-ci.yml",
    ...(await readdir(join(cwd, ".github/workflows")).catch(() => []))
      .filter((v) => /\.ya?ml$/.test(v))
      .map((v) => ".github/workflows/" + v),
  );
  for (const file of files) {
    const text = await read(file);
    if (!text) continue;
    for (const line of text.split("\n")) {
      const m = line
        .trim()
        .match(
          /^(?:(?:-\s*)?run:\s*|\$\s*)?(npm (?:test|run [\w:-]+)|composer (?:run )?[\w:-]+|cargo (?:test|clippy)|go test \.\/\.\.\.)$/,
        );
      if (m) {
        const [exe, ...args] = m[1].split(" "),
          purpose =
            exe === "cargo"
              ? args[0] === "test"
                ? "test"
                : "static-analysis"
              : exe === "go"
                ? "test"
                : category(args.at(-1) ?? "");
        if (purpose) add(exe, args, file, purpose, "low");
      }
    }
  }
  return found;
}
