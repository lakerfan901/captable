import { describe, expect, it } from "vitest";
import { parseSourceState } from "../../components/financials/team-dashboard-model";
import {
  accessNote,
  documentReason,
  financialsLine,
  previewHref,
  reportReason,
  reportSubtitle,
} from "./member-view";

const TZ = "America/Denver";
// Nov 15 in UTC, still Nov 14 in Denver: the day is the company's.
const RELEASED = new Date("2026-11-15T03:00:00.000Z");

const report = (over: Partial<Parameters<typeof reportReason>[0]> = {}) => ({
  type: "QUARTERLY",
  periodStart: "2026-07-01",
  periodEnd: "2026-09-30",
  releasedAt: RELEASED,
  hasOwnFiles: false,
  ...over,
});

describe("reportSubtitle", () => {
  it("joins the type and the period", () => {
    expect(reportSubtitle(report())).toBe(
      "Quarterly report · Jul 1 – Sep 30, 2026",
    );
  });
  it("shows only the type without a period", () => {
    expect(
      reportSubtitle(
        report({ type: "NOTICE", periodStart: null, periodEnd: null }),
      ),
    ).toBe("Notice");
  });
});

describe("reportReason", () => {
  it("names the release day in the company's zone", () => {
    expect(reportReason(report(), TZ)).toBe(
      "Released to this member on Nov 14, 2026, published in the portal.",
    );
  });
  it("explains a K-1 report shows only their own file", () => {
    expect(
      reportReason(report({ type: "TAX_K1", hasOwnFiles: true }), TZ),
    ).toBe(
      "Released to this member on Nov 14, 2026, published in the portal; only their own Schedule K-1 is shown.",
    );
  });
  it("says so when a K-1 report has no file of theirs", () => {
    expect(reportReason(report({ type: "TAX_K1" }), TZ)).toContain(
      "no Schedule K-1 of theirs is attached",
    );
  });
  it("mentions private files on other reports", () => {
    expect(
      reportReason(report({ type: "NOTICE", hasOwnFiles: true }), TZ),
    ).toContain("includes files only this member can open");
  });
  it("has a sentence without a release date", () => {
    expect(reportReason(report({ releasedAt: null }), TZ)).toBe(
      "Released to this member, published in the portal.",
    );
  });
});

describe("documentReason", () => {
  it("names the share day", () => {
    expect(documentReason({ sharedAt: RELEASED.toISOString() }, TZ)).toBe(
      "Shared with this member on Nov 14, 2026.",
    );
  });
  it("copes with a bad date", () => {
    expect(documentReason({ sharedAt: "nope" }, TZ)).toBe(
      "Shared with this member.",
    );
  });
});

describe("accessNote", () => {
  it("says nobody sees it without an active access", () => {
    expect(accessNote(0)).toMatch(/^Nobody can sign in/);
  });
  it("counts the people who see it", () => {
    expect(accessNote(1)).toMatch(/^The one person/);
    expect(accessNote(3)).toMatch(/^The 3 people/);
  });
});

describe("financialsLine", () => {
  it("reads the published-through date", () => {
    expect(financialsLine("2026-09-30", true)).toBe(
      "Financials and My investment show figures through Sep 30, 2026.",
    );
  });
  it("says when the released periods have no month figures", () => {
    expect(financialsLine("2026-09-30", false)).toMatch(
      /^Reports through Sep 30, 2026 are released to this member, but there are no month figures/,
    );
  });
  it("says nothing is published", () => {
    expect(financialsLine(null, false)).toMatch(/^No financial period/);
  });
});

describe("previewHref", () => {
  it("is absent when the preview would not open on this holder", () => {
    expect(previewHref("acme", "h1", false)).toBeNull();
  });
  it("opens the team dashboard's preview on this holder", () => {
    const href = previewHref("acme", "h1", true);
    expect(href).toBe("/acme/financials/dashboard?source=preview&holder=h1");
    // the dashboard's own parser reads it back as this holder's preview
    const params = new URL(href ?? "", "http://x").searchParams;
    expect(
      parseSourceState((k) => params.get(k), {
        canPreview: true,
        holderIds: ["h0", "h1"],
      }),
    ).toEqual({ source: "preview", holder: "h1", section: "fund" });
  });
});
