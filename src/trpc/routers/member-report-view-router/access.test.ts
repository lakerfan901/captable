import { describe, expect, test } from "vitest";
import {
  classifyReportAccess,
  isAttachmentVisible,
  type ReportAccessRow,
  visibleAttachmentWhere,
} from "./access";

const NOW = new Date("2027-01-10T12:00:00.000Z");

const ok: ReportAccessRow = {
  companyEntityType: "LLC",
  reportStatus: "SENT",
  tokenVersion: 2,
  tokenRevokedAt: null,
  tokenExpiresAt: new Date("2028-01-01T00:00:00.000Z"),
};

describe("member-report access", () => {
  test("a current link of a sent report of an LLC is OK", () => {
    expect(classifyReportAccess(ok, 2, NOW)).toBe("OK");
  });

  test("not an LLC or not SENT -> NOT_FOUND (before REPLACED)", () => {
    expect(
      classifyReportAccess({ ...ok, companyEntityType: "CORPORATION" }, 2, NOW),
    ).toBe("NOT_FOUND");
    expect(classifyReportAccess({ ...ok, reportStatus: "DRAFT" }, 1, NOW)).toBe(
      "NOT_FOUND",
    );
  });

  test("an older version or a revoked link -> REPLACED", () => {
    expect(classifyReportAccess(ok, 1, NOW)).toBe("REPLACED");
    expect(classifyReportAccess(ok, 3, NOW)).toBe("REPLACED");
    expect(classifyReportAccess({ ...ok, tokenRevokedAt: NOW }, 2, NOW)).toBe(
      "REPLACED",
    );
  });

  test("expired row -> NOT_FOUND (exactly at expiry too)", () => {
    expect(classifyReportAccess({ ...ok, tokenExpiresAt: NOW }, 2, NOW)).toBe(
      "NOT_FOUND",
    );
  });

  test("attachments: shared + own; never another holder's; TAX_K1 own only", () => {
    expect(isAttachmentVisible({ stakeholderId: null }, "a", "QUARTERLY")).toBe(
      true,
    );
    expect(isAttachmentVisible({ stakeholderId: "a" }, "a", "QUARTERLY")).toBe(
      true,
    );
    expect(isAttachmentVisible({ stakeholderId: "b" }, "a", "QUARTERLY")).toBe(
      false,
    );
    expect(isAttachmentVisible({ stakeholderId: "a" }, "a", "TAX_K1")).toBe(
      true,
    );
    expect(isAttachmentVisible({ stakeholderId: "b" }, "a", "TAX_K1")).toBe(
      false,
    );
    expect(isAttachmentVisible({ stakeholderId: null }, "a", "TAX_K1")).toBe(
      false,
    );
    expect(visibleAttachmentWhere("a", "TAX_K1")).toEqual({
      stakeholderId: "a",
    });
    expect(visibleAttachmentWhere("a", "ANNUAL")).toEqual({
      OR: [{ stakeholderId: null }, { stakeholderId: "a" }],
    });
  });
});
