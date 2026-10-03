import {
  mkdir,
  open,
  rename,
  readFile,
  unlink,
  readdir,
  stat,
  link,
} from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { projectRootSync } from "../config/project.ts";
import {
  sanitizeWorkflowStateText,
  validateState,
  type WorkflowState,
} from "./state.ts";
import { getErrorMessage } from "../agents/error-message.ts";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);
const ownProcessStart = new Date(
  Date.now() - process.uptime() * 1000,
).toISOString();
async function processIdentity(pid: number): Promise<string | undefined> {
  if (pid === process.pid) return ownProcessStart;
  try {
    return (
      (await exec("ps", ["-o", "lstart=", "-p", String(pid)])).stdout.trim() ||
      undefined
    );
  } catch {
    return undefined;
  }
}
async function ownerAlive(old: {
  pid?: number;
  processIdentity?: string;
}): Promise<boolean> {
  if (!Number.isSafeInteger(old.pid) || old.pid! <= 0)
    throw new Error(
      "Workflow lock has invalid owner metadata; inspect active.lock",
    );
  try {
    process.kill(old.pid!, 0);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw err;
  }
  if (old.processIdentity) {
    const current = await processIdentity(old.pid!);
    if (current && current !== old.processIdentity) return false;
  }
  return true;
}
export class StateStore {
  readonly dir: string;
  readonly legacyDir: string;
  private saveQueue = Promise.resolve();
  constructor(cwd: string) {
    const root = projectRootSync(cwd);
    this.dir = join(root, ".pi", "team", "state");
    this.legacyDir = join(root, ".pi", "team-state");
  }
  path(id: string) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid workflow ID");
    return join(this.dir, `${id}.json`);
  }
  async save(state: WorkflowState) {
    const pending = this.saveQueue.then(() => this.write(state));
    this.saveQueue = pending.catch(() => {});
    await pending;
  }
  private async write(state: WorkflowState) {
    sanitizeWorkflowStateText(state);
    validateState(state);
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const path = this.path(state.id),
      temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
    const file = await open(temp, "w", 0o600);
    try {
      await file.writeFile(JSON.stringify(state, null, 2));
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temp, path);
  }
  async load(id: string) {
    try {
      const state = validateState(
        JSON.parse(await readFile(this.path(id), "utf8")),
      );
      sanitizeWorkflowStateText(state);
      return state;
    } catch (e) {
      if (
        (e as NodeJS.ErrnoException).code === "ENOENT" &&
        existsSync(join(this.legacyDir, `${id}.json`))
      )
        throw new Error(
          `Legacy state ${id} exists at .pi/team-state/. It has no project prompt hashes and cannot be resumed automatically. Preserve and inspect it; start a new workflow after /team-init --from-global.`,
        );
      throw new Error(
        `Cannot load workflow ${id}; original state preserved: ${getErrorMessage(e)}`,
        { cause: e },
      );
    }
  }
  async latest() {
    let entries: string[];
    try {
      entries = await readdir(this.dir);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        if (
          existsSync(this.legacyDir) &&
          (await readdir(this.legacyDir)).some((n) =>
            /^[a-f0-9-]{36}\.json$/.test(n),
          )
        )
          throw new Error(
            "Legacy workflows exist at .pi/team-state/. They lack project prompt hashes and cannot be resumed automatically. Preserve and inspect them; start a new workflow after /team-init --from-global.",
          );
        return undefined;
      }
      throw e;
    }
    const candidateStats = await Promise.allSettled(
      entries
        .filter((n) => /^[a-f0-9-]{36}\.json$/.test(n))
        .map(async (name) => ({
          name,
          mtime: (await stat(join(this.dir, name))).mtimeMs,
        })),
    );
    const candidates = candidateStats.flatMap((result) =>
      result.status === "fulfilled" ? [result.value] : [],
    );
    candidates.sort(
      (a, b) => b.mtime - a.mtime || b.name.localeCompare(a.name),
    );
    for (const candidate of candidates) {
      try {
        return await this.load(candidate.name.slice(0, -5));
      } catch {
        console.warn(
          `state_candidate_skipped ${candidate.name}: invalid or unreadable state`,
        );
      }
    }
    if (
      !candidates.length &&
      existsSync(this.legacyDir) &&
      (await readdir(this.legacyDir)).some((n) =>
        /^[a-f0-9-]{36}\.json$/.test(n),
      )
    )
      throw new Error(
        "Legacy workflows exist at .pi/team-state/. They lack project prompt hashes and cannot be resumed automatically. Preserve and inspect them; start a new workflow after /team-init --from-global.",
      );
    return undefined;
  }
  async lock(): Promise<() => Promise<void>> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const path = join(this.dir, "active.lock");
    const token = randomUUID();
    const metadata = JSON.stringify({
      pid: process.pid,
      at: new Date().toISOString(),
      token,
      processIdentity: await processIdentity(process.pid),
    });
    const temp = `${path}.${token}.tmp`;
    const f = await open(temp, "wx", 0o600);
    try {
      await f.writeFile(metadata);
      await f.sync();
    } catch (error) {
      await unlink(temp).catch(() => {});
      throw error;
    } finally {
      await f.close();
    }
    try {
      await link(temp, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let old: { pid?: number; token?: string; processIdentity?: string };
      let oldText: string;
      try {
        oldText = await readFile(path, "utf8");
        old = JSON.parse(oldText);
      } catch {
        throw new Error(
          "Workflow lock has incomplete or invalid metadata; inspect active.lock",
        );
      }
      if (await ownerAlive(old))
        throw new Error(`A workflow is already running (PID ${old.pid}).`);
      const recovery = `${path}.recovery`;
      try {
        await link(temp, recovery);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
        let previous: {
          pid?: number;
          token?: string;
          processIdentity?: string;
        };
        try {
          previous = JSON.parse(await readFile(recovery, "utf8"));
        } catch {
          throw new Error(
            "Lock recovery metadata is invalid; inspect active.lock.recovery",
          );
        }
        if (await ownerAlive(previous))
          throw new Error(
            "Another process is recovering the workflow lock; retry",
          );
        const observed = await readFile(recovery, "utf8").catch(() => "");
        if (JSON.parse(observed).token !== previous.token)
          throw new Error("Lock recovery owner changed; retry");
        await unlink(recovery);
        return this.lock();
      }
      try {
        // The recovery marker serializes stale removal across contenders.
        const current = await readFile(path, "utf8").catch(() => "");
        if (current !== oldText)
          throw new Error("Workflow lock changed during recovery; retry");
        await unlink(path).catch((err) => {
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        });
        console.warn(`lock_recovered PID ${old.pid}`);
        return this.lock();
      } finally {
        const observed = await readFile(recovery, "utf8").catch(() => "");
        try {
          if (JSON.parse(observed).token === token) await unlink(recovery);
        } catch {
          /* A replacement marker is not ours. */
        }
      }
    } finally {
      await unlink(temp).catch(() => {});
    }
    return async () => {
      const current = await readFile(path, "utf8").catch(() => "");
      try {
        if (JSON.parse(current).token === token) await unlink(path);
      } catch {
        /* A replacement or corrupt lock is not ours. */
      }
    };
  }
}
