import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionToolContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { pathToFileURL } from "node:url";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getErrorMessage } from "../agents/error-message.ts";
import { packagePath } from "./resources.ts";
import type { Question } from "../agents/schemas.ts";
import type { ApprovalRequest } from "../workflow/state.ts";
export const testedAskVersion = "1.2.0";
export const compatibleAskRange = ">=1.2.0 <1.3.0";
interface ProbeOptions {
  root?: string;
  importModule?: (url: string) => Promise<any>;
  appendEntry?: ExtensionAPI["appendEntry"];
}
// pi-ask 1.2 has a documented extension entry, but no public host-call API.
// Keep its one internal import here and validate the version/export/tool contract.
export async function checkAskCompatibility(options: ProbeOptions = {}) {
  let version = "unavailable";
  try {
    const root = options.root ?? packagePath("@eko24ive/pi-ask", "");
    const manifest = JSON.parse(
      await readFile(join(root, "package.json"), "utf8"),
    );
    version = manifest.version;
    if (manifest.name !== "@eko24ive/pi-ask" || !/^1\.2\.\d+$/.test(version))
      throw new Error(`Unsupported version (supported ${compatibleAskRange})`);
    const path = join(root, "src/ask-tool.ts");
    await readFile(path);
    const module = await (options.importModule ?? ((url) => import(url)))(
      pathToFileURL(path).href,
    );
    if (typeof module.registerAskTool !== "function")
      throw new Error("Required export registerAskTool is missing");
    let tool: ToolDefinition | undefined;
    module.registerAskTool({
      registerTool: (definition: ToolDefinition) => {
        if (definition.name === "ask_user") tool = definition;
      },
      appendEntry: options.appendEntry ?? (() => {}),
    });
    if (
      !tool ||
      typeof tool.execute !== "function" ||
      !(tool.parameters as any)?.properties?.questions
    )
      throw new Error("ask_user registration failed");
    return { version, range: compatibleAskRange, tool };
  } catch (error) {
    throw new Error(
      `pi-ask ${version}: integration API unavailable. Expected @eko24ive/pi-ask/src/ask-tool.ts → registerAskTool → ask_user (${compatibleAskRange}; tested ${testedAskVersion}). ${getErrorMessage(error)}. Run npm run doctor or /team doctor. See README → pi-ask compatibility.`,
      { cause: error },
    );
  }
}
async function invoke(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  params: unknown,
  signal?: AbortSignal,
) {
  if (signal?.aborted) return undefined;
  if (ctx.mode !== "tui" || !ctx.hasUI || typeof ctx.ui.custom !== "function")
    throw new Error(
      "Local terminal approval unavailable: Pi requires an active interactive TUI context. No permission was granted. Open interactive Pi and use /team resume to review pending approvals; inspect the interrupted attempt before retrying it.",
    );
  const { tool } = await checkAskCompatibility({
    appendEntry: pi.appendEntry.bind(pi),
  });
  if (signal?.aborted) return undefined;
  // pi-ask 1.2 ignores its execute signal. Close its SDK dialog ourselves so
  // obsolete dialogs cannot survive workflow cancellation or attempt retry.
  const ui = ctx.ui;
  let cleanup: (() => void) | undefined;
  const context = Object.create(ctx) as ExtensionContext;
  Object.defineProperty(context, "ui", {
    value: {
      ...ui,
      custom: ((factory, options) =>
        ui.custom((tui, theme, keys, done) => {
          const abort = () =>
            done({
              cancelled: true,
              mode: "cancel",
              questions: [],
              answers: {},
            } as never);
          signal?.addEventListener("abort", abort, { once: true });
          cleanup = () => signal?.removeEventListener("abort", abort);
          if (signal?.aborted) {
            abort();
            return { render: () => [], invalidate: () => {} };
          }
          return factory(tui, theme, keys, (value) => {
            cleanup?.();
            done(value);
          });
        }, options)) as ExtensionContext["ui"]["custom"],
    },
  });
  try {
    const result = await tool.execute(
      `team-question-${Date.now()}`,
      params,
      signal,
      undefined,
      // pi-ask 1.2 uses the base extension context only; Pi 0.99 types tool contexts separately.
      context as ExtensionToolContext,
    );
    if (signal?.aborted) return undefined;
    const details = result.details as any;
    return !details?.cancelled && details?.mode === "submit"
      ? details
      : undefined;
  } finally {
    cleanup?.();
  }
}
export function approvalParams(request: ApprovalRequest) {
  return {
    title: request.title,
    questions: [
      {
        id: "approval",
        label: "Approval",
        prompt: request.prompt,
        type: [
          "manualCommit",
          "configDrift",
          "manualRetry",
          "runtimeCommand",
          "runtimeFile",
          "contractPath",
          "contractExtension",
          "securityRisk",
          "pentestUnavailability",
          "pentestContractClarification",
          "credentialFinding",
          "technicalRecovery",
        ].includes(request.kind)
          ? "single"
          : "multi",
        options: request.options,
      },
    ],
  };
}
export function approvalValues(
  request: ApprovalRequest,
  details: any,
): string[] | undefined {
  if (!details || details.cancelled || details.mode !== "submit")
    return undefined;
  const answer = details.answers?.approval;
  if (!answer || !Array.isArray(answer.values)) return undefined;
  // Freeform labels/notes never grant approval; only exact submitted option values.
  if (
    answer.customText ||
    answer.values.some(
      (v: unknown) =>
        typeof v !== "string" || !request.options.some((o) => o.value === v),
    )
  )
    throw new Error(
      "Approval requires selecting listed options; freeform input cannot grant permissions",
    );
  return [...new Set(answer.values as string[])];
}
export async function askApproval(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  request: ApprovalRequest,
  signal?: AbortSignal,
) {
  return approvalValues(
    request,
    await invoke(pi, ctx, approvalParams(request), signal),
  );
}
export async function askUser(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  question: Question,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const details = await invoke(
    pi,
    ctx,
    {
      title: "Team requires input",
      questions: [
        {
          id: "requirement",
          prompt: question.question,
          label: "Requirement",
          options: [
            {
              value: "clarify",
              label: "Provide clarification",
              description: question.reason,
            },
          ],
        },
      ],
    },
    signal,
  );
  const answer = details?.answers?.requirement;
  const text =
    answer?.customText || answer?.note || answer?.optionNotes?.clarify;
  return typeof text === "string" && text.trim() ? text.trim() : undefined;
}

export function researchQuestionParams(questions: string[]) {
  return {
    title: "Researcher needs clarification before Solvers continue",
    questions: questions.map((question, index) => ({
      id: `research_${index + 1}`,
      label: `Question ${index + 1}`,
      prompt: `${index + 1}. ${question}`,
      type: "single" as const,
      required: true,
      options: [
        {
          value: "answer",
          label: "Provide an answer",
          description:
            "Enter your answer in the custom response field or option note",
        },
      ],
    })),
  };
}

export function researchQuestionAnswers(
  questions: string[],
  details: any,
): { question: string; answer: string }[] | undefined {
  if (!details || details.cancelled || details.mode !== "submit")
    return undefined;
  const mapped = questions.map((question, index) => {
    const answer = details.answers?.[`research_${index + 1}`];
    const value =
      answer?.customText || answer?.note || answer?.optionNotes?.answer;
    return { question, answer: typeof value === "string" ? value.trim() : "" };
  });
  return mapped.every(({ answer }) => answer.length > 0) ? mapped : undefined;
}

export async function askResearchQuestions(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  questions: string[],
  signal?: AbortSignal,
) {
  const details = await invoke(
    pi,
    ctx,
    researchQuestionParams(questions),
    signal,
  );
  const answers = researchQuestionAnswers(questions, details);
  if (details && !answers)
    ctx.ui.notify(
      "Please answer every Researcher question before the Solvers can continue. Resume the workflow to reopen the questions.",
      "warning",
    );
  return answers;
}
