import { readdir, stat } from "node:fs/promises";
import { dirname, extname, isAbsolute, resolve, win32 } from "node:path";

const windowsExecutableExtensions = new Set([".com", ".exe", ".bat", ".cmd"]);
const defaultPathExt = [".COM", ".EXE", ".BAT", ".CMD"];

export type ExecutableResolution = {
  requested: string;
  resolved?: string;
  kind?: "native" | "batch";
  source?: "path" | "explicit";
  searchedPathEntries: number;
  searchedExtensions: string[];
};

export class ExecutableResolutionError extends Error {
  readonly processStarted = false;
  constructor(
    readonly code:
      "EXECUTABLE_NOT_FOUND" | "PERMISSION_DENIED" | "UNSAFE_BATCH_ARGUMENT",
    message: string,
    readonly resolution: ExecutableResolution,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ExecutableResolutionError";
  }
}

function environmentValue(
  env: NodeJS.ProcessEnv,
  name: string,
): string | undefined {
  const entry = Object.entries(env).find(
    ([key]) => key.toLowerCase() === name.toLowerCase(),
  );
  return entry?.[1];
}

function windowsExtensions(env: NodeJS.ProcessEnv): string[] {
  const raw = environmentValue(env, "PATHEXT")?.trim();
  const configured = (raw ?? "")
    .split(";")
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => (value.startsWith(".") ? value : `.${value}`))
    .filter((value) => windowsExecutableExtensions.has(value.toLowerCase()));
  const values = raw ? configured : defaultPathExt;
  return [...new Set(values.map((value) => value.toUpperCase()))];
}

async function caseInsensitiveFile(path: string): Promise<string | undefined> {
  try {
    const info = await stat(path);
    return info.isFile() ? path : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const parent = dirname(path);
  const wanted = path.slice(parent.length + (parent.endsWith("\\") ? 0 : 1));
  const match = (await readdir(parent).catch(() => [] as string[])).find(
    (entry) => entry.toLowerCase() === wanted.toLowerCase(),
  );
  if (!match) return;
  const candidate = resolve(parent, match);
  return (await stat(candidate).catch(() => undefined))?.isFile()
    ? candidate
    : undefined;
}

function containsPathSeparator(value: string): boolean {
  return (
    /[\\/]/.test(value) ||
    /^[A-Za-z]:/.test(value) ||
    win32.isAbsolute(value) ||
    isAbsolute(value)
  );
}

/**
 * Resolve a Windows executable before process creation. Bare names are searched
 * only in PATH entries; Windows' implicit current-directory search is excluded.
 */
export async function resolveWindowsExecutable(
  requested: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<ExecutableResolution> {
  const extensions = windowsExtensions(env);
  const explicit = containsPathSeparator(requested);
  const pathEntries = explicit
    ? [cwd]
    : (environmentValue(env, "PATH") ?? "")
        .split(";")
        .map((entry) => entry.trim())
        // An empty PATH component means cwd to some launchers. Exclude it.
        .filter(Boolean)
        .map((entry) =>
          entry.length >= 2 && entry.startsWith('"') && entry.endsWith('"')
            ? entry.slice(1, -1)
            : entry,
        );
  const requestedExtension = extname(requested).toLowerCase();
  const suffixes = requestedExtension ? [""] : extensions;
  const resolution: ExecutableResolution = {
    requested,
    searchedPathEntries: pathEntries.length,
    searchedExtensions: suffixes.map((value) => value || requestedExtension),
  };
  for (const entry of pathEntries) {
    const base = explicit
      ? win32.isAbsolute(requested) || isAbsolute(requested)
        ? requested
        : resolve(cwd, requested)
      : resolve(cwd, entry, requested);
    for (const suffix of suffixes) {
      let candidate: string | undefined;
      try {
        candidate = await caseInsensitiveFile(base + suffix.toLowerCase());
        candidate ??= await caseInsensitiveFile(base + suffix.toUpperCase());
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EACCES")
          throw new ExecutableResolutionError(
            "PERMISSION_DENIED",
            `Permission denied while resolving executable: ${requested}`,
            resolution,
            { cause: error },
          );
        throw error;
      }
      if (!candidate) continue;
      const extension = extname(candidate).toLowerCase();
      return {
        ...resolution,
        resolved: candidate,
        kind: extension === ".cmd" || extension === ".bat" ? "batch" : "native",
        source: explicit ? "explicit" : "path",
      };
    }
  }
  throw new ExecutableResolutionError(
    "EXECUTABLE_NOT_FOUND",
    `Executable not found on Windows: ${requested}`,
    resolution,
  );
}

export async function resolveWindowsCommandProcessor(
  env: NodeJS.ProcessEnv,
): Promise<string> {
  const systemRoot =
    environmentValue(env, "SystemRoot") ?? environmentValue(env, "WINDIR");
  const candidates = [
    systemRoot ? resolve(systemRoot, "System32", "cmd.exe") : undefined,
    environmentValue(env, "ComSpec"),
  ].filter((value): value is string => Boolean(value));
  for (const candidate of candidates) {
    const found = await caseInsensitiveFile(candidate).catch(() => undefined);
    if (found && win32.basename(found).toLowerCase() === "cmd.exe")
      return found;
  }
  throw new ExecutableResolutionError(
    "EXECUTABLE_NOT_FOUND",
    "Windows command processor is unavailable for the approved batch launcher",
    {
      requested: "cmd.exe",
      searchedPathEntries: 0,
      searchedExtensions: [".EXE"],
    },
  );
}

/** Batch files require cmd.exe. Reject syntax with ambiguous cmd expansion. */
export function windowsBatchCommandLine(
  path: string,
  args: readonly string[],
): string {
  const values = [path, ...args];
  const unsafe = values.find((value) => /[\0\r\n"&|<>^%!]/u.test(value));
  if (unsafe !== undefined)
    throw new ExecutableResolutionError(
      "UNSAFE_BATCH_ARGUMENT",
      "The approved .cmd/.bat launcher cannot safely receive an argument containing cmd.exe metacharacters",
      {
        requested: path,
        resolved: path,
        kind: "batch",
        source: "explicit",
        searchedPathEntries: 0,
        searchedExtensions: [extname(path).toUpperCase()],
      },
    );
  return `"${values.map((value) => `"${value}"`).join(" ")}"`;
}
