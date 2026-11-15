// Where to go after sign-in or password set-up (04-investor-portal.md 5.2
// "The `next` target", S16; package P1). Pure: no `@/` imports.
//
// Applied when a token is issued (`PortalAccountToken.nextPath`), when the
// sign-in page reads `?next=`, and again in both route handlers.

export const DEFAULT_NEXT_PATH = "/portal";
export const NEXT_PATH_MAX_LENGTH = 200;

/** First segments after `/portal/` that are never a destination. */
const DENIED_FIRST_SEGMENTS: ReadonlySet<string> = new Set([
  "auth",
  "set-password",
  "sign-in",
]);

// The only characters a portal destination needs: unreserved characters,
// `/`, and `?`, `=`, `&` for a query. Everything else is refused, notably
// `%` (so no encoded `.`, `/`, `\` or control character can be decoded later
// into something else), `\`, `@`, `:`, `#`, whitespace, control characters
// and every non-ASCII character.
const ALLOWED_RE = /^[A-Za-z0-9\-._~/?=&]+$/;

const PROBE_ORIGIN = "https://portal.invalid";

/**
 * `value` when it is a safe path under `/portal/`, else `/portal`.
 *
 * Safe means: a string of at most 200 characters, only the characters above,
 * starting with `/portal/`, with no `//`, no `.` or `..` path segment, and a
 * first segment other than `auth`, `set-password` and `sign-in` (the part
 * before `?` is what is checked). A non-string (for example `?next=a&next=b`
 * read as an array) is refused. The value is never trimmed or decoded.
 */
export function safeNextPath(value: unknown): string {
  if (typeof value !== "string") return DEFAULT_NEXT_PATH;
  if (value.length === 0 || value.length > NEXT_PATH_MAX_LENGTH) {
    return DEFAULT_NEXT_PATH;
  }
  if (!ALLOWED_RE.test(value)) return DEFAULT_NEXT_PATH;
  if (!value.startsWith("/portal/")) return DEFAULT_NEXT_PATH;
  if (value.includes("//")) return DEFAULT_NEXT_PATH;

  const q = value.indexOf("?");
  const path = q === -1 ? value : value.slice(0, q);
  const segments = path.split("/").slice(1); // drop the empty string before the leading "/"
  if (segments.some((s) => s === "." || s === "..")) return DEFAULT_NEXT_PATH;
  const first = segments[1] ?? "";
  if (DENIED_FIRST_SEGMENTS.has(first)) return DEFAULT_NEXT_PATH;

  // Belt and braces: the WHATWG parser must resolve the value to the same
  // origin and leave the path untouched (nothing normalised away).
  let resolved: URL;
  try {
    resolved = new URL(value, PROBE_ORIGIN);
  } catch {
    return DEFAULT_NEXT_PATH;
  }
  if (resolved.origin !== PROBE_ORIGIN) return DEFAULT_NEXT_PATH;
  if (resolved.pathname !== path) return DEFAULT_NEXT_PATH;
  return value;
}
