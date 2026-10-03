import { randomUUID } from "node:crypto";
import type { Command } from "../config/schema.ts";
import type { Role } from "../agents/schemas.ts";
import type { RuntimeCommandRequest } from "../agents/runtime-commands.ts";
import {
  proposeSimilarRule,
  ruleMatches,
  similarRuleDescription,
} from "../agents/runtime-commands.ts";
import { commandKey, effectiveConfig } from "../agents/discovery.ts";
import { approvedCommandsForRole } from "../agents/commands.ts";
import {
  commandSummary,
  formatCommandLine,
} from "../agents/command-observability.ts";
import { redactVisibleText } from "./agent-logs.ts";
import { getAgentDisplayName } from "../ui/agent-name.ts";
import type { AgentEvent } from "../ui/runtime.ts";
import type { WorkflowState, ApprovalRequest } from "./state.ts";

export type AttemptControl = {
  workflowId: string;
  controller: AbortController;
  attempt: number;
  intention?: "abort" | "retry" | "superseded";
  manualRetry?: boolean;
  settled?: boolean;
};
export interface CommandApprovalDependencies {
  activeAttempt(role: Role): AttemptControl | undefined;
  emitAgentEvent(event: AgentEvent): void;
  persistAttempt(
    state: WorkflowState,
    event: string,
    detail: string,
    meta: NonNullable<WorkflowState["history"][number]["meta"]>,
  ): Promise<void>;
  progress(state: WorkflowState): void;
  approve?(request: ApprovalRequest): Promise<string[] | undefined>;
  save(state: WorkflowState): Promise<void>;
}

/** Owns the serial approval queue and its pending-request lifecycle. */
export class RuntimeCommandApprovalCoordinator {
  constructor(private readonly deps: CommandApprovalDependencies) {}
  private commandApprovalQueue = Promise.resolve();
  runtimeApprovalPrompt(
    s: WorkflowState,
    role: Role,
    command: Command,
    purpose: string,
  ): ApprovalRequest {
    const rule = proposeSimilarRule(command, role);
    const line = formatCommandLine(command);
    const label = getAgentDisplayName(s.config, role);
    const ruleLine = rule ? similarRuleDescription(rule) : "";
    const discovered = s.discoveredCommands.find(
      (item) => commandKey(item.command) === commandKey(command),
    );
    const metadata = discovered
      ? `\nSource: ${redactVisibleText(discovered.source)}\nConfidence: ${discovered.confidence}`
      : "";
    return {
      kind: "runtimeCommand",
      title: `${label} requests command approval`,
      prompt: `Agent: ${label} (${role})\nCategory: ${command.purpose}\n\nCommand: ${line}\n\nPurpose: ${discovered?.command.purpose ?? redactVisibleText(purpose)}${metadata}${discovered ? `\nReason: ${redactVisibleText(purpose)}` : ""}\n\nThis command may modify project files, generated artifacts, or local development state.\n\nScope: exact command for ${label} in this workflow.${rule ? `\n\nAllow similar for ${label}: ${ruleLine}` : ""}`,
      options: [
        {
          value: "allow_once",
          label: "Allow once",
          description: "Execute this exact command one time",
        },
        {
          value: "allow_workflow",
          label: `Allow exact for ${label} in this workflow`,
          description: "Approve this exact argv for this role and workflow",
        },
        ...(rule
          ? [
              {
                value: "allow_similar",
                label: "Allow similar",
                description: `Approve the displayed constrained rule for ${label}`,
              },
            ]
          : []),
        {
          value: "deny",
          label: "Deny",
          description: "Do not execute this command",
        },
      ],
    };
  }
  saveRuntimeApproval(
    s: WorkflowState,
    role: Role,
    command: Command,
    choice: string,
  ) {
    if (choice === "allow_workflow" || choice === "allow_similar") {
      if (
        !s.runtimeCommandApprovals.some(
          (item) =>
            item.role === role &&
            commandKey(item.command) === commandKey(command),
        )
      )
        s.runtimeCommandApprovals.push({ role, command });
      const rule =
        choice === "allow_similar"
          ? proposeSimilarRule(command, role)
          : undefined;
      if (
        rule &&
        !s.similarCommandRules.some(
          (item) => JSON.stringify(item) === JSON.stringify(rule),
        )
      )
        s.similarCommandRules.push(rule);
    }
  }
  async approve(
    s: WorkflowState,
    agentState: WorkflowState,
    role: Role,
    control: AttemptControl,
    command: Command,
    request: RuntimeCommandRequest,
    signal: AbortSignal | undefined,
    log: (event: { type: string; [key: string]: unknown }) => void,
  ): Promise<"allow" | "deny" | "pending"> {
    const current = () =>
      control.workflowId === s.id &&
      this.deps.activeAttempt(role) === control &&
      !control.intention &&
      !control.settled &&
      !signal?.aborted;
    if (!current()) return "pending";
    const approved = () =>
      approvedCommandsForRole(role, effectiveConfig(s, role)).some(
        (item) => commandKey(item) === commandKey(command),
      ) ||
      s.similarCommandRules.some((rule) => ruleMatches(rule, command, role));
    if (approved()) {
      agentState.approvedCommands = structuredClone(s.approvedCommands);
      agentState.runtimeCommandApprovals = structuredClone(
        s.runtimeCommandApprovals,
      );
      agentState.similarCommandRules = structuredClone(s.similarCommandRules);
      this.deps.emitAgentEvent({
        type: "commandApproved",
        role,
        command: commandSummary(command.id, command),
      });
      return "allow";
    }
    const pending = {
      workflowId: s.id,
      agentId: role,
      run: control.attempt,
      requestId: randomUUID(),
      command,
      purpose: request.purpose,
    };
    s.pendingRuntimeCommands.push(pending);
    const safe = commandSummary(command.id, command);
    log({
      type: "command_approval_requested",
      agent: role,
      requestingRole: role,
      category: command.purpose,
      approvalScope: "role-and-workflow",
      run: control.attempt,
      requestId: pending.requestId,
      ...safe,
      purpose: redactVisibleText(request.purpose),
    });
    await this.deps.persistAttempt(
      s,
      "command_approval_requested",
      `${role} requested ${command.id}`,
      { agent: role, attempt: control.attempt },
    );
    this.deps.progress(s);
    const decide = async (): Promise<"allow" | "deny" | "pending"> => {
      if (!current()) return "pending";
      if (approved()) {
        s.pendingRuntimeCommands = s.pendingRuntimeCommands.filter(
          (item) => item.requestId !== pending.requestId,
        );
        await this.deps.save(s);
        agentState.approvedCommands = structuredClone(s.approvedCommands);
        agentState.runtimeCommandApprovals = structuredClone(
          s.runtimeCommandApprovals,
        );
        agentState.similarCommandRules = structuredClone(s.similarCommandRules);
        this.deps.emitAgentEvent({
          type: "commandApproved",
          role,
          command: commandSummary(command.id, command),
        });
        return "allow";
      }
      const approval = this.runtimeApprovalPrompt(
        s,
        role,
        command,
        request.purpose,
      );
      const aborted = new Promise<undefined>((resolve) => {
        if (signal?.aborted) resolve(undefined);
        else
          signal?.addEventListener("abort", () => resolve(undefined), {
            once: true,
          });
      });
      const selected = await Promise.race([
        this.deps.approve?.(approval) ?? Promise.resolve(undefined),
        aborted,
      ]);
      if (
        !current() ||
        !s.pendingRuntimeCommands.some(
          (item) =>
            item.requestId === pending.requestId &&
            item.workflowId === s.id &&
            item.agentId === role &&
            item.run === control.attempt,
        )
      )
        return "pending";
      const choice = selected?.length === 1 ? selected[0] : undefined;
      if (!choice) return "pending";
      if (
        !["allow_once", "allow_workflow", "allow_similar", "deny"].includes(
          choice,
        ) ||
        (choice === "allow_similar" && !proposeSimilarRule(command, role))
      )
        return "pending";
      this.saveRuntimeApproval(s, role, command, choice);
      agentState.approvedCommands = structuredClone(s.approvedCommands);
      agentState.runtimeCommandApprovals = structuredClone(
        s.runtimeCommandApprovals,
      );
      agentState.similarCommandRules = structuredClone(s.similarCommandRules);
      s.pendingRuntimeCommands = s.pendingRuntimeCommands.filter(
        (item) => item.requestId !== pending.requestId,
      );
      log({
        type: "command_approval_decided",
        agent: role,
        requestingRole: role,
        category: command.purpose,
        approvalScope:
          choice === "allow_once"
            ? "once"
            : choice === "deny"
              ? "none"
              : "role-and-workflow",
        commandId: command.id,
        run: control.attempt,
        requestId: pending.requestId,
        decision: choice,
        ...(choice === "allow_similar"
          ? { rule: proposeSimilarRule(command, role) }
          : {}),
      });
      await this.deps.persistAttempt(
        s,
        "command_approval_decided",
        `${role} ${choice} ${command.id}`,
        { agent: role, attempt: control.attempt },
      );
      if (choice !== "deny")
        this.deps.emitAgentEvent({
          type: "commandApproved",
          role,
          command: commandSummary(command.id, command),
        });
      this.deps.progress(s);
      return choice === "deny" ? "deny" : "allow";
    };
    const turn = this.commandApprovalQueue.then(decide);
    this.commandApprovalQueue = turn.then(
      () => {},
      () => {},
    );
    try {
      return await turn;
    } finally {
      if (!current()) {
        s.pendingRuntimeCommands = s.pendingRuntimeCommands.filter(
          (item) => item.requestId !== pending.requestId,
        );
        await this.deps.save(s);
      }
    }
  }
}
