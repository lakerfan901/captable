// Redaction of sensitive FIELDS (bank account numbers, passwords, secrets,
// tokens) before anything leaves for an error tracker. Pure: no env, no Node
// or browser APIs, so the tRPC input attached to Sentry (src/trpc/api/trpc.ts)
// and every Sentry runtime's `beforeSend` (src/constants/sentry-scrub.ts)
// share ONE rule. Credentials inside URLs and free text (emailed-link
// tokens) are handled by `redactTokens` (src/lib/token-redaction.ts).
//
// A key is sensitive when its name contains "token", "secret", "password",
// "passwd", "passphrase", "apikey" / "api_key", "authorization", "cookie",
// "accountnumber", "routingnumber", "swift", "iban" or "ssn" (any case,
// "_" / "-" ignored). Its value, whatever it is, becomes "[redacted]".
// Signature names (`typedName`, `signedName`) are not sensitive.

export const REDACTED_FIELD = "[redacted]";

const SENSITIVE_PARTS = [
  "token",
  "secret",
  "password",
  "passwd",
  "passphrase",
  "apikey",
  "authorization",
  "cookie",
  "accountnumber",
  "routingnumber",
  "swift",
  "iban",
] as const;

/** True for a key whose value must never be transmitted. */
export function isSensitiveKey(key: string): boolean {
  const k = key.toLowerCase().replace(/[_-]/g, "");
  return k === "ssn" || SENSITIVE_PARTS.some((p) => k.includes(p));
}

// The same key names inside serialized text: `"accountNumber":"123"` (JSON
// request bodies, messages) and `accountNumber=123` (query or form strings).
const KEY_PATTERN =
  "[A-Za-z0-9_-]*(?:token|secret|password|passwd|passphrase|api_?key|authorization|cookie|account_?number|routing_?number|swift|iban)[A-Za-z0-9_-]*|ssn";
const JSON_STRING_VALUE = new RegExp(
  `("(?:${KEY_PATTERN})"\\s*:\\s*)"(?:[^"\\\\]|\\\\.)*"`,
  "gi",
);
const JSON_ESCAPED_STRING_VALUE = new RegExp(
  `(\\\\"(?:${KEY_PATTERN})\\\\"\\s*:\\s*)\\\\"(?:[^"\\\\]|\\\\[^"])*\\\\"`,
  "gi",
);
const JSON_BARE_VALUE = new RegExp(
  `("(?:${KEY_PATTERN})"\\s*:\\s*)(?:-?\\d[\\d.eE+-]*|true|false)`,
  "gi",
);
const PAIR_VALUE = new RegExp(`(\\b(?:${KEY_PATTERN})=)[^&#\\s"']*`, "gi");

/** Redacts sensitive `key: value` pairs written inside a string. */
export function redactSensitiveText(value: string): string {
  return value
    .replace(JSON_STRING_VALUE, `$1"${REDACTED_FIELD}"`)
    .replace(JSON_ESCAPED_STRING_VALUE, `$1\\"${REDACTED_FIELD}\\"`)
    .replace(JSON_BARE_VALUE, `$1"${REDACTED_FIELD}"`)
    .replace(PAIR_VALUE, `$1${REDACTED_FIELD}`);
}

/**
 * Deep copy in which every sensitive key's value is "[redacted]" and every
 * string has `redactSensitiveText` applied. Arrays and plain objects are
 * walked; other objects (Date, Map, class instances) are kept as they are.
 * Cycles and depth are bounded. Never mutates its argument.
 */
export function redactSensitive<T>(
  value: T,
  depth = 0,
  seen: WeakSet<object> = new WeakSet(),
): T {
  if (typeof value === "string") return redactSensitiveText(value) as T;
  if (value === null || typeof value !== "object" || depth > 12) return value;
  if (seen.has(value as object)) return value;
  seen.add(value as object);
  if (Array.isArray(value)) {
    // A query string as [key, value] pairs (Sentry's `request.query_string`).
    if (
      value.length === 2 &&
      typeof value[0] === "string" &&
      isSensitiveKey(value[0])
    ) {
      return [value[0], REDACTED_FIELD] as T;
    }
    return value.map((v) => redactSensitive(v, depth + 1, seen)) as T;
  }
  const proto = Object.getPrototypeOf(value) as unknown;
  if (proto !== Object.prototype && proto !== null) return value;
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    out[key] = isSensitiveKey(key)
      ? REDACTED_FIELD
      : redactSensitive(v, depth + 1, seen);
  }
  return out as T;
}
