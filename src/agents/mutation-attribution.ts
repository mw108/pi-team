import { assertRelative, assertWithin } from "./permissions.ts";
import { policyPath } from "./path-policy.ts";

export type FileMutationKind = "edit" | "write" | "delete";
export type ObservedFileMutation = {
  path: string;
  identity: string;
  kind: FileMutationKind;
};
export type MutationObserver = (
  mutation: ObservedFileMutation,
) => Promise<void>;

const mutationKinds: Record<string, FileMutationKind> = {
  edit: "edit",
  write: "write",
  team_delete: "delete",
};

/** Matches a successful completion to its trusted tool start, never model prose. */
export class FileMutationTracker {
  private pending = new Map<string, { path: string; kind: FileMutationKind }>();
  constructor(
    private readonly cwd: string,
    private readonly observer: MutationObserver,
  ) {}
  start(toolCallId: string, toolName: string, args: unknown) {
    const kind = mutationKinds[toolName];
    const path = (args as { path?: unknown } | null)?.path;
    if (kind && typeof path === "string")
      this.pending.set(toolCallId, { path, kind });
  }
  async end(toolCallId: string, isError: boolean) {
    const mutation = this.pending.get(toolCallId);
    this.pending.delete(toolCallId);
    if (!mutation || isError) return;
    let observed: ObservedFileMutation;
    try {
      assertRelative(mutation.path);
      const path = await assertWithin(this.cwd, mutation.path);
      if (policyPath(path) !== policyPath(mutation.path)) return;
      observed = { path, identity: policyPath(path), kind: mutation.kind };
    } catch {
      // A successful tool with an unresolvable path cannot establish ownership.
      return;
    }
    await this.observer(observed);
  }
}
