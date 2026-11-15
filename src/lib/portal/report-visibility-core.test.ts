import { describe, expect, it } from "vitest";
import {
  compareReleasedDesc,
  isPortalExportable,
  PORTAL_FILE_URL_SECONDS,
  portalFigures,
  visibleReportWhere,
} from "./report-visibility-core";

const holder = { companyId: "co-1", stakeholderId: "sh-a" };

describe("visibleReportWhere (P11)", () => {
  it("is exactly the plan's rule, scoped to the holder's company", () => {
    expect(visibleReportWhere(holder)).toEqual({
      companyId: "co-1",
      status: "SENT",
      publishedAt: { not: null },
      unpublishedAt: null,
      recipients: { some: { stakeholderId: "sh-a", companyId: "co-1" } },
    });
  });

  it("takes both ids from the holder and nothing else", () => {
    const where = visibleReportWhere({ companyId: "x", stakeholderId: "y" });
    expect(JSON.stringify(where)).not.toContain("co-1");
    expect(where.recipients.some).toEqual({
      stakeholderId: "y",
      companyId: "x",
    });
  });
});

describe("isPortalExportable / portalFigures (P15)", () => {
  it("exports only quarterly and annual reports", () => {
    expect(isPortalExportable("QUARTERLY")).toBe(true);
    expect(isPortalExportable("ANNUAL")).toBe(true);
    expect(isPortalExportable("TAX_K1")).toBe(false);
    expect(isPortalExportable("NOTICE")).toBe(false);
    expect(isPortalExportable("")).toBe(false);
  });

  it("shows frozen figures only on quarterly and annual reports", () => {
    const figures = { revenue: 1 };
    expect(portalFigures("QUARTERLY", figures)).toBe(figures);
    expect(portalFigures("ANNUAL", null)).toBe(null);
    expect(portalFigures("NOTICE", figures)).toBe(null);
    expect(portalFigures("TAX_K1", figures)).toBe(null);
  });
});

describe("compareReleasedDesc", () => {
  it("puts the newest release first, ties by id", () => {
    const rows = [
      { id: "b", releasedAt: new Date("2026-01-01") },
      { id: "c", releasedAt: new Date("2026-06-01") },
      { id: "a", releasedAt: new Date("2026-01-01") },
      { id: "d", releasedAt: null },
    ];
    expect(rows.sort(compareReleasedDesc).map((r) => r.id)).toEqual([
      "c",
      "a",
      "b",
      "d",
    ]);
  });
});

describe("PORTAL_FILE_URL_SECONDS", () => {
  it("is 60 seconds (P16)", () => {
    expect(PORTAL_FILE_URL_SECONDS).toBe(60);
  });
});
