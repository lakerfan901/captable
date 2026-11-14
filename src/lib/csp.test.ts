import { describe, expect, it } from "vitest";
import {
  buildCsp,
  type CspInput,
  cspReportOnly,
  originOf,
  storageOrigins,
} from "./csp";

const local: CspInput = {
  nonce: "bm9uY2U=",
  isDev: false,
  baseUrl: "http://localhost:3000",
  uploadEndpoint: "http://127.0.0.1:9002",
  uploadDomain: "http://127.0.0.1:9002",
  forcePathStyle: false,
  buckets: ["captable-public-bucket", "captable-private-bucket"],
};

const production: CspInput = {
  nonce: "bm9uY2U=",
  isDev: false,
  baseUrl: "https://app.example.com",
  uploadEndpoint: "https://s3.us-east-1.example-storage.com",
  uploadDomain: "https://files.example.com/",
  forcePathStyle: false,
  buckets: ["acme-public", "acme-private"],
  sentryDsn: "https://abc123@o42.ingest.us.sentry.io/7",
};

const directive = (policy: string, name: string) =>
  policy
    .split("; ")
    .find((d) => d.startsWith(`${name} `))
    ?.split(" ")
    .slice(1) ?? [];

describe("originOf", () => {
  it("keeps scheme, host and port only", () => {
    expect(originOf("https://files.example.com/a/b?x=1")).toBe(
      "https://files.example.com",
    );
    expect(originOf("http://127.0.0.1:9002")).toBe("http://127.0.0.1:9002");
  });
  it("rejects anything that is not http(s)", () => {
    expect(originOf(undefined)).toBeNull();
    expect(originOf("")).toBeNull();
    expect(originOf("not a url")).toBeNull();
    expect(originOf("javascript:alert(1)")).toBeNull();
    expect(originOf("data:text/html,x")).toBeNull();
  });
});

describe("storageOrigins", () => {
  it("is the endpoint itself for an IP endpoint (MinIO), even when not path-style", () => {
    expect(storageOrigins(local)).toEqual(["http://127.0.0.1:9002"]);
  });

  it("adds bucket subdomains for virtual-hosted style on a hostname", () => {
    expect(storageOrigins(production)).toEqual([
      "https://s3.us-east-1.example-storage.com",
      "https://acme-public.s3.us-east-1.example-storage.com",
      "https://acme-private.s3.us-east-1.example-storage.com",
      "https://files.example.com",
    ]);
  });

  it("has no bucket subdomains when path-style is forced", () => {
    expect(
      storageOrigins({
        ...production,
        forcePathStyle: true,
        uploadDomain: undefined,
      }),
    ).toEqual(["https://s3.us-east-1.example-storage.com"]);
  });

  it("skips bucket names that cannot be a DNS label", () => {
    expect(
      storageOrigins({
        ...production,
        uploadDomain: undefined,
        buckets: ["Bad_Bucket", undefined, "ok-bucket"],
      }),
    ).toEqual([
      "https://s3.us-east-1.example-storage.com",
      "https://ok-bucket.s3.us-east-1.example-storage.com",
    ]);
  });
});

describe("buildCsp", () => {
  it("puts the nonce and strict-dynamic in script-src, no unsafe-inline / eval in production", () => {
    const p = buildCsp(production);
    expect(directive(p, "script-src")).toEqual([
      "'self'",
      "'nonce-bm9uY2U='",
      "'strict-dynamic'",
    ]);
    expect(p).not.toContain("unsafe-eval");
    expect(directive(p, "script-src")).not.toContain("'unsafe-inline'");
  });

  it("allows inline styles without a style nonce (a nonce would disable them)", () => {
    expect(directive(buildCsp(production), "style-src")).toEqual([
      "'self'",
      "'unsafe-inline'",
    ]);
  });

  it("lets the browser reach the storage hosts for uploads and previews", () => {
    const p = buildCsp(production);
    for (const name of ["connect-src", "img-src", "frame-src", "media-src"]) {
      expect(directive(p, name)).toContain(
        "https://acme-private.s3.us-east-1.example-storage.com",
      );
    }
    expect(directive(p, "connect-src")).toContain(
      "https://o42.ingest.us.sentry.io",
    );
  });

  it("allows any https image or media (avatars, images embedded in updates) but not any https connection", () => {
    const p = buildCsp(production);
    expect(directive(p, "img-src")).toContain("https:");
    expect(directive(p, "media-src")).toContain("https:");
    expect(directive(p, "connect-src")).not.toContain("https:");
    expect(directive(p, "frame-src")).not.toContain("https:");
  });

  it("never names a local host in a production-shaped policy", () => {
    const p = buildCsp(production);
    expect(p).not.toMatch(/localhost|127\.0\.0\.1|minio/);
  });

  it("builds the local policy from the local env", () => {
    const p = buildCsp(local);
    expect(directive(p, "connect-src")).toEqual([
      "'self'",
      "http://127.0.0.1:9002",
    ]);
    expect(p).not.toContain("upgrade-insecure-requests");
  });

  it("keeps the framing / plugin / base / form rules", () => {
    const p = buildCsp(production);
    expect(directive(p, "frame-ancestors")).toEqual(["'none'"]);
    expect(directive(p, "object-src")).toEqual(["'none'"]);
    expect(directive(p, "base-uri")).toEqual(["'self'"]);
    expect(directive(p, "form-action")).toEqual(["'self'"]);
    expect(directive(p, "worker-src")).toEqual(["'self'", "blob:"]);
    expect(p.endsWith("upgrade-insecure-requests")).toBe(true);
  });

  it("allows eval and the HMR websocket only in development", () => {
    const p = buildCsp({ ...local, isDev: true });
    expect(directive(p, "script-src")).toContain("'unsafe-eval'");
    expect(directive(p, "connect-src")).toContain("ws:");
  });

  it("ignores a malformed DSN or endpoint instead of emitting it", () => {
    const p = buildCsp({
      ...production,
      sentryDsn: "not a dsn",
      uploadEndpoint: "javascript:alert(1)",
      uploadDomain: "x; script-src *",
    });
    expect(directive(p, "connect-src")).toEqual(["'self'"]);
    expect(p).not.toContain("script-src *");
  });
});

describe("cspReportOnly", () => {
  it("is true only for report-only", () => {
    expect(cspReportOnly("report-only")).toBe(true);
    expect(cspReportOnly(" Report-Only ")).toBe(true);
    expect(cspReportOnly(undefined)).toBe(false);
    expect(cspReportOnly("enforce")).toBe(false);
  });
});
