import { isDeepStrictEqual } from "node:util";
import { jsonRepair } from "ai-json-repair";
import { jsonrepair } from "jsonrepair";
import { redactVisibleText } from "./redaction.ts";

export const MAX_LOCAL_JSON_REPAIR_LENGTH = 1024 * 1024;
export const MAX_LOCAL_JSON_REPAIR_DEPTH = 128;

export type LocalJsonRepairMethod = "jsonrepair" | "ai-json-repair";
export type LocalJsonRepairFailureType = "parse" | "schema";
export type LocalJsonRepairEvent = {
  type:
    | "json_repair_started"
    | "json_repair_succeeded"
    | "json_repair_failed"
    | "ai_json_repair_started"
    | "ai_json_repair_succeeded"
    | "ai_json_repair_failed"
    | "local_json_repair_exhausted";
  method?: LocalJsonRepairMethod;
  originalFailureType: LocalJsonRepairFailureType;
  schemaValid?: boolean;
  diagnostic?: string;
  skippedReason?:
    | "ambiguous"
    | "candidate_too_large"
    | "nesting_too_deep"
    | "model_output_truncated";
};

export type LocalJsonRepairImplementations = {
  jsonrepair: (candidate: string) => string;
  aiJsonRepair: (candidate: string) => string;
};

export const localJsonRepairImplementations: LocalJsonRepairImplementations = {
  jsonrepair,
  // No JSON Schema is supplied: schema-guided coercion and salvage stay off.
  // strict rejects empty values and duplicate keys found by this parser.
  aiJsonRepair: (candidate) => jsonRepair(candidate, { strict: true }),
};

type ObjectFrame = { type: "object"; keys: Set<string> };
type ArrayFrame = { type: "array" };
type Frame = ObjectFrame | ArrayFrame;

type CandidateInspection =
  | { safe: true }
  | {
      safe: false;
      reason: NonNullable<LocalJsonRepairEvent["skippedReason"]>;
      diagnostic: string;
    };

function decodedKey(raw: string, quote: string): string {
  if (quote === '"') {
    try {
      return JSON.parse(`"${raw}"`) as string;
    } catch {
      // The repair library may still be able to fix the string. Comparing the
      // bounded raw spelling remains useful for duplicate detection.
    }
  }
  return raw;
}

function addKey(frame: Frame | undefined, key: string): string | undefined {
  if (!frame || frame.type !== "object") return undefined;
  if (frame.keys.has(key)) return key;
  frame.keys.add(key);
  return undefined;
}

/**
 * Reject repairs where a syntax library would have to choose between meanings.
 * This intentionally rejects every duplicate key, not just duplicates whose
 * values can be proved different, because both libraries can otherwise apply
 * last-value-wins behavior before Zod sees the candidate.
 */
export function inspectLocalJsonRepairCandidate(
  candidate: string,
  modelOutputTruncated = false,
): CandidateInspection {
  if (modelOutputTruncated)
    return {
      safe: false,
      reason: "model_output_truncated",
      diagnostic: "Provider marked the model response as length-truncated",
    };
  if (candidate.length > MAX_LOCAL_JSON_REPAIR_LENGTH)
    return {
      safe: false,
      reason: "candidate_too_large",
      diagnostic: `Candidate exceeds ${MAX_LOCAL_JSON_REPAIR_LENGTH} characters`,
    };

  const first = candidate.search(/\S/);
  if (first < 0 || !"[{".includes(candidate[first]))
    return {
      safe: false,
      reason: "ambiguous",
      diagnostic: "Candidate does not start with a JSON object or array",
    };

  const frames: Frame[] = [];
  let completedAt: number | undefined;
  for (let index = first; index < candidate.length; index++) {
    const char = candidate[index];
    if (/\s/.test(char)) continue;

    if (char === "/" && ["/", "*"].includes(candidate[index + 1] ?? ""))
      return {
        safe: false,
        reason: "ambiguous",
        diagnostic:
          "Comments are not accepted in locally repaired agent output",
      };
    if (candidate.slice(index, index + 3) === "...")
      return {
        safe: false,
        reason: "ambiguous",
        diagnostic: "Ellipsis can represent omitted structured content",
      };

    if (char === '"' || char === "'" || char === "“" || char === "‘") {
      const close = char === "“" ? "”" : char === "‘" ? "’" : char;
      const start = index;
      let escaped = false;
      for (index++; index < candidate.length; index++) {
        const current = candidate[index];
        if (escaped) escaped = false;
        else if (current === "\\") escaped = true;
        else if (current === close) break;
      }
      if (index >= candidate.length)
        return {
          safe: false,
          reason: "model_output_truncated",
          diagnostic: "Candidate ends inside a string",
        };
      let next = index + 1;
      while (/\s/.test(candidate[next] ?? "")) next++;
      if (candidate[next] === ":") {
        const duplicate = addKey(
          frames.at(-1),
          decodedKey(candidate.slice(start + 1, index), char),
        );
        if (duplicate !== undefined)
          return {
            safe: false,
            reason: "ambiguous",
            diagnostic: `Duplicate object key is ambiguous: ${duplicate.slice(0, 80)}`,
          };
      }
      continue;
    }

    if (char === "{") frames.push({ type: "object", keys: new Set() });
    else if (char === "[") frames.push({ type: "array" });
    else if (char === "}" || char === "]") {
      const expected = char === "}" ? "object" : "array";
      if (frames.at(-1)?.type === expected) frames.pop();
      if (frames.length === 0 && completedAt === undefined)
        completedAt = index + 1;
    } else if (frames.at(-1)?.type === "object" && ![":", ","].includes(char)) {
      let end = index;
      while (end < candidate.length && !/[\s:,{}\[\]]/.test(candidate[end]))
        end++;
      let next = end;
      while (/\s/.test(candidate[next] ?? "")) next++;
      if (candidate[next] === ":") {
        const duplicate = addKey(frames.at(-1), candidate.slice(index, end));
        if (duplicate !== undefined)
          return {
            safe: false,
            reason: "ambiguous",
            diagnostic: `Duplicate object key is ambiguous: ${duplicate.slice(0, 80)}`,
          };
      }
      index = Math.max(index, end - 1);
    }

    if (frames.length > MAX_LOCAL_JSON_REPAIR_DEPTH)
      return {
        safe: false,
        reason: "nesting_too_deep",
        diagnostic: `Candidate exceeds nesting depth ${MAX_LOCAL_JSON_REPAIR_DEPTH}`,
      };
  }

  if (completedAt !== undefined) {
    const trailing = candidate.slice(completedAt);
    if (trailing.trim() && !/^[\s}\]]+$/.test(trailing))
      return {
        safe: false,
        reason: "ambiguous",
        diagnostic:
          "Multiple top-level values or trailing content are ambiguous",
      };
  }
  const last = candidate.trimEnd().at(-1);
  if (last === ":" || last === ",")
    return {
      safe: false,
      reason: "model_output_truncated",
      diagnostic: "Candidate ends before a required value",
    };
  return { safe: true };
}

function boundedDiagnostic(error: unknown) {
  return redactVisibleText(String(error)).slice(0, 500);
}

function eventNames(method: LocalJsonRepairMethod) {
  return method === "jsonrepair"
    ? {
        started: "json_repair_started" as const,
        succeeded: "json_repair_succeeded" as const,
        failed: "json_repair_failed" as const,
      }
    : {
        started: "ai_json_repair_started" as const,
        succeeded: "ai_json_repair_succeeded" as const,
        failed: "ai_json_repair_failed" as const,
      };
}

export function repairJsonLocally<T>(options: {
  candidate: string;
  originalFailureType: LocalJsonRepairFailureType;
  originalParsedValue?: unknown;
  modelOutputTruncated?: boolean;
  validate: (value: unknown) => T;
  onEvent?: (event: LocalJsonRepairEvent) => void;
  implementations?: LocalJsonRepairImplementations;
}): T | undefined {
  const inspection = inspectLocalJsonRepairCandidate(
    options.candidate,
    options.modelOutputTruncated,
  );
  if (!inspection.safe) {
    options.onEvent?.({
      type: "local_json_repair_exhausted",
      originalFailureType: options.originalFailureType,
      schemaValid: false,
      skippedReason: inspection.reason,
      diagnostic: inspection.diagnostic,
    });
    return undefined;
  }

  const implementations =
    options.implementations ?? localJsonRepairImplementations;
  const attempts: [LocalJsonRepairMethod, (candidate: string) => string][] = [
    ["jsonrepair", implementations.jsonrepair],
    ["ai-json-repair", implementations.aiJsonRepair],
  ];
  for (const [method, repair] of attempts) {
    const names = eventNames(method);
    options.onEvent?.({
      type: names.started,
      method,
      originalFailureType: options.originalFailureType,
    });
    try {
      const repaired = repair(options.candidate);
      if (typeof repaired !== "string")
        throw new TypeError("Repair library did not return a JSON string");
      if (repaired.length > MAX_LOCAL_JSON_REPAIR_LENGTH)
        throw new Error("Repaired candidate exceeds the local repair limit");
      const repairedInspection = inspectLocalJsonRepairCandidate(repaired);
      if (!repairedInspection.safe)
        throw new Error(repairedInspection.diagnostic);
      const parsed = JSON.parse(repaired) as unknown;
      if (
        options.originalParsedValue !== undefined &&
        !isDeepStrictEqual(parsed, options.originalParsedValue)
      )
        throw new Error(
          "Repair changed an already parseable value; semantic coercion rejected",
        );
      const result = options.validate(parsed);
      options.onEvent?.({
        type: names.succeeded,
        method,
        originalFailureType: options.originalFailureType,
        schemaValid: true,
      });
      return result;
    } catch (error) {
      options.onEvent?.({
        type: names.failed,
        method,
        originalFailureType: options.originalFailureType,
        schemaValid: false,
        diagnostic: boundedDiagnostic(error),
      });
    }
  }
  options.onEvent?.({
    type: "local_json_repair_exhausted",
    originalFailureType: options.originalFailureType,
    schemaValid: false,
  });
  return undefined;
}
