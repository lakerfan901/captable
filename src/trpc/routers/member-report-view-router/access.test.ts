import { describe, expect, test } from "vitest";
import { safeNextPath } from "../../../lib/portal/next-path";
import {
  classifyReportAccess,
  isAttachmentVisible,
  type ReportAccessRow,
  reportLandingPath,
  visibleAttachmentWhere,
} from "./access";

const NOW = new Date("2027-01-10T12:00:00.000Z");
const PUBLISHED = new Date("2027-01-05T12:00:00.000Z");

// A report released before the investor portal: never published, addressee
// never invited. Today's read-only page.
const ok: ReportAccessRow = {
  companyEntityType: "LLC",
  reportStatus: "SENT",
  tokenVersion: 2,
  tokenRevokedAt: null,
  tokenExpiresAt: new Date("2028-01-01T00:00:00.000Z"),
  publishedAt: null,
  unpublishedAt: null,
  addresseeAccess: "NONE",
};

const published: ReportAccessRow = { ...ok, publishedAt: PUBLISHED };

const access = (row: ReportAccessRow, version = 2) =>
  classifyReportAccess(row, version, NOW).access;

describe("member-report access: the token (G12)", () => {
  test("a current link of a sent report of an LLC is OK", () => {
    expect(classifyReportAccess(ok, 2, NOW)).toEqual({
      access: "OK",
      setupNeeded: false,
    });
  });

  test("not an LLC or not SENT -> NOT_FOUND (before REPLACED)", () => {
    expect(access({ ...ok, companyEntityType: "CORPORATION" })).toBe(
      "NOT_FOUND",
    );
    expect(access({ ...ok, reportStatus: "DRAFT" }, 1)).toBe("NOT_FOUND");
  });

  test("an older version or a revoked link -> REPLACED", () => {
    expect(access(ok, 1)).toBe("REPLACED");
    expect(access(ok, 3)).toBe("REPLACED");
    expect(access({ ...ok, tokenRevokedAt: NOW })).toBe("REPLACED");
  });

  test("expired row -> NOT_FOUND (exactly at expiry too)", () => {
    expect(access({ ...ok, tokenExpiresAt: NOW })).toBe("NOT_FOUND");
  });
});

describe("member-report access: the P25 table", () => {
  test("unpublished -> WITHDRAWN, whatever the addressee's access", () => {
    for (const a of ["NONE", "INVITED", "ACTIVE", "DISABLED"] as const) {
      expect(
        classifyReportAccess(
          { ...published, unpublishedAt: NOW, addresseeAccess: a },
          2,
          NOW,
        ),
      ).toEqual({ access: "WITHDRAWN", setupNeeded: false });
    }
  });

  test("published, ACTIVE with a password -> PORTAL, no set-up", () => {
    expect(
      classifyReportAccess({ ...published, addresseeAccess: "ACTIVE" }, 2, NOW),
    ).toEqual({ access: "PORTAL", setupNeeded: false });
  });

  test("published, ACTIVE without a password -> PORTAL with set-up", () => {
    expect(
      classifyReportAccess(
        { ...published, addresseeAccess: "INVITED" },
        2,
        NOW,
      ),
    ).toEqual({ access: "PORTAL", setupNeeded: true });
  });

  test("published, DISABLED -> ACCESS_OFF", () => {
    expect(access({ ...published, addresseeAccess: "DISABLED" })).toBe(
      "ACCESS_OFF",
    );
  });

  test("published, never invited at this address -> OK (read-only page)", () => {
    expect(access({ ...published, addresseeAccess: "NONE" })).toBe("OK");
  });

  test("sent before the portal (never published) -> OK, whatever the access", () => {
    for (const a of ["NONE", "INVITED", "ACTIVE", "DISABLED"] as const) {
      expect(access({ ...ok, addresseeAccess: a })).toBe("OK");
    }
  });

  test("never published and unpublished stay distinguishable", () => {
    expect(access(ok)).toBe("OK");
    expect(access({ ...ok, unpublishedAt: NOW })).toBe("WITHDRAWN");
    expect(access({ ...published, unpublishedAt: NOW })).toBe("WITHDRAWN");
  });

  test("the token checks come first: a replaced or expired link of an unpublished report", () => {
    const unpublished = { ...published, unpublishedAt: NOW };
    expect(access(unpublished, 1)).toBe("REPLACED");
    expect(access({ ...unpublished, tokenRevokedAt: NOW })).toBe("REPLACED");
    expect(access({ ...unpublished, tokenExpiresAt: NOW })).toBe("NOT_FOUND");
    const portal = { ...published, addresseeAccess: "INVITED" as const };
    expect(classifyReportAccess(portal, 1, NOW)).toEqual({
      access: "REPLACED",
      setupNeeded: false,
    });
    expect(
      access({
        ...published,
        reportStatus: "DRAFT",
        addresseeAccess: "ACTIVE",
      }),
    ).toBe("NOT_FOUND");
  });

  test("only OK carries content; set-up only on PORTAL", () => {
    for (const unpublishedAt of [null, NOW]) {
      for (const publishedAt of [null, PUBLISHED]) {
        for (const a of ["NONE", "INVITED", "ACTIVE", "DISABLED"] as const) {
          const r = classifyReportAccess(
            { ...ok, publishedAt, unpublishedAt, addresseeAccess: a },
            2,
            NOW,
          );
          if (r.setupNeeded) expect(r.access).toBe("PORTAL");
          if (r.access === "OK") {
            expect(unpublishedAt).toBeNull();
            expect(publishedAt === null || a === "NONE").toBe(true);
          }
        }
      }
    }
  });

  test("the landing path is safe and carries only the report's public id", () => {
    const path = reportLandingPath("a1b2c3d4e5f6");
    expect(path).toBe("/portal/go/report/a1b2c3d4e5f6");
    expect(safeNextPath(path)).toBe(path);
  });
});

describe("member-report attachments", () => {
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
