export interface SecretMatch {
  kind: string;
  start: number;
  end: number;
}

const signatures: readonly [string, RegExp][] = [
  ["AWS access key", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
  [
    "GitHub token",
    /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{30,})\b/g,
  ],
  [
    "Provider API key",
    /\b(?:sk-ant-[A-Za-z0-9_-]{12,}|sk-(?:proj-)?[A-Za-z0-9_-]{20,}|ctx7sk-[A-Za-z0-9_-]{12,})\b/g,
  ],
  ["JWT", /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g],
  [
    "Private key",
    /-----BEGIN (?:(?:RSA|OPENSSH|EC|DSA|ENCRYPTED) )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:(?:RSA|OPENSSH|EC|DSA|ENCRYPTED) )?PRIVATE KEY-----|$)/g,
  ],
];

const assignment =
  /\b(?:[A-Za-z][A-Za-z0-9_]*_)?(?:API_KEY|SECRET(?:_KEY)?|TOKEN|PASSWORD(?:_CONFIRMATION)?|PRIVATE_KEY|CREDENTIALS?)\s*[:=]\s*(?:"([^"\r\n]*)"|'([^'\r\n]*)'|([^\s;#]+))/gi;

function plausible(value: string): boolean {
  const cleaned = value.trim();
  return (
    cleaned.length >= 8 &&
    !/^(?:\[REDACTED\]|\*+|x+|example|placeholder|changeme|your[_-]?|test[_-]?|\$\{|\$\()/i.test(
      cleaned,
    ) &&
    new Set(cleaned).size >= 4
  );
}

export function detectSecrets(text: string): SecretMatch[] {
  const findings: SecretMatch[] = [];
  for (const [kind, pattern] of signatures) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern))
      findings.push({
        kind,
        start: match.index,
        end: match.index + match[0].length,
      });
  }
  assignment.lastIndex = 0;
  for (const match of text.matchAll(assignment)) {
    const value = match[1] ?? match[2] ?? match[3] ?? "";
    if (!plausible(value)) continue;
    const offset = match[0].lastIndexOf(value);
    findings.push({
      kind: "Credential assignment",
      start: match.index + offset,
      end: match.index + offset + value.length,
    });
  }
  const distinct: SecretMatch[] = [];
  // A signature inside an assignment value remains mandatory. The broader
  // assignment match must never shadow a high-confidence token.
  const prioritized = findings.filter(
    (item) =>
      item.kind !== "Credential assignment" ||
      !findings.some(
        (other) =>
          other.kind !== "Credential assignment" &&
          item.start < other.end &&
          other.start < item.end,
      ),
  );
  for (const item of prioritized.sort(
    (a, b) => a.start - b.start || b.end - a.end,
  ))
    if (!distinct.length || item.start >= distinct.at(-1)!.end)
      distinct.push(item);
  return distinct;
}

export function redactSecrets(text: string): string {
  let result = text;
  for (const match of detectSecrets(text).reverse())
    result = `${result.slice(0, match.start)}[REDACTED]${result.slice(match.end)}`;
  return result;
}
