import { z } from "zod";
// Small schema description adapter for prompts; Zod remains authoritative.
// Runtime conversion is delegated to the established zod-to-json-schema library.
import { zodToJsonSchema as convert } from "zod-to-json-schema";
export function zodToJsonSchema(schema: z.ZodTypeAny) {
  return convert(schema, { $refStrategy: "none" });
}
