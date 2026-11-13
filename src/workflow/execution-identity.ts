import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID, createHash } from "node:crypto";
import { readFile, readlink } from "node:fs/promises";
import { hostname } from "node:os";
import { z } from "zod";

export const processIdentitySchema = z.object({
  pid: z.number().int().positive().safe().max(2147483647),
  host: z.string(),
  boot: z.string().optional(),
  creation: z.string().optional(),
  group: z.boolean().default(false),
});
export type ProcessIdentity = z.infer<typeof processIdentitySchema>;
export const executionIdentitySchema = z.object({
  id: z.string().uuid(),
  workflowId: z.string().uuid(),
  agent: z.enum(["pentester", "tester"]),
  attempt: z.number().int().positive(),
  status: z.enum([
    "RESERVED",
    "STARTING",
    "RUNNING",
    "COMPLETED",
    "INTERRUPTED",
    "UNKNOWN",
  ]),
  owner: processIdentitySchema.optional(),
  sessionId: z.string().optional(),
  children: z
    .array(
      z.object({
        id: z.string().uuid(),
        commandId: z.string().optional(),
        status: z.enum([
          "RESERVED",
          "STARTING",
          "RUNNING",
          "TERMINATED",
          "UNKNOWN",
        ]),
        process: processIdentitySchema.optional(),
        exitCode: z.number().nullable().optional(),
      }),
    )
    .default([]),
});
export type ExecutionIdentity = z.infer<typeof executionIdentitySchema>;
const digest = (s: string) => createHash("sha256").update(s).digest("hex");
async function hostIdentity() {
  return digest(
    (await readFile("/etc/machine-id", "utf8").catch(() => hostname())) +
      (await readlink("/proc/self/ns/pid").catch(() => "unknown-namespace")),
  );
}
async function proc(pid: number) {
  const raw = await readFile(`/proc/${pid}/stat`, "utf8");
  const fields = raw.slice(raw.lastIndexOf(")") + 2).split(" ");
  if (!/^\d+$/.test(fields[19] ?? "") || !/^\d+$/.test(fields[2] ?? ""))
    throw new Error("Malformed process identity");
  return {
    creation: fields[19],
    group: Number(fields[2]),
    zombie: fields[0] === "Z",
  };
}
export async function captureProcessIdentity(
  pid = process.pid,
  group = false,
): Promise<ProcessIdentity> {
  const identity: ProcessIdentity = { pid, host: await hostIdentity(), group };
  if (process.platform !== "linux") return identity;
  try {
    identity.boot = (
      await readFile("/proc/sys/kernel/random/boot_id", "utf8")
    ).trim();
    identity.creation = (await proc(pid)).creation;
  } catch {
    /* Spawn/exit races retain incomplete identity, never invented termination. */
  }
  return identity;
}
export type ProcessStatus = {
  status: "ACTIVE" | "TERMINATED" | "UNKNOWN";
  reason: string;
};
export interface ProcessInspector {
  host(): Promise<string>;
  boot(): Promise<string>;
  process(
    pid: number,
  ): Promise<{ creation: string; group: number; zombie: boolean }>;
  groupActive(pid: number): Promise<boolean>;
}
const inspector: ProcessInspector = {
  host: hostIdentity,
  boot: async () =>
    (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim(),
  process: proc,
  groupActive: async (pid) => {
    try {
      process.kill(-pid, 0);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
      throw error;
    }
  },
};
export async function verifyProcessIdentity(
  identity?: ProcessIdentity,
  api: ProcessInspector = inspector,
): Promise<ProcessStatus> {
  const result = (
    status: ProcessStatus["status"],
    reason: string,
  ): ProcessStatus => ({ status, reason });
  if (!identity?.creation || !identity.boot)
    return result(
      "UNKNOWN",
      "Process creation identity or supported verification API unavailable.",
    );
  if (
    api === inspector &&
    (!/^\d+$/.test(identity.creation) ||
      !/^[a-f0-9-]{36}$/i.test(identity.boot))
  )
    return result(
      "UNKNOWN",
      "Stored process creation or boot identity is malformed.",
    );
  try {
    if ((await api.host()) !== identity.host)
      return result("UNKNOWN", "Execution belongs to another host.");
    if ((await api.boot()) !== identity.boot)
      return result("TERMINATED", "Original host boot ended.");
    let p;
    try {
      p = await api.process(identity.pid);
    } catch (error) {
      if (
        !["ENOENT", "ESRCH"].includes(
          (error as NodeJS.ErrnoException).code ?? "",
        )
      )
        throw error;
      return identity.group && (await api.groupActive(identity.pid))
        ? result(
            "UNKNOWN",
            "Recorded process group still exists after leader disappearance; ancestry cannot be proven.",
          )
        : result(
            "TERMINATED",
            "Original process and its recorded group are absent.",
          );
    }
    if (p.creation !== identity.creation)
      return identity.group
        ? result(
            "UNKNOWN",
            "PID reused; original process-group termination cannot be established.",
          )
        : result(
            "TERMINATED",
            "PID reused with a different creation identity.",
          );
    if (p.zombie)
      return identity.group && (await api.groupActive(identity.pid))
        ? result("UNKNOWN", "Process group remains present after leader exit.")
        : result("TERMINATED", "Original process exited (zombie).");
    return result(
      "ACTIVE",
      "PID and creation identity match on the original host boot.",
    );
  } catch {
    return result(
      "UNKNOWN",
      "Process inspection failed or permission was denied.",
    );
  }
}
export async function inspectExecution(
  execution?: ExecutionIdentity,
): Promise<ProcessStatus> {
  if (!execution)
    return {
      status: "UNKNOWN",
      reason: "Legacy attempt has no durable execution identity.",
    };
  const owner = await verifyProcessIdentity(execution.owner);
  const children = await Promise.all(
    execution.children.map(async (child) =>
      child.status === "TERMINATED" &&
      child.exitCode !== undefined &&
      !child.process?.group
        ? {
            status: "TERMINATED" as const,
            reason:
              "Direct child exit was durably observed; detached descendants are outside this proof.",
          }
        : child.process
          ? verifyProcessIdentity(child.process)
          : child.status === "RESERVED"
            ? {
                status: "TERMINATED" as const,
                reason: "Spawn was not entered for this reserved command.",
              }
            : {
                status: "UNKNOWN" as const,
                reason:
                  "Child startup may have occurred before process identity persistence.",
              },
    ),
  );
  if (
    owner.status === "ACTIVE" &&
    execution.status !== "COMPLETED" &&
    execution.status !== "INTERRUPTED"
  )
    return owner;
  if (children.some((p) => p.status === "ACTIVE"))
    return {
      status: "ACTIVE",
      reason: "A recorded command process or group is still active.",
    };
  if (children.some((p) => p.status === "UNKNOWN"))
    return {
      status: "UNKNOWN",
      reason: "At least one child execution has uncertain process status.",
    };
  if (execution.status === "COMPLETED" || execution.status === "INTERRUPTED")
    return {
      status: "TERMINATED",
      reason:
        "In-process runner completion is durable; recorded children have no live or uncertain processes.",
    };
  return owner;
}
export type ExecutionContext = {
  update(change: (execution: ExecutionIdentity) => void): Promise<void>;
};
export const executionContext = new AsyncLocalStorage<
  ExecutionContext | undefined
>();
/** Descendant async callbacks retain ALS, so explicitly expire mutation authority. */
export async function runWithExecutionContext<T>(
  context: ExecutionContext | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  if (!context) return operation();
  let open = true;
  const scoped: ExecutionContext = {
    update: async (change) => {
      if (!open)
        throw new Error("Execution context expired; state mutation refused");
      await context.update(change);
    },
  };
  try {
    return await executionContext.run(scoped, operation);
  } finally {
    open = false;
  }
}
export async function reserveChild(id = randomUUID(), commandId?: string) {
  const context = executionContext.getStore();
  if (!context) return undefined;
  await context.update((e) => {
    e.children.push({ id, commandId, status: "RESERVED" });
  });
  return {
    id,
    async update(
      status: ExecutionIdentity["children"][number]["status"],
      process?: ProcessIdentity,
      exitCode?: number | null,
    ) {
      await context.update((e) => {
        const child = e.children.find((c) => c.id === id)!;
        child.status = status;
        if (process) child.process = process;
        if (exitCode !== undefined) child.exitCode = exitCode;
      });
    },
  };
}
