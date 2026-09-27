import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { Role } from "./schemas.ts";
const files: Record<Role, string> = {
  orchestrator: "orchestrator",
  researcher: "researcher",
  solver1: "solver",
  solver2: "solver",
  solver3: "solver",
  critic: "critic",
  reviewer: "reviewer",
  implementor: "implementor",
  codeReviewer: "code-reviewer",
  pentester: "pentester",
  securityReviewer: "security-reviewer",
  tester: "tester",
  commitAgent: "commit-agent",
};
export async function rolePrompt(role: Role) {
  return await readFile(
    fileURLToPath(new URL(`../../agents/${files[role]}.md`, import.meta.url)),
    "utf8",
  );
}
