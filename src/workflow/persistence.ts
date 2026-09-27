import {
  mkdir,
  open,
  rename,
  readFile,
  unlink,
  readdir,
} from "node:fs/promises";
import { join } from "node:path";
import { validateState, type WorkflowState } from "./state.ts";
export class StateStore {
  readonly dir: string;
  constructor(cwd: string) {
    this.dir = join(cwd, ".pi", "team-state");
  }
  path(id: string) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid workflow ID");
    return join(this.dir, `${id}.json`);
  }
  async save(state: WorkflowState) {
    validateState(state);
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const path = this.path(state.id),
      temp = `${path}.${process.pid}.tmp`;
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
      return validateState(JSON.parse(await readFile(this.path(id), "utf8")));
    } catch (e) {
      throw new Error(
        `Cannot load workflow ${id}; original state preserved: ${String(e)}`,
      );
    }
  }
  async latest() {
    let entries: string[];
    try {
      entries = await readdir(this.dir);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw e;
    }
    const states = await Promise.all(
      entries
        .filter((n) => /^[a-f0-9-]{36}\.json$/.test(n))
        .map((n) => this.load(n.slice(0, -5))),
    );
    return states.sort((a, b) =>
      (b.history.at(-1)?.at ?? "").localeCompare(a.history.at(-1)?.at ?? ""),
    )[0];
  }
  async lock(): Promise<() => Promise<void>> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const path = join(this.dir, "active.lock");
    try {
      const f = await open(path, "wx", 0o600);
      await f.writeFile(
        JSON.stringify({ pid: process.pid, at: new Date().toISOString() }),
      );
      await f.close();
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const old = JSON.parse(await readFile(path, "utf8"));
      try {
        process.kill(old.pid, 0);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ESRCH") {
          await unlink(path);
          return this.lock();
        }
        throw err;
      }
      throw new Error(`A workflow is already running (PID ${old.pid}).`);
    }
    return async () => {
      await unlink(path).catch(() => {});
    };
  }
}
