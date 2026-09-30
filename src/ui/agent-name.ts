import { basename } from "node:path";
import type { Role } from "../agents/schemas.ts";
import type { TeamConfig } from "../config/schema.ts";

const defaultNames: Record<Role, string> = {
  orchestrator: "Orchestrator",
  researcher: "Researcher",
  solver1: "Solver Architecture",
  solver2: "Solver Pragmatic",
  solver3: "Solver Alternative",
  solver4: "Solver 4",
  solver5: "Solver 5",
  solver6: "Solver 6",
  solver7: "Solver 7",
  solver8: "Solver 8",
  solver9: "Solver 9",
  solver10: "Solver 10",
  critic: "Critic",
  reviewer: "Reviewer",
  implementor: "Implementor",
  codeReviewer: "Code Reviewer",
  pentester: "Pen Tester",
  securityReviewer: "Security Reviewer",
  tester: "Tester",
  commitAgent: "Commit Agent",
  reporter: "Reporter",
};

export function getAgentDisplayName(config: TeamConfig, agentId: Role): string {
  const agent = config.agents[agentId];
  if (agent?.name) return agent.name;
  if (!agentId.startsWith("solver")) return defaultNames[agentId];
  if (!agent) return defaultNames[agentId];
  if (Number(agentId.slice(6)) > 3) return defaultNames[agentId];
  // Existing configs derived Solver labels from their prompt filename.
  const stem = basename(agent.prompt, ".md");
  const variant = stem.startsWith("solver-") ? stem.slice(7) : "";
  return /^[a-z][a-z-]{0,23}$/.test(variant)
    ? `Solver ${variant.replaceAll("-", " ").replace(/\b\w/g, (letter) => letter.toUpperCase())}`
    : `Solver ${agentId.slice(6)}`;
}
