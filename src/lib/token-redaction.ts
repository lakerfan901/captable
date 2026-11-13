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

export const REDACTED_TOKEN = "[token]";
export const REDACTED = "[Filtered]";

/** Query parameters that carry a token or a tRPC input (which may hold one). */
const SECRET_PARAMS = /([?&](?:input|token)=)[^&#\s"']*/gi;

// Presigned storage URLs (P1): a presigned S3 PUT or GET URL is a reusable
// bearer credential until it expires (a captured PUT URL can overwrite the
// private object). Signature-bearing parameter names: AWS SigV4 (`X-Amz-*`,
// including `X-Amz-Security-Token`), AWS SigV2 (`AWSAccessKeyId`,
// `Signature`), Google Cloud Storage (`X-Goog-*`), CloudFront (`Policy`,
// `Key-Pair-Id`) and Azure SAS (`sig`).
const SIGNATURE_PARAM_NAME =
  "x-amz-[a-z0-9-]+|x-goog-[a-z0-9-]+|awsaccesskeyid|signature|sig|policy|key-pair-id";

/** A key (query-object key or `[key, value]` pair) that is a URL signature parameter or token. */
const SECRET_KEY = new RegExp(`^(?:input|token|${SIGNATURE_PARAM_NAME})$`, "i");

/** A query string (with or without its leading "?") carrying a signature parameter. */
const SIGNED_QUERY = new RegExp(`(?:^|[?&;])(?:${SIGNATURE_PARAM_NAME})=`, "i");

/** The query of a URL (or path) inside any string: "?" up to "#", whitespace or a quote. */
const QUERY_IN_TEXT = /\?[^\s"'<>#]*/g;

/** Any signature parameter's value, also in a bare query string ("X-Amz-Signature=…"). */
const SIGNATURE_PARAM_VALUE = new RegExp(
  `((?:^|[?&;])(?:${SIGNATURE_PARAM_NAME})=)[^&#\\s"']*`,
  "gi",
);

/** True when the URL (or bare query string) carries a storage signature: a presigned URL. */
export function isPresignedUrl(url: string): boolean {
  const q = url.indexOf("?");
  return SIGNED_QUERY.test(q === -1 ? url : url.slice(q));
}

/**
 * Drops the WHOLE query of every URL in `value` whose query carries a
 * signature parameter (`https://host/key?[Filtered]`), and redacts the value
 * of any remaining signature parameter (bare query strings such as Sentry's
 * `url.query` / `http.query` span attributes).
 */
export function redactSignedUrls(value: string): string {
  return value
    .replace(QUERY_IN_TEXT, (query) =>
      SIGNED_QUERY.test(query) ? `?${REDACTED}` : query,
    )
    .replace(SIGNATURE_PARAM_VALUE, `$1${REDACTED}`);
}

/** Access-log form of a path: every token-shaped segment becomes "[token]". */
export function loggablePath(pathname: string): string {
  return pathname
    .split("/")
    .map((segment) => (TOKEN_SEGMENT.test(segment) ? REDACTED_TOKEN : segment))
    .join("/");
}

/**
 * Redacts credentials inside any string (full URL, path, transaction name,
 * span description, breadcrumb message): the query of a presigned storage
 * URL (`redactSignedUrls`), `/ballots/<x>` and `/member-reports/<x>`
 * segments, the values of `input` / `token` query parameters, and any
 * JWT-shaped run.
 */
export function redactTokens(value: string): string {
  return redactSignedUrls(value)
    .replace(SECRET_PARAMS, `$1${REDACTED}`)
    .replace(TOKEN_ROUTES, `/$1/${REDACTED_TOKEN}`)
    .replace(TOKEN_ANYWHERE, REDACTED_TOKEN);
}

/**
 * Deep copy with `redactTokens` applied to every string (and the value of
 * every `input` / `token` / URL-signature key of a query-string object or
 * `[key, value]` pair replaced). Cycles and depth are bounded.
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
      SECRET_KEY.test(value[0])
    ) {
      return [value[0], REDACTED] as T;
    }
    return value.map((v) => redactDeep(v, depth + 1, seen)) as T;
  }
  if (Object.getPrototypeOf(value) !== Object.prototype) return value;
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    out[key] =
      SECRET_KEY.test(key) && typeof v === "string"
        ? REDACTED
        : redactDeep(v, depth + 1, seen);
  }
  return out as T;
}
