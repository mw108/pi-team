import type { Role } from "./schemas.ts";

export const commandCategories = [
  "development",
  "test",
  "static",
  "pentest",
] as const;
export type CommandCategory = (typeof commandCategories)[number];

/** Network access is never inferred from an agent's command description. */
export function commandNetworkPolicy(
  category: CommandCategory,
  network: "deny" | "allow",
  pentestNetwork: "deny" | "allow",
): "deny" | "allow" {
  return category === "pentest" ? pentestNetwork : network;
}

const roleCategories: Partial<Record<Role, readonly CommandCategory[]>> = {
  implementor: ["development", "test", "static"],
  tester: ["test", "static"],
  codeReviewer: ["static"],
  pentester: ["pentest"],
};

export function allowedCommandCategories(
  role: Role,
): readonly CommandCategory[] {
  return roleCategories[role] ?? [];
}

const forbiddenExecutables = new Set([
  "git",
  "git.exe",
  "sh",
  "bash",
  "zsh",
  "fish",
  "pwsh",
  "powershell",
  "cmd",
  "cmd.exe",
  "eval",
]);

export function executableName(executable: string): string {
  return executable.split(/[\\/]/).at(-1)?.toLowerCase() ?? "";
}

export function isForbiddenExecutable(executable: string): boolean {
  return forbiddenExecutables.has(executableName(executable));
}

export function hasUnsafeArgvToken(
  executable: string,
  args: readonly string[],
): boolean {
  return [executable, ...args].some(
    (value) => /[\0\r\n]/.test(value) || /^(?:&&|\|\||;|\||&)$/u.test(value),
  );
}
