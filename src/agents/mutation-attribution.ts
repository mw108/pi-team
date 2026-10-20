import { assertRelative, assertWithin } from "./permissions.ts";
import { policyPath } from "./path-policy.ts";

export type FileMutationKind = "edit" | "write" | "delete";
export type ObservedFileMutation = {
  toolCallId: string;
  path: string;
  identity: string;
  kind: FileMutationKind;
};
export type MutationObserver = (
  mutation: ObservedFileMutation,
) => Promise<void>;

export class MutationStatePersistenceError extends Error {
  readonly code = "MUTATION_STATE_PERSISTENCE_FAILED";
  readonly failures = 0;
  constructor(cause: unknown) {
    super(
      "Workflow state persistence failed after a file mutation; the mutation requires recovery before execution can continue",
      { cause },
    );
    this.name = "MutationStatePersistenceError";
  }
}

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
    private readonly observerError?: (error: unknown) => void,
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
      observed = {
        toolCallId,
        path,
        identity: policyPath(path),
        kind: mutation.kind,
      };
    } catch {
      // A successful tool with an unresolvable path cannot establish ownership.
      return;
    }
    try {
      await this.observer(observed);
    } catch (error) {
      if (!this.observerError) throw error;
      this.observerError(error);
    }
  }
}
