import { describe, expect, it } from "vitest";
import {
  isSignedStorageRequest,
  scrubBreadcrumb,
  scrubEvent,
  scrubSpan,
} from "../constants/sentry-scrub";
import {
  isPresignedUrl,
  loggablePath,
  redactDeep,
  redactSignedUrls,
  redactTokens,
} from "./token-redaction";

const JWT =
  "eyJhbGciOiJIUzI1NiJ9.eyJwIjoicmIiLCJiIjoiY2xhYmMxMjMiLCJ2IjoxfQ.c2lnbmF0dXJlLXNpZ25hdHVyZQ";

describe("loggablePath", () => {
  it("redacts token-shaped segments only", () => {
    expect(loggablePath(`/ballots/${JWT}`)).toBe("/ballots/[token]");
    expect(loggablePath("/acme/resolutions/abc")).toBe("/acme/resolutions/abc");
  });
});

describe("redactTokens", () => {
  it.each([
    [
      `https://app.example/ballots/${JWT}`,
      "https://app.example/ballots/[token]",
    ],
    ["/ballots/short-or-odd-token", "/ballots/[token]"],
    ["/member-reports/abc.def?x=1", "/member-reports/[token]?x=1"],
    [`https://app.example/w9/${JWT}`, "https://app.example/w9/[token]"],
    ["/w9/short-or-odd-token?x=1", "/w9/[token]?x=1"],
    ["acme/w9-docs-pkt-abc.pdf", "acme/w9-docs-pkt-abc.pdf"],
    [`GET /ballots/${JWT}`, "GET /ballots/[token]"],
    [
      `/api/trpc/ballot.view?input=${encodeURIComponent(JSON.stringify({ json: { token: JWT } }))}`,
      "/api/trpc/ballot.view?input=[Filtered]",
    ],
    ["/x?a=1&token=abc&b=2", "/x?a=1&token=[Filtered]&b=2"],
    [`some text ${JWT} more`, "some text [token] more"],
  ])("%s", (input, expected) => {
    expect(redactTokens(input)).toBe(expected);
  });

  it("leaves ordinary URLs alone", () => {
    expect(redactTokens("/acme/resolutions/r1?tab=ballots")).toBe(
      "/acme/resolutions/r1?tab=ballots",
    );
  });
});

describe("Sentry hooks", () => {
  it("scrub an error event: URL, query string, transaction, breadcrumbs", () => {
    const event = {
      transaction: `/ballots/${JWT}`,
      request: {
        url: `https://app.example/ballots/${JWT}?input=x`,
        query_string: [["input", '{"token":"abc"}']],
      },
      breadcrumbs: [
        { category: "navigation", data: { from: "/", to: `/ballots/${JWT}` } },
        { category: "fetch", data: { url: `/api/trpc/x?input=${JWT}` } },
      ],
    };
    const out = JSON.stringify(
      // biome-ignore lint/suspicious/noExplicitAny: test double
      scrubEvent(event as any, {}),
    );
    expect(out).not.toContain(JWT);
    expect(out).not.toContain('\\"token\\":\\"abc\\"');
    expect(out).toContain("/ballots/[token]");
  });

  it("scrub breadcrumbs and span names / attributes", () => {
    const crumb = scrubBreadcrumb(
      { category: "navigation", data: { to: `/member-reports/${JWT}` } },
      undefined,
    );
    expect(JSON.stringify(crumb)).not.toContain(JWT);
    const span = scrubSpan({
      name: `GET /ballots/${JWT}`,
      attributes: { "url.full": `https://x/ballots/${JWT}?token=1` },
      // biome-ignore lint/suspicious/noExplicitAny: test double
    } as any);
    expect(JSON.stringify(span)).not.toContain(JWT);
    expect(span.name).toBe("GET /ballots/[token]");
  });

  it("redactDeep keeps non-plain objects and handles cycles", () => {
    const a: Record<string, unknown> = { url: `/ballots/${JWT}` };
    a.self = a;
    const out = redactDeep(a) as Record<string, unknown>;
    expect(out.url).toBe("/ballots/[token]");
    const d = new Date(0);
    expect(redactDeep({ d }).d).toBe(d);
  });
});

// P1: presigned storage URLs are reusable write/read credentials.
const SIGNED_QUERY =
  "X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Content-Sha256=UNSIGNED-PAYLOAD&X-Amz-Credential=captable%2F20261113%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20261113T120000Z&X-Amz-Expires=600&X-Amz-Signature=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef&X-Amz-SignedHeaders=host&x-id=PutObject";
const SIGNED_URL = `http://127.0.0.1:9002/captable-private/c1/generic-documents-k1-abc.pdf?${SIGNED_QUERY}`;

describe("presigned storage URLs", () => {
  it("detects SigV4, SigV2, GCS, CloudFront and SAS signatures", () => {
    expect(isPresignedUrl(SIGNED_URL)).toBe(true);
    expect(isPresignedUrl(`?${SIGNED_QUERY}`)).toBe(true);
    expect(isPresignedUrl(SIGNED_QUERY)).toBe(true);
    expect(
      isPresignedUrl(
        "https://b.s3.amazonaws.com/k?AWSAccessKeyId=AKIA&Expires=1&Signature=abc",
      ),
    ).toBe(true);
    expect(
      isPresignedUrl("https://storage.googleapis.com/b/k?X-Goog-Signature=1"),
    ).toBe(true);
    expect(isPresignedUrl("https://cdn/k?Policy=p&Key-Pair-Id=K")).toBe(true);
    expect(isPresignedUrl("https://acct.blob/k?sv=1&sig=abc")).toBe(true);
    expect(isPresignedUrl("https://app/acme/resolutions?tab=x")).toBe(false);
    expect(isPresignedUrl("https://app/x?design=1&signatures=2")).toBe(false);
    expect(isSignedStorageRequest(SIGNED_URL)).toBe(true);
  });

  it("drops the whole query of a signed URL, keeps ordinary ones", () => {
    const plain = SIGNED_URL.split("?")[0];
    expect(redactSignedUrls(SIGNED_URL)).toBe(`${plain}?[Filtered]`);
    expect(redactTokens(`PUT ${SIGNED_URL}`)).toBe(`PUT ${plain}?[Filtered]`);
    expect(redactTokens(`fetch "${SIGNED_URL}" failed`)).toBe(
      `fetch "${plain}?[Filtered]" failed`,
    );
    expect(redactTokens("/acme/resolutions/r1?tab=ballots")).toBe(
      "/acme/resolutions/r1?tab=ballots",
    );
  });

  it("redacts bare signed query strings (url.query, http.query)", () => {
    const out = redactTokens(SIGNED_QUERY);
    expect(out).not.toContain("0123456789abcdef");
    expect(out).not.toContain("captable%2F");
    expect(redactTokens(`?${SIGNED_QUERY}`)).toBe("?[Filtered]");
  });

  it("scrubs every URL-bearing field of a span, breadcrumb and event", () => {
    const span = scrubSpan({
      name: `PUT ${SIGNED_URL}`,
      description: `PUT ${SIGNED_URL}`,
      attributes: {
        url: SIGNED_URL,
        "http.url": SIGNED_URL,
        "url.full": SIGNED_URL,
        "http.query": `?${SIGNED_QUERY}`,
        "url.query": SIGNED_QUERY,
        "sentry.op": "http.client",
      },
      // biome-ignore lint/suspicious/noExplicitAny: test double
    } as any);
    const crumb = scrubBreadcrumb(
      {
        category: "fetch",
        data: { method: "PUT", url: SIGNED_URL, status_code: 200 },
      },
      undefined,
    );
    const event = scrubEvent(
      {
        request: {
          url: SIGNED_URL,
          query_string: [
            ["X-Amz-Signature", "0123456789abcdef"],
            ["X-Amz-Credential", "captable/20261113"],
          ],
        },
        extra: { query: { "X-Amz-Signature": "0123456789abcdef" } },
        exception: { values: [{ value: `Upload to ${SIGNED_URL} failed` }] },
        // biome-ignore lint/suspicious/noExplicitAny: test double
      } as any,
      {},
    );
    for (const out of [span, crumb, event]) {
      const text = JSON.stringify(out);
      expect(text).not.toContain("0123456789abcdef");
      expect(text).not.toContain("captable%2F");
      expect(text).not.toContain("captable/20261113");
    }
    expect(JSON.stringify(span)).toContain(
      "PUT http://127.0.0.1:9002/captable-private/c1/generic-documents-k1-abc.pdf?[Filtered]",
    );
  });
});
