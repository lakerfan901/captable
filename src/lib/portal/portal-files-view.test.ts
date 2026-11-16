import { describe, expect, it } from "vitest";
import {
  categoryLabel,
  fileOpenMode,
  formatDay,
  formatFileSize,
  formatYmd,
  iconTypeHint,
  periodText,
  refusalAction,
  reportTypeShort,
  splitAttachments,
  trpcErrorCode,
  viewerKind,
} from "./portal-files-view";
import { portalNavItems } from "./portal-nav";

describe("reportTypeShort", () => {
  it("labels the four types and never prints a raw enum", () => {
    expect(reportTypeShort("QUARTERLY")).toBe("Quarterly report");
    expect(reportTypeShort("ANNUAL")).toBe("Annual financial statements");
    expect(reportTypeShort("TAX_K1")).toBe("Schedule K-1");
    expect(reportTypeShort("NOTICE")).toBe("Notice");
    expect(reportTypeShort("SOMETHING_NEW")).toBe("Report");
  });
});

describe("periodText", () => {
  it("compacts a period within one year", () => {
    expect(periodText("2026-07-01", "2026-09-30")).toBe("Jul 1 – Sep 30, 2026");
  });
  it("spells both years across a year end", () => {
    expect(periodText("2025-12-01", "2026-01-31")).toBe(
      "Dec 1, 2025 – Jan 31, 2026",
    );
  });
  it("shows one known end, and nothing without a period", () => {
    expect(periodText(null, "2026-12-31")).toBe("Dec 31, 2026");
    expect(periodText("2026-01-01", null)).toBe("Jan 1, 2026");
    expect(periodText(null, null)).toBe("");
  });
  it("leaves a malformed date as it is", () => {
    expect(formatYmd("2026-13-01")).toBe("2026-13-01");
  });
});

describe("formatDay", () => {
  it("formats in the company's zone", () => {
    // 03:00 UTC on Oct 29 is still Oct 28 in New York.
    expect(
      formatDay(new Date("2026-10-29T03:00:00Z"), "America/New_York"),
    ).toBe("Oct 28, 2026");
    expect(formatDay("2026-10-29T03:00:00Z", "UTC")).toBe("Oct 29, 2026");
    expect(formatDay("2026-10-29T03:00:00Z", "UTC", "long")).toBe(
      "October 29, 2026",
    );
  });
  it("falls back to UTC for a bad zone and shows nothing for no date", () => {
    expect(formatDay(new Date("2026-10-29T03:00:00Z"), "Not/AZone")).toBe(
      "Oct 29, 2026",
    );
    expect(formatDay(null, "UTC")).toBe("");
    expect(formatDay("garbage", "UTC")).toBe("");
  });
});

describe("formatFileSize", () => {
  it("formats bytes, KB, MB", () => {
    expect(formatFileSize(0)).toBe("0 bytes");
    expect(formatFileSize(1)).toBe("1 byte");
    expect(formatFileSize(820)).toBe("820 bytes");
    expect(formatFileSize(1024)).toBe("1 KB");
    expect(formatFileSize(1536)).toBe("1.5 KB");
    expect(formatFileSize(540 * 1024)).toBe("540 KB");
    expect(formatFileSize(2.4 * 1024 * 1024)).toBe("2.4 MB");
  });
  it("never shows 1024 of a unit", () => {
    expect(formatFileSize(1024 * 1024 - 1)).toBe("1.0 MB");
  });
  it("shows nothing for an impossible size", () => {
    expect(formatFileSize(-1)).toBe("");
    expect(formatFileSize(Number.NaN)).toBe("");
  });
});

describe("categoryLabel", () => {
  it("labels known categories and hides the rest", () => {
    expect(categoryLabel("ARTICLES_AND_AGREEMENT")).toBe("Governing documents");
    expect(categoryLabel("FINANCIAL_STATEMENTS")).toBe("Financial statements");
    expect(categoryLabel(null)).toBe("");
    expect(categoryLabel("UNKNOWN")).toBe("");
  });
});

describe("splitAttachments", () => {
  it("puts private files under 'Your documents' and keeps the order", () => {
    const files = [
      { id: "1", private: false },
      { id: "2", private: true },
      { id: "3", private: false },
      { id: "4", private: true },
    ];
    const { own, shared } = splitAttachments(files);
    expect(own.map((f) => f.id)).toEqual(["2", "4"]);
    expect(shared.map((f) => f.id)).toEqual(["1", "3"]);
  });
  it("gives two empty lists for no files", () => {
    expect(splitAttachments([])).toEqual({ own: [], shared: [] });
  });
});

describe("iconTypeHint", () => {
  it("reads the extension, case-insensitively", () => {
    expect(iconTypeHint("Operating Agreement.PDF")).toBe("pdf");
    expect(iconTypeHint("wire.jpeg")).toBe("image");
    expect(iconTypeHint("Q3 package.xlsx")).toBe("sheet");
    expect(iconTypeHint("deck.pptx")).toBe("presentation");
    expect(iconTypeHint("letter.docx")).toBe("word");
    expect(iconTypeHint("Exhibit B — Alder Ridge")).toBe("");
    expect(iconTypeHint("archive.zip")).toBe("");
  });
});

describe("fileOpenMode and viewerKind", () => {
  it("views inline files and downloads the rest", () => {
    expect(fileOpenMode(true)).toBe("view");
    expect(fileOpenMode(false)).toBe("download");
  });
  it("draws PDFs and raster images only", () => {
    expect(viewerKind("application/pdf")).toBe("pdf");
    expect(viewerKind("Application/PDF; charset=binary")).toBe("pdf");
    expect(viewerKind("image/png")).toBe("image");
    expect(viewerKind("image/jpeg")).toBe("image");
    expect(viewerKind("image/svg+xml")).toBe("none");
    expect(viewerKind("text/html")).toBe("none");
    expect(viewerKind("application/octet-stream")).toBe("none");
    expect(viewerKind(null)).toBe("none");
  });
});

describe("portal navigation after P8b", () => {
  it("lists Reports and Documents as built sections", () => {
    const keys = portalNavItems("acc_1").map((i) => i.key);
    expect(keys).toContain("reports");
    expect(keys).toContain("documents");
  });
});

describe("refusalAction and trpcErrorCode", () => {
  it("reloads the page when the item, the access or the session is gone", () => {
    expect(refusalAction("NOT_FOUND")).toBe("reload");
    expect(refusalAction("UNAUTHORIZED")).toBe("reload");
    expect(refusalAction("FORBIDDEN")).toBe("reload");
    expect(refusalAction("INTERNAL_SERVER_ERROR")).toBe("retry");
    expect(refusalAction(null)).toBe("retry");
  });
  it("reads the code of a tRPC client error", () => {
    expect(trpcErrorCode({ data: { code: "NOT_FOUND" } })).toBe("NOT_FOUND");
    expect(trpcErrorCode(new Error("x"))).toBeNull();
    expect(trpcErrorCode(null)).toBeNull();
    expect(trpcErrorCode({ data: { code: 3 } })).toBeNull();
  });
});
