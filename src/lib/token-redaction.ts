// Redaction of emailed-link credentials (M4). Pure: no env, no Node or
// browser APIs, so the proxy access log (src/proxy.ts) and every Sentry
// runtime (server, edge, browser) share ONE rule.
//
// Emailed links (ballots, member reports, signing, updates) carry a signed
// token in the path or, for a tRPC GET, in the `input` query parameter. A
// token is a credential: it must not reach logs, Sentry events, transaction
// or span names, breadcrumbs or replays.

/** A path segment shaped like a JWT (three base64url parts). */
export const TOKEN_SEGMENT = /^[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}$/;

/** The same shape anywhere inside a string. */
const TOKEN_ANYWHERE = /[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}/g;

/** Path prefixes whose next segment is always a credential. */
const TOKEN_ROUTES = /\/(ballots|member-reports)\/[^/?#\s"']+/g;

/** Query parameters that carry a token or a tRPC input (which may hold one). */
const SECRET_PARAMS = /([?&](?:input|token)=)[^&#\s"']*/gi;

export const REDACTED_TOKEN = "[token]";
export const REDACTED = "[Filtered]";

/** Access-log form of a path: every token-shaped segment becomes "[token]". */
export function loggablePath(pathname: string): string {
  return pathname
    .split("/")
    .map((segment) => (TOKEN_SEGMENT.test(segment) ? REDACTED_TOKEN : segment))
    .join("/");
}

/**
 * Redacts credentials inside any string (full URL, path, transaction name,
 * breadcrumb message): `/ballots/<x>` and `/member-reports/<x>` segments,
 * the values of `input` / `token` query parameters, and any JWT-shaped run.
 */
export function redactTokens(value: string): string {
  return value
    .replace(SECRET_PARAMS, `$1${REDACTED}`)
    .replace(TOKEN_ROUTES, `/$1/${REDACTED_TOKEN}`)
    .replace(TOKEN_ANYWHERE, REDACTED_TOKEN);
}

/**
 * Deep copy with `redactTokens` applied to every string (and every string
 * key's value under a query-string object). Cycles and depth are bounded.
 */
export function redactDeep<T>(value: T, depth = 0, seen = new WeakSet()): T {
  if (typeof value === "string") return redactTokens(value) as T;
  if (value === null || typeof value !== "object" || depth > 12) return value;
  if (seen.has(value as object)) return value;
  seen.add(value as object);
  if (Array.isArray(value)) {
    // A query string as [key, value] pairs (Sentry's `request.query_string`).
    if (
      value.length === 2 &&
      typeof value[0] === "string" &&
      /^(input|token)$/i.test(value[0])
    ) {
      return [value[0], REDACTED] as T;
    }
    return value.map((v) => redactDeep(v, depth + 1, seen)) as T;
  }
  if (Object.getPrototypeOf(value) !== Object.prototype) return value;
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    out[key] =
      /^(input|token)$/i.test(key) && typeof v === "string"
        ? REDACTED
        : redactDeep(v, depth + 1, seen);
  }
  return out as T;
}
