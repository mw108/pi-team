import { basename } from "node:path";
import type { Role } from "../agents/schemas.ts";
import type { TeamConfig } from "../config/schema.ts";

const defaultNames: Record<Role, string> = {
  orchestrator: "Orchestrator",
  researcher: "Researcher",
  solver1: "Solver Architecture",
  solver2: "Solver Pragmatic",
  solver3: "Solver Alternative",
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
  if (agent.name) return agent.name;
  if (!agentId.startsWith("solver")) return defaultNames[agentId];
  // Existing configs derived Solver labels from their prompt filename.
  const stem = basename(agent.prompt, ".md");
  const variant = stem.startsWith("solver-") ? stem.slice(7) : "";
  return /^[a-z][a-z-]{0,23}$/.test(variant)
    ? `Solver ${variant.replaceAll("-", " ").replace(/\b\w/g, (letter) => letter.toUpperCase())}`
    : `Solver ${agentId.slice(-1)}`;
}
