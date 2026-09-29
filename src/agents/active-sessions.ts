import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { Role } from "./schemas.ts";

export interface ActiveAgentSession {
  workflowId: string;
  agentId: Role;
  attempt: number;
  session: AgentSession;
  startedAt: number;
  state: "running" | "steering" | "aborting" | "retrying";
  resetDoomLoop?: () => void;
  doomLoopInterventions?: number;
  doomLoopMaxInterventions?: number;
  toolCalls?: number;
  maxToolCalls?: number;
  toolsDisabledForFinalization?: boolean;
}

/** Live Pi objects are deliberately never written to workflow state. */
export class ActiveSessionRegistry {
  private readonly sessions = new Map<string, ActiveAgentSession>();
  private key(workflowId: string, agentId: Role) {
    return `${workflowId}:${agentId}`;
  }
  get(workflowId: string, agentId: Role) {
    return this.sessions.get(this.key(workflowId, agentId));
  }
  list(workflowId: string) {
    return [...this.sessions.values()].filter(
      (entry) => entry.workflowId === workflowId,
    );
  }
  register(entry: ActiveAgentSession) {
    const key = this.key(entry.workflowId, entry.agentId);
    if (this.sessions.has(key))
      throw new Error(`${entry.agentId} already has an active session`);
    this.sessions.set(key, entry);
  }
  remove(entry: ActiveAgentSession) {
    const key = this.key(entry.workflowId, entry.agentId);
    if (this.sessions.get(key) === entry) this.sessions.delete(key);
  }
  async steer(workflowId: string, agentId: Role, message: string) {
    const entry = this.get(workflowId, agentId);
    if (!entry || entry.state === "aborting" || entry.state === "retrying")
      throw new Error(`Agent "${agentId}" is not currently running.`);
    entry.state = "steering";
    try {
      await entry.session.steer(message);
    } finally {
      if (entry.state === "steering") entry.state = "running";
    }
    return entry;
  }
}
