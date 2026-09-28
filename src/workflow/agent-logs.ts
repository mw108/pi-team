import { mkdir, open, readFile, readdir, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { roles, type Role } from "../agents/schemas.ts";
import { elapsed } from "../ui/progress.ts";
import { StateStore } from "./persistence.ts";

export type LogEvent = {
  type: string;
  at?: string;
  [key: string]: string | number | boolean | undefined;
};

export function redactVisibleText(text: string) {
  return text
    .slice(0, 65536)
    .replace(/\b(Bearer\s+)\S+/gi, "$1[REDACTED]")
    .replace(/\b(sk-[A-Za-z0-9_-]{8,})\b/g, "[REDACTED]")
    .replace(
      /\b([A-Za-z_][A-Za-z0-9_]*(?:_API_KEY|_TOKEN|_SECRET|_PASSWORD)|API_KEY|TOKEN|SECRET|PASSWORD)\s*[:=]\s*\S+/gi,
      "$1=[REDACTED]",
    )
    .replace(/\b(https?:\/\/[^\s?]+)\?\S+/gi, "$1?[REDACTED]");
}

export class AttemptLogger {
  private queue = Promise.resolve();
  constructor(readonly path: string) {}
  append(event: LogEvent) {
    const line = `${JSON.stringify({ ...event, at: event.at ?? new Date().toISOString() })}\n`;
    this.queue = this.queue
      .then(async () => {
        const file = await open(
          this.path,
          constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW,
        );
        try {
          await file.writeFile(line);
        } finally {
          await file.close();
        }
      })
      .catch(() => {});
  }
  async flush() {
    await this.queue;
  }
}

export class AgentLogStore {
  private readonly state: StateStore;
  constructor(cwd: string) {
    this.state = new StateStore(cwd);
  }
  dir(id: string) {
    this.state.path(id);
    return join(this.state.dir, `${id}.logs`);
  }
  roleDir(id: string, role: Role) {
    if (!roles.includes(role)) throw new Error("Unknown agent");
    return join(this.dir(id), role);
  }
  path(id: string, role: Role, attempt: number) {
    if (!Number.isSafeInteger(attempt) || attempt < 1)
      throw new Error("Invalid attempt");
    return join(this.roleDir(id, role), `attempt-${attempt}.jsonl`);
  }
  private async assertCanonical(path: string) {
    if ((await realpath(path)) !== path)
      throw new Error("Agent log path is a symlink");
  }
  async attempts(id: string, role: Role) {
    await this.assertCanonical(this.state.dir).catch(
      (e: NodeJS.ErrnoException) => {
        if (e.code !== "ENOENT") throw e;
      },
    );
    await this.assertCanonical(this.roleDir(id, role)).catch(
      (e: NodeJS.ErrnoException) => {
        if (e.code !== "ENOENT") throw e;
      },
    );
    const names = await readdir(this.roleDir(id, role)).catch(
      (e: NodeJS.ErrnoException) => {
        if (e.code === "ENOENT") return [];
        throw e;
      },
    );
    return names
      .flatMap((name) =>
        /^attempt-([1-9]\d*)\.jsonl$/.test(name)
          ? [Number(name.slice(8, -6))]
          : [],
      )
      .sort((a, b) => a - b);
  }
  async create(id: string, role: Role, minimumAttempt = 1) {
    await mkdir(this.roleDir(id, role), { recursive: true, mode: 0o700 });
    await this.assertCanonical(this.state.dir);
    await this.assertCanonical(this.roleDir(id, role));
    let attempt = Math.max(
      minimumAttempt,
      Math.max(0, ...(await this.attempts(id, role))) + 1,
    );
    for (;;) {
      const path = this.path(id, role, attempt);
      try {
        const file = await open(path, "wx", 0o600);
        await file.close();
        return { attempt, logger: new AttemptLogger(path) };
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        attempt++;
      }
    }
  }
  async read(id: string, role: Role, attempt: number): Promise<LogEvent[]> {
    await this.assertCanonical(this.path(id, role, attempt));
    const raw = await readFile(this.path(id, role, attempt), "utf8");
    const lines = raw.split("\n").filter(Boolean);
    return lines.flatMap((line, index) => {
      try {
        return [JSON.parse(line) as LogEvent];
      } catch {
        if (index === lines.length - 1 && !raw.endsWith("\n")) return [];
        throw new Error("Agent log contains an invalid JSONL record");
      }
    });
  }
  async overview(id: string) {
    const lines = [`Workflow ${id.slice(0, 8)}`];
    for (const role of roles) {
      const attempts = await this.attempts(id, role);
      if (!attempts.length) {
        lines.push(`${role}  pending`);
        continue;
      }
      lines.push(role);
      for (const attempt of attempts) {
        const events = await this.read(id, role, attempt);
        const last = events.at(-1);
        const status =
          last?.type === "agent_complete"
            ? "✓ completed"
            : events.some((e) => e.type === "provider_error")
              ? `✗ ${events.findLast((e) => e.type === "provider_error")?.category ?? "failed"}`
              : "● running";
        const duration = events.findLast(
          (e) => e.type === "agent_complete" || e.type === "provider_error",
        )?.durationMs;
        const runningMs =
          last?.type !== "agent_complete" &&
          !events.some((e) => e.type === "provider_error") &&
          typeof events[0]?.at === "string"
            ? Math.max(0, Date.now() - Date.parse(events[0].at))
            : undefined;
        lines.push(
          `  attempt ${attempt}  ${status}${typeof duration === "number" ? `  ${elapsed(duration)}` : typeof runningMs === "number" ? `  ${elapsed(runningMs)}` : ""}`,
        );
      }
    }
    return lines.join("\n");
  }
  async timeline(id: string, role: Role, attempt?: number) {
    const attempts = await this.attempts(id, role);
    const selected = attempt ?? attempts.at(-1);
    if (!selected || !attempts.includes(selected))
      return `No log for ${role}${attempt ? ` attempt ${attempt}` : ""}.`;
    const events = await this.read(id, role, selected);
    const lines = [`${role} · attempt ${selected}`];
    for (const event of events) {
      const time =
        typeof event.at === "string" ? event.at.slice(11, 19) : "--:--:--";
      const label =
        event.type === "agent_start"
          ? "started"
          : event.type === "tool_start"
            ? event.activity
            : event.type === "provider_error"
              ? event.label
              : event.type === "retry"
                ? `retry → attempt ${event.nextAttempt}`
                : event.type === "agent_complete"
                  ? "completed"
                  : undefined;
      if (label) lines.push(`${time} ${label}`);
    }
    if (
      !events.length ||
      !events.some(
        (e) => e.type === "provider_error" || e.type === "agent_complete",
      )
    )
      lines.push("running or interrupted; no terminal event recorded");
    return lines.join("\n");
  }
}
