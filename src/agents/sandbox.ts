import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, realpathSync, statSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  delimiter,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import type { Command, TeamConfig } from "../config/schema.ts";
import { commandNetworkPolicy } from "./command-policy.ts";

export type SandboxDetails = {
  mode: "bubblewrap" | "constrained-host" | "none";
  network: "deny" | "allow" | "host";
  temporaryHome: boolean;
  filesystemIsolation: boolean;
};

export class SandboxUnavailableError extends Error {
  readonly code = "SANDBOX_UNAVAILABLE";
  constructor(message: string) {
    super(message);
    this.name = "SandboxUnavailableError";
  }
}

export class SandboxSetupError extends Error {
  readonly code = "SANDBOX_SETUP_FAILED";
  readonly sandboxMode = "bubblewrap";
  readonly sandboxSetup = "failed";
  constructor(
    message: string,
    readonly reason?: "unsafe_internal_path",
    readonly path?: string,
  ) {
    super(message);
    this.name = "SandboxSetupError";
  }
}

/** Bubblewrap's own startup errors are infrastructure failures, not test results. */
export function sandboxSetupFailure(
  sandbox: SandboxDetails,
  exitCode: number | null,
  stderr: string,
  timedOut: boolean,
): SandboxSetupError | undefined {
  if (
    sandbox.mode === "bubblewrap" &&
    exitCode !== 0 &&
    !timedOut &&
    /^bwrap: /m.test(stderr)
  )
    return new SandboxSetupError(
      `Bubblewrap setup failed: ${stderr.slice(-1000)}`,
    );
}

export interface PreparedExecution {
  executable: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  sandbox: SandboxDetails;
  cleanup(): Promise<void>;
}

function baseEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        key === "PATH" ||
        key === "LANG" ||
        key === "TERM" ||
        /^LC_[A-Z_]+$/.test(key),
    ),
  );
}

/** A repository-controlled PATH entry must never be able to replace the sandbox backend. */
function bubblewrapExecutable(): string | undefined {
  if (process.platform !== "linux") return;
  for (const entry of (process.env.PATH ?? "").split(delimiter)) {
    if (!entry || !entry.startsWith(sep)) continue;
    try {
      const path = realpathSync(join(entry, "bwrap"));
      if (!statSync(path).isFile()) continue;
      for (let part = path; ; part = dirname(part)) {
        const stat = statSync(part);
        if (stat.uid !== 0 || (stat.mode & 0o022) !== 0)
          throw new Error("Untrusted Bubblewrap path");
        if (part === sep) break;
      }
      return path;
    } catch {
      // Continue to the next PATH entry.
    }
  }
}

/** A real namespace probe also catches systems where unprivileged namespaces are disabled. */
export function bubblewrapAvailable(
  network: "deny" | "allow" = "deny",
): boolean {
  const executable = bubblewrapExecutable();
  if (!executable) return false;
  const probe = spawnSync(
    executable,
    [
      "--die-with-parent",
      "--unshare-user",
      "--unshare-pid",
      "--unshare-ipc",
      "--unshare-uts",
      ...(network === "deny" ? ["--unshare-net"] : []),
      "--ro-bind",
      "/",
      "/",
      "--",
      "/bin/true",
    ],
    { env: baseEnvironment(), stdio: "ignore", timeout: 3000 },
  );
  return probe.status === 0 && !probe.error;
}

function trustedAvailableBubblewrap(network: "deny" | "allow") {
  const executable = bubblewrapExecutable();
  return executable && bubblewrapAvailable(network) ? executable : undefined;
}

function mountParents(path: string): string[] {
  const parents: string[] = [];
  for (let current = dirname(path); current !== sep; current = dirname(current))
    parents.unshift(current);
  return parents.flatMap((parent) => ["--dir", parent]);
}

type InternalPaths = { team: boolean; state: boolean; agents: boolean };

/** All mount targets must be real directories inside the canonical repository. */
export function validateSandboxInternalPaths(cwd: string): InternalPaths {
  const repo = resolve(cwd);
  const unsafe = (path: string) =>
    new SandboxSetupError(
      `Sandbox setup failed: unsafe Pi-Team internal path structure (${path})`,
      "unsafe_internal_path",
      path,
    );
  let canonicalRepo: string;
  try {
    canonicalRepo = realpathSync(repo);
  } catch {
    throw new SandboxSetupError(
      "Sandbox setup failed: repository path is unavailable",
    );
  }
  const check = (name: string): boolean => {
    const path = join(repo, name);
    let entry: ReturnType<typeof lstatSync>;
    try {
      entry = lstatSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw unsafe(name);
    }
    try {
      if (entry.isSymbolicLink() || !entry.isDirectory()) throw unsafe(name);
      const canonical = realpathSync(path);
      const location = relative(canonicalRepo, canonical);
      if (
        location === ".." ||
        location.startsWith(`..${sep}`) ||
        isAbsolute(location)
      )
        throw unsafe(name);
      return true;
    } catch (error) {
      if (error instanceof SandboxSetupError) throw error;
      throw unsafe(name);
    }
  };
  const pi = check(".pi");
  const team = check(".pi/team");
  const state = check(".pi/team/state");
  const agents = check(".pi/team/agents");
  if ((!pi && team) || (!team && (state || agents)))
    throw unsafe(!pi ? ".pi" : ".pi/team");
  return { team, state, agents };
}

/** Build one argv-only bwrap invocation; never bind the real home or other projects. */
export function bubblewrapArgs(
  command: Command,
  cwd: string,
  network: "deny" | "allow",
): string[] {
  const repo = resolve(cwd);
  const internal = validateSandboxInternalPaths(repo);
  const args = [
    "--die-with-parent",
    "--unshare-user",
    "--unshare-pid",
    "--unshare-ipc",
    "--unshare-uts",
    ...(network === "deny" ? ["--unshare-net"] : []),
  ];
  for (const root of ["/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc"])
    if (existsSync(root)) args.push("--ro-bind", root, root);
  args.push("--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp");
  args.push(...mountParents(repo), "--bind", repo, repo);
  const team = join(repo, ".pi", "team");
  if (internal.team) {
    args.push("--ro-bind", team, team);
    if (internal.state) args.push("--tmpfs", join(team, "state"));
    if (internal.agents) args.push("--tmpfs", join(team, "agents"));
  }
  args.push("--dir", "/tmp/home", "--dir", "/tmp/work");
  args.push("--chdir", repo, "--", command.executable, ...command.args);
  return args;
}

/** Auto falls back visibly; required never executes on the host. */
export async function prepareExecution(
  command: Command,
  cwd: string,
  config: TeamConfig["execution"]["sandbox"],
  availableBackend: (
    network: "deny" | "allow",
  ) => string | undefined = trustedAvailableBubblewrap,
): Promise<PreparedExecution> {
  const network = commandNetworkPolicy(
    command.purpose,
    config.network,
    config.pentestNetwork,
  );
  const executable =
    config.mode === "none" ? undefined : availableBackend(network);
  const supported = Boolean(executable);
  if (config.mode === "required" && !supported)
    throw new SandboxUnavailableError(
      "Sandbox required, but Bubblewrap with unprivileged namespaces is unavailable",
    );
  const root = await mkdtemp(join(tmpdir(), "pi-team-command-"));
  const home = join(root, "home");
  const temp = join(root, "tmp");
  try {
    await mkdir(home);
    await mkdir(temp);
    const env = baseEnvironment();
    const sandbox: SandboxDetails = supported
      ? {
          mode: "bubblewrap",
          network,
          temporaryHome: true,
          filesystemIsolation: true,
        }
      : {
          mode: config.mode === "none" ? "none" : "constrained-host",
          network: "host",
          temporaryHome: true,
          filesystemIsolation: false,
        };
    env.HOME = supported ? "/tmp/home" : home;
    env.USERPROFILE = env.HOME;
    env.TMPDIR = env.TMP = env.TEMP = supported ? "/tmp/work" : temp;
    env.XDG_CONFIG_HOME = join(env.HOME, ".config");
    env.XDG_CACHE_HOME = join(env.HOME, ".cache");
    return {
      executable: supported ? executable! : command.executable,
      args: supported ? bubblewrapArgs(command, cwd, network) : command.args,
      cwd,
      env,
      sandbox,
      cleanup: () => rm(root, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}
