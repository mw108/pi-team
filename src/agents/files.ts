import { unlink, lstat } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Contract } from "./schemas.ts";
import { assertRelative, assertWithin } from "./permissions.ts";
export function deleteTool(cwd: string, contract?: Contract): ToolDefinition {
  return {
    name: "team_delete",
    label: "Delete approved file",
    description:
      "Delete one regular file explicitly listed in filesToDelete of the approved implementation contract.",
    parameters: Type.Object({ path: Type.String() }),
    async execute(_id, params) {
      const path = (params as { path: string }).path;
      assertRelative(path);
      await assertWithin(cwd, path);
      if (!contract?.filesToDelete.includes(path))
        throw new Error("Deletion is outside the contract");
      if (!(await lstat(join(cwd, path))).isFile())
        throw new Error("Only regular contract files may be deleted");
      await unlink(join(cwd, path));
      return {
        content: [{ type: "text", text: `Deleted ${path}` }],
        details: { path },
      };
    },
  };
}
