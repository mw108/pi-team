export type TextualToolCall = {
  name: string;
  arguments: Record<string, unknown>;
};

const namePattern = /^[A-Za-z0-9_.:-]+$/;

/** Parse only one complete instance of the local-model textual tool-call grammar. */
export function parseTextualToolCall(text: string): TextualToolCall | null {
  const source = text.trim();
  const open = "<tool_call>";
  const close = "</tool_call>";
  if (!source.startsWith(open) || !source.endsWith(close)) return null;
  const inner = source.slice(open.length, -close.length).trim();
  const functionOpen = /^<function=([A-Za-z0-9_.:-]+)>/.exec(inner);
  if (!functionOpen || !namePattern.test(functionOpen[1])) return null;
  const functionClose = "</function>";
  if (!inner.endsWith(functionClose)) return null;
  const body = inner.slice(functionOpen[0].length, -functionClose.length);
  const args: Record<string, unknown> = Object.create(null);
  let offset = 0;
  while (offset < body.length) {
    while (offset < body.length && /\s/.test(body[offset])) offset++;
    if (offset === body.length) break;
    const parameterOpen = /^<parameter=([A-Za-z0-9_.:-]+)>/.exec(
      body.slice(offset),
    );
    if (!parameterOpen) return null;
    const name = parameterOpen[1];
    if (Object.hasOwn(args, name)) return null;
    offset += parameterOpen[0].length;
    const end = body.indexOf("</parameter>", offset);
    if (end < 0) return null;
    const value = body.slice(offset, end).trim();
    if (/<\/?[A-Za-z]/.test(value)) return null;
    try {
      args[name] = JSON.parse(value);
    } catch {
      args[name] = value;
    }
    offset = end + "</parameter>".length;
  }
  return {
    name: functionOpen[1],
    arguments: Object.fromEntries(Object.entries(args)),
  };
}
