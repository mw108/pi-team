import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
  lstat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, relative, isAbsolute } from "node:path";
import { detectSecrets } from "./secret-patterns.ts";
import { assertRelative, assertWithin } from "../agents/permissions.ts";
import { redactVisibleText } from "../agents/redaction.ts";

export interface SecretFinding {
  path: string;
  line?: number;
  kind: string;
}
export interface SecretScanResult {
  scanner: "gitleaks" | "builtin";
  findings: SecretFinding[];
}
export type ScannerRun = (executable: string, args: string[]) => Promise<void>;
const execute = promisify(execFile);
const defaultRun: ScannerRun = async (executable, args) => {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) =>
      ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL"].includes(key),
    ),
  );
  await execute(executable, args, {
    cwd: tmpdir(),
    env,
    maxBuffer: 1024 * 1024,
    timeout: 120000,
  });
};

async function relevantContent(cwd: string, paths: readonly string[]) {
  const files: { path: string; content: string }[] = [];
  for (const path of [...new Set(paths)]) {
    assertRelative(path);
    await assertWithin(cwd, path);
    try {
      const stat = await lstat(join(cwd, path));
      if (!stat.isFile()) throw new Error("Secret scan requires regular files");
      if (stat.size > 2_000_000)
        throw new Error(`Commit file too large for secret scan: ${path}`);
      files.push({ path, content: await readFile(join(cwd, path), "utf8") });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return files;
}

function builtin(files: { path: string; content: string }[]): SecretScanResult {
  const findings = files.flatMap(({ path, content }) =>
    detectSecrets(content).map((match) => ({
      path,
      line: content.slice(0, match.start).split("\n").length,
      kind: match.kind,
    })),
  );
  return { scanner: "builtin", findings };
}

/** The isolated scan directory contains only commit-intended regular files. */
export async function scanCommitSecrets(
  cwd: string,
  paths: readonly string[],
  run: ScannerRun = defaultRun,
): Promise<SecretScanResult> {
  const files = await relevantContent(cwd, paths);
  try {
    await run("gitleaks", ["version"]);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return builtin(files);
    throw new Error("Gitleaks availability check failed");
  }
  const temporary = await mkdtemp(join(tmpdir(), "pi-team-secret-scan-"));
  try {
    const scanRoot = join(temporary, "scan");
    await mkdir(scanRoot, { recursive: true, mode: 0o700 });
    for (const file of files) {
      const destination = join(scanRoot, file.path);
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
      await writeFile(destination, file.content, { mode: 0o600 });
    }
    const report = join(temporary, "report.json");
    let found = false;
    try {
      await run("gitleaks", [
        "dir",
        scanRoot,
        "--no-banner",
        "--no-color",
        "--redact=100",
        "--report-format",
        "json",
        "--report-path",
        report,
      ]);
    } catch (error) {
      if (Number((error as { code?: unknown }).code) !== 1)
        throw new Error("Gitleaks scan failed");
      found = true;
    }
    const raw = await readFile(report, "utf8").catch((error) => {
      if (!found && (error as NodeJS.ErrnoException).code === "ENOENT")
        return "[]";
      throw new Error("Gitleaks report unavailable");
    });
    let data: unknown;
    try {
      data = JSON.parse(raw || "[]");
    } catch {
      throw new Error("Gitleaks report is invalid");
    }
    if (!Array.isArray(data)) throw new Error("Gitleaks report is invalid");
    const allowed = new Set(files.map((file) => file.path));
    const findings = data.map((entry: any): SecretFinding => {
      const reported = String(entry.File ?? "");
      const path = isAbsolute(reported)
        ? relative(scanRoot, reported)
        : reported;
      if (!allowed.has(path))
        throw new Error("Gitleaks reported an unexpected file");
      return {
        path,
        ...(Number.isSafeInteger(entry.StartLine) && entry.StartLine > 0
          ? { line: entry.StartLine }
          : {}),
        kind: redactVisibleText(String(entry.RuleID ?? "secret")).slice(0, 80),
      };
    });
    if (found && !findings.length)
      throw new Error("Gitleaks found secrets without a usable report");
    return { scanner: "gitleaks", findings };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
