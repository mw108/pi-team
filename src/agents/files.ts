import { unlink, lstat } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  assertRelative,
  assertWithin,
  type ContractOperation,
} from "./permissions.ts";
export function deleteTool(
  cwd: string,
  consumeAuthorization: (toolCallId: string, path: string) => boolean,
): ToolDefinition {
  return {
    name: "team_delete",
    label: "Delete approved file",
    description:
      "Delete one regular file authorized by the implementation contract or an explicit user scope approval.",
    parameters: Type.Object({ path: Type.String() }),
    async execute(id, params) {
      const path = (params as { path: string }).path;
      assertRelative(path);
      await assertWithin(cwd, path);
      if (!consumeAuthorization(id, path))
        throw new Error("Deletion requires an approved tool call");
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
export function contractPathRequestTool(
  request: (
    operation: ContractOperation,
    path: string,
    reason: string,
  ) => Promise<boolean>,
): ToolDefinition {
  return {
    name: "team_request_contract_path",
    label: "Request contract path",
    description:
      "Request user authorization for one repository file outside the implementation contract. Supply the exact path, intended create/modify/delete operation, and a concise reason. Approval is decided by the host and user.",
    parameters: Type.Object({
      path: Type.String(),
      operation: Type.Union([
        Type.Literal("create"),
        Type.Literal("modify"),
        Type.Literal("delete"),
      ]),
      reason: Type.String(),
    }),
    async execute(_id, params) {
      const { path, operation, reason } = params as {
        path: string;
        operation: ContractOperation;
        reason: string;
      };
      const allowed = await request(operation, path, reason);
      return {
        content: [
          {
            type: "text",
            text: allowed
              ? `Authorized ${operation} ${path}. Retry the matching mutation now.`
              : `Authorization denied for ${operation} ${path}. Continue without this change or report the appropriate blocked outcome.`,
          },
        ],
        details: { allowed },
      };
    },
  };
}
