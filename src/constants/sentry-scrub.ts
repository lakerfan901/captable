import {
  redactSensitive,
  redactSensitiveText,
} from "../lib/sensitive-redaction";
import {
  isPresignedUrl,
  redactDeep,
  redactTokens,
} from "../lib/token-redaction";

// Sentry hooks that keep emailed-link credentials out of every event (M4),
// shared by the server, edge and browser configs. They apply the SAME token
// rule as the proxy access log (`loggablePath`, src/lib/token-redaction.ts)
// plus the `/ballots/<x>`, `/member-reports/<x>` segments and the `input` /
// `token` query parameters, to URLs, transaction and span names, breadcrumbs
// and every other string of an event.
//
// SDK v11 streams spans by default (`traceLifecycle: "stream"`) and then
// never calls `beforeSendTransaction` (it only warns that it is ignored), so
// transaction (segment span) names and attributes are scrubbed in
// `beforeSendSpan`, which runs in both lifecycles. `beforeSend` covers error
// events (request URL, query string, transaction, breadcrumbs, contexts).

type InitOptions = NonNullable<
  Parameters<typeof import("@sentry/nextjs").init>[0]
>;
type BeforeSend = NonNullable<InitOptions["beforeSend"]>;
type BeforeBreadcrumb = NonNullable<InitOptions["beforeBreadcrumb"]>;
type BeforeSendSpan = NonNullable<InitOptions["beforeSendSpan"]>;

//
// Defence in depth for sensitive FIELDS (src/lib/sensitive-redaction.ts):
// the tRPC input is redacted before it is attached (src/trpc/api/trpc.ts),
// and every event, breadcrumb and span attribute is redacted again here, so
// a bank account or routing number, a password, a secret or a token under a
// key of that name never leaves, wherever it was attached.

export const scrubEvent: BeforeSend = (event) =>
  redactSensitive(redactDeep(event));

export const scrubBreadcrumb: BeforeBreadcrumb = (breadcrumb) =>
  redactSensitive(redactDeep(breadcrumb));

export const scrubSpan = ((span: Parameters<BeforeSendSpan>[0]) => {
  // Every string field (`name` of a streamed span, `description` / `op` of
  // a static one: "PUT https://bucket/key?X-Amz-Signature=…") and every
  // attribute bag (`attributes`, `data`), in place: the SDK expects the same
  // object back.
  const s = span as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(s)) {
    if (typeof value === "string") {
      s[key] = redactSensitiveText(redactTokens(value));
    } else if (
      (key === "attributes" || key === "data") &&
      value &&
      typeof value === "object"
    ) {
      s[key] = redactSensitive(redactDeep(value));
    }
  }
  return span;
}) as BeforeSendSpan;

/**
 * Outgoing-request filter for the HTTP / fetch integrations of every runtime
 * (P1): no span and no breadcrumb is created for a presigned storage URL (an
 * S3 PUT or GET whose query carries `X-Amz-Signature` & co.), so the
 * reusable signed URL is never recorded at all. The scrubbers above still
 * drop the query of any presigned URL that reaches an event another way.
 */
export const isSignedStorageRequest = (url: string): boolean =>
  isPresignedUrl(url);

/** Every Sentry hook above, to spread into `Sentry.init`. */
export const sentryScrubbing = {
  beforeSend: scrubEvent,
  beforeBreadcrumb: scrubBreadcrumb,
  beforeSendSpan: scrubSpan,
} satisfies Partial<InitOptions>;
