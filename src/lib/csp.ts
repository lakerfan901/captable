// Content-Security-Policy, built per request by the proxy (src/proxy.ts) from
// the RUNTIME environment, so one build serves local MinIO and production
// storage alike. Pure (no env, no Next imports): unit-tested in csp.test.ts.
//
// Scripts: a per-request nonce with 'strict-dynamic' (Next.js reads the nonce
// from the request's CSP header and puts it on its own inline scripts and
// chunks; every page is dynamically rendered because the root layout reads
// the session). Styles: 'unsafe-inline' and no nonce, because a nonce in
// style-src would disable the inline `style` attributes React, BlockNote,
// Radix and react-pdf render. Storage: the presigned PUT/GET URLs go
// straight to the S3-compatible host, path-style or bucket-subdomain style.

export interface CspInput {
  /** Per-request nonce (base64). */
  nonce: string;
  /** `next dev`: allows eval (React refresh) and the HMR websocket. */
  isDev: boolean;
  /** NEXT_PUBLIC_BASE_URL. */
  baseUrl?: string;
  /** UPLOAD_ENDPOINT (S3 API endpoint the presigned URLs point at). */
  uploadEndpoint?: string;
  /** NEXT_PUBLIC_UPLOAD_DOMAIN (public-bucket file URLs). */
  uploadDomain?: string;
  /** UPLOAD_FORCE_PATH_STYLE: false means `<bucket>.<host>` URLs. */
  forcePathStyle: boolean;
  /** UPLOAD_BUCKET_PUBLIC / UPLOAD_BUCKET_PRIVATE. */
  buckets: (string | undefined)[];
  /** NEXT_PUBLIC_SENTRY_DSN: its ingest origin gets connect-src. */
  sentryDsn?: string;
}

/** `scheme://host[:port]` of a URL, or null when it is not an http(s) URL. */
export function originOf(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
/** An S3 bucket name usable as a DNS label (virtual-hosted style). */
const DNS_BUCKET = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;

/** Every origin the browser talks to for uploads and file previews. */
export function storageOrigins(input: CspInput): string[] {
  const out = new Set<string>();
  const endpoint = originOf(input.uploadEndpoint);
  if (endpoint) {
    out.add(endpoint);
    const url = new URL(endpoint);
    const isIp = IPV4.test(url.hostname) || url.hostname.startsWith("[");
    if (!input.forcePathStyle && !isIp) {
      for (const bucket of input.buckets) {
        if (bucket && DNS_BUCKET.test(bucket)) {
          out.add(`${url.protocol}//${bucket}.${url.host}`);
        }
      }
    }
  }
  const domain = originOf(input.uploadDomain);
  if (domain) out.add(domain);
  return [...out];
}

/** Ingest origin of a Sentry DSN (`https://key@o1.ingest.sentry.io/2`). */
export function sentryOrigin(dsn: string | undefined): string | null {
  return originOf(dsn);
}

/** The Office document viewer the file preview frames. */
const OFFICE_VIEWER = "https://view.officeapps.live.com";

export function buildCsp(input: CspInput): string {
  const storage = storageOrigins(input);
  const sentry = sentryOrigin(input.sentryDsn);
  const https = originOf(input.baseUrl)?.startsWith("https:") ?? false;

  const directives: [string, string[]][] = [
    ["default-src", ["'self'"]],
    [
      "script-src",
      [
        "'self'",
        `'nonce-${input.nonce}'`,
        "'strict-dynamic'",
        ...(input.isDev ? ["'unsafe-eval'"] : []),
      ],
    ],
    ["style-src", ["'self'", "'unsafe-inline'"]],
    // Any https image: user avatars come from Google / GitHub, and Update
    // and Member Report bodies may embed images by URL from any host (the
    // sanitizer, src/lib/sanitize-update-html.ts, allows http(s) img / video
    // / audio sources). The storage origins are listed for a plain-http
    // local store (MinIO).
    ["img-src", ["'self'", "data:", "blob:", "https:", ...storage]],
    ["font-src", ["'self'", "data:"]],
    [
      "connect-src",
      [
        "'self'",
        ...storage,
        ...(sentry ? [sentry] : []),
        ...(input.isDev ? ["ws:", "wss:"] : []),
      ],
    ],
    ["media-src", ["'self'", "blob:", "https:", ...storage]],
    ["frame-src", ["'self'", "blob:", ...storage, OFFICE_VIEWER]],
    // pdf.js (react-pdf) runs its worker from /pdf.worker.min.mjs.
    ["worker-src", ["'self'", "blob:"]],
    // Nothing in the app uses <object> / <embed>.
    ["object-src", ["'none'"]],
    ["base-uri", ["'self'"]],
    ["form-action", ["'self'"]],
    ["frame-ancestors", ["'none'"]],
    ["manifest-src", ["'self'"]],
  ];
  const policy = directives.map(
    ([name, values]) => `${name} ${values.join(" ")}`,
  );
  if (https) policy.push("upgrade-insecure-requests");
  return policy.join("; ");
}

/**
 * The framing / base / plugin / form-target policy that is enforced even
 * when the full policy runs report-only (`frame-ancestors` is ignored in a
 * report-only policy).
 */
export const BASELINE_CSP =
  "frame-ancestors 'none'; base-uri 'self'; object-src 'none'; form-action 'self'";

/** CSP_MODE=report-only switches the full policy to report-only. */
export function cspReportOnly(mode: string | undefined): boolean {
  return mode?.trim().toLowerCase() === "report-only";
}
