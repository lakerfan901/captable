import { describe, expect, it } from "vitest";
import {
  refusalMessage,
  releaseAuditSummary,
  reportDeadlineKeys,
} from "./release-core";

describe("refusalMessage", () => {
  const names = new Map([
    ["p1", "P Prospect"],
    ["p2", "Q Prospect"],
    ["k1", "K Holder"],
  ]);
  const nameOf = (id: string) => names.get(id);

  it("states each reason once with the names it concerns", () => {
    expect(
      refusalMessage(
        [
          {
            code: "PROSPECT",
            stakeholderId: "p1",
            message: "A prospect cannot receive a report.",
          },
          {
            code: "K1_MISSING",
            stakeholderId: "k1",
            message: "A selected holder has no K-1 attached to this report.",
          },
          {
            code: "PROSPECT",
            stakeholderId: "p2",
            message: "A prospect cannot receive a report.",
          },
        ],
        nameOf,
      ),
    ).toBe(
      "A prospect cannot receive a report. (P Prospect, Q Prospect) A selected holder has no K-1 attached to this report. (K Holder)",
    );
  });

  it("never shows an unknown id", () => {
    const message = refusalMessage(
      [
        {
          code: "UNKNOWN_HOLDER",
          stakeholderId: "foreign-id-123",
          message: "A selected holder does not belong to this company.",
        },
      ],
      nameOf,
    );
    expect(message).toBe("A selected holder does not belong to this company.");
    expect(message).not.toContain("foreign-id-123");
  });

  it("keeps messages without a holder", () => {
    expect(
      refusalMessage(
        [{ code: "EMPTY", message: "Select at least one holder." }],
        nameOf,
      ),
    ).toBe("Select at least one holder.");
  });
});

describe("reportDeadlineKeys", () => {
  it("quarterly and annual reports satisfy their period's deadline", () => {
    expect(
      reportDeadlineKeys({
        type: "QUARTERLY",
        fiscalYear: 2026,
        fiscalQuarter: 3,
      }),
    ).toEqual(["QUARTERLY_REPORT:2026Q3"]);
    expect(
      reportDeadlineKeys({
        type: "ANNUAL",
        fiscalYear: 2026,
        fiscalQuarter: null,
      }),
    ).toEqual(["ANNUAL_FINANCIALS:2026"]);
  });

  it("K-1 reports and notices have no period deadline of their own", () => {
    expect(
      reportDeadlineKeys({
        type: "TAX_K1",
        fiscalYear: 2026,
        fiscalQuarter: null,
      }),
    ).toEqual([]);
    expect(
      reportDeadlineKeys({
        type: "NOTICE",
        fiscalYear: null,
        fiscalQuarter: null,
      }),
    ).toEqual([]);
    expect(
      reportDeadlineKeys({
        type: "QUARTERLY",
        fiscalYear: 2026,
        fiscalQuarter: null,
      }),
    ).toEqual([]);
  });
});

describe("releaseAuditSummary", () => {
  const base = {
    userName: "Kim",
    title: "Q3 2026 report to Members",
    recipientNames: ["A Preferred", "B Preferred"],
    emailed: true,
    booksClosedThrough: "2026-09-30",
    deadlinesDone: ["QUARTERLY_REPORT:2026Q3"],
    k1Missing: [],
    fiscalYear: 2026,
    deadlinesLeftOpen: [],
  };

  it("names the holders, the email, the books and the deadlines done", () => {
    expect(releaseAuditSummary(base)).toBe(
      'Kim released the report "Q3 2026 report to Members" to 2 recipients (A Preferred, B Preferred); emailed; books closed through 2026-09-30; deadlines done: QUARTERLY_REPORT:2026Q3',
    );
  });

  it("says when the report is only in the portal and the deadline stays open", () => {
    expect(
      releaseAuditSummary({
        ...base,
        recipientNames: ["A Preferred"],
        emailed: false,
        deadlinesDone: [],
        deadlinesLeftOpen: ["QUARTERLY_REPORT:2026Q3"],
      }),
    ).toBe(
      'Kim released the report "Q3 2026 report to Members" to 1 recipient (A Preferred); not emailed (published in the portal only); books closed through 2026-09-30; deadlines stay open because the report is not emailed: QUARTERLY_REPORT:2026Q3',
    );
  });

  it("says why an emailed release to part of the Members leaves it open", () => {
    expect(
      releaseAuditSummary({
        ...base,
        deadlinesDone: [],
        deadlinesLeftOpen: ["QUARTERLY_REPORT:2026Q3"],
      }),
    ).toContain(
      "deadlines stay open because not every holder of the default audience is selected: QUARTERLY_REPORT:2026Q3",
    );
  });

  it("keeps the K-1 coverage sentence", () => {
    expect(
      releaseAuditSummary({
        ...base,
        title: "FY2026 Schedule K-1",
        booksClosedThrough: null,
        deadlinesDone: [],
        k1Missing: ["B Holder", "F Interest"],
      }),
    ).toBe(
      'Kim released the report "FY2026 Schedule K-1" to 2 recipients (A Preferred, B Preferred); emailed; FY2026 K-1 deadlines stay open, no K-1 delivered yet to: B Holder, F Interest',
    );
  });
});
