import type { ApprovalRequest } from "../workflow/state.ts";

// Trusted terminal details are deliberately not enumerable or serializable.
// Logs and persisted workflow prompts keep their existing redacted form.
const terminalPrompts = new WeakMap<
  ApprovalRequest,
  { base: string; full: string }
>();

export function withTerminalPrompt(request: ApprovalRequest, prompt: string) {
  terminalPrompts.set(request, { base: request.prompt, full: prompt });
  return request;
}

export function terminalPrompt(request: ApprovalRequest) {
  const local = terminalPrompts.get(request);
  if (!local) return request.prompt;
  // Recovery may append guidance after constructing the command prompt.
  return request.prompt.startsWith(local.base)
    ? local.full + request.prompt.slice(local.base.length)
    : request.prompt;
}
