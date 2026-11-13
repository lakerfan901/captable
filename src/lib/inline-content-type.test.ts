import { describe, expect, it } from "vitest";
import {
  attachmentDisposition,
  isInlineContentType,
  storedContentType,
} from "./inline-content-type";

describe("inline content types", () => {
  it("keeps PDF and raster images", () => {
    expect(storedContentType("application/pdf")).toBe("application/pdf");
    expect(storedContentType("Application/PDF; charset=binary")).toBe(
      "application/pdf",
    );
    expect(storedContentType("image/png")).toBe("image/png");
    expect(isInlineContentType("image/jpeg")).toBe(true);
  });

  it("never stores or serves script-capable types inline", () => {
    for (const t of [
      "text/html",
      "image/svg+xml",
      "application/xml",
      "text/xml",
      "application/xhtml+xml",
      "application/javascript",
      "",
      null,
      undefined,
    ]) {
      expect(isInlineContentType(t)).toBe(false);
      expect(storedContentType(t)).toBe("application/octet-stream");
    }
    expect(
      storedContentType(
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ),
    ).toBe("application/octet-stream");
  });

  it("builds a header-safe attachment disposition", () => {
    expect(attachmentDisposition("K-1 2026.xlsx")).toBe(
      'attachment; filename="K-1 2026.xlsx"',
    );
    expect(attachmentDisposition('a"b\r\ncé.csv')).toBe(
      'attachment; filename="a_b__c_.csv"',
    );
    expect(attachmentDisposition("")).toBe('attachment; filename="download"');
  });
});
