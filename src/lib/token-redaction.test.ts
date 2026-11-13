import { describe, expect, it } from "vitest";
import {
  scrubBreadcrumb,
  scrubEvent,
  scrubSpan,
} from "../constants/sentry-scrub";
import { loggablePath, redactDeep, redactTokens } from "./token-redaction";

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
