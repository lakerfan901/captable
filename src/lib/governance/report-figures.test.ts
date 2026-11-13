import { describe, expect, test } from "vitest";
import {
  defaultReportTitle,
  EMPTY_FIGURES,
  figuresFromPeriodData,
  isNoticeKind,
  type PeriodReportInput,
  type ReportFigures,
  ReportFiguresSchema,
  reportChecklist,
} from "./report-figures";

function filled(): ReportFigures {
  return {
    ...EMPTY_FIGURES,
    revenue: { amountCents: 12_500_000, note: "" },
    utilization: { bps: 8250, note: "" },
    expenses: { totalCents: 4_100_000, lines: [], note: "" },
    managementFee: {
      accruedCents: 625_000,
      paidCents: null,
      unpaidAtEndCents: null,
      note: "",
    },
    reserves: { balanceCents: 5_000_000, minimumRequiredCents: null, note: "" },
    distributions: { ...EMPTY_FIGURES.distributions, none: true },
    managerPayments: { ...EMPTY_FIGURES.managerPayments, confirmedNone: true },
  };
}

const PERIOD_DATA: PeriodReportInput = {
  revenue: { grossRevenueCents: 9_000_000, averageUtilizationBps: 7000 },
  expenses: {
    totalCents: 1_000_000,
    byCategory: [{ category: "HOSTING", amountCents: 1_000_000 }],
  },
  managementFee: { accruedCents: 450_000, paidCents: 0, unpaidAtEndCents: 0 },
  reserves: { balanceAtEndCents: 2_000_000, minimumRequiredCents: 1_000_000 },
  distributions: {
    totalGrossCents: 0,
    tierCCents: 0,
    tierDCents: 0,
    tierECents: 0,
  },
  managerAndAffiliatePayments: {
    payments: [],
    insiderDistributions: [],
    insiderLoanPayments: [],
    grandTotalCents: 0,
  },
};

describe("report-figures", () => {
  test("1: EMPTY_FIGURES -> QUARTERLY checklist has 7 items, all not ok", () => {
    const list = reportChecklist("QUARTERLY", EMPTY_FIGURES, [], true);
    expect(list).toHaveLength(7);
    expect(list.every((i) => !i.ok)).toBe(true);
    expect(list.map((i) => i.key)).toEqual([
      "REVENUE",
      "UTILIZATION",
      "EXPENSES",
      "MANAGEMENT_FEE",
      "RESERVES",
      "DISTRIBUTIONS",
      "MANAGER_PAYMENTS",
    ]);
    expect(list.find((i) => i.key === "RESERVES")?.section).toBe("8.2; 5.6(a)");
    expect(ReportFiguresSchema.safeParse(EMPTY_FIGURES).success).toBe(true);
  });

  test("2: filled figures -> all 7 ok; non-integer cents rejected", () => {
    const figures = filled();
    const list = reportChecklist("QUARTERLY", figures, [], true);
    expect(list).toHaveLength(7);
    expect(list.every((i) => i.ok)).toBe(true);
    expect(ReportFiguresSchema.safeParse(figures).success).toBe(true);

    const bad = {
      ...figures,
      revenue: { amountCents: 12_500_000.5, note: "" },
    };
    expect(ReportFiguresSchema.safeParse(bad).success).toBe(false);
    // Strict: unknown keys are rejected too.
    expect(
      ReportFiguresSchema.safeParse({ ...figures, extra: 1 }).success,
    ).toBe(false);
    // Notes are bounded.
    expect(
      ReportFiguresSchema.safeParse({
        ...figures,
        revenue: { amountCents: 1, note: "x".repeat(2001) },
      }).success,
    ).toBe(false);
  });

  test("3: ANNUAL with only a balance sheet -> INCOME_STATEMENT not ok; a private balance sheet does not count", () => {
    const figures = filled();
    const onlyBalance = reportChecklist(
      "ANNUAL",
      figures,
      [{ kind: "BALANCE_SHEET", stakeholderId: null }],
      true,
    );
    expect(onlyBalance).toHaveLength(3);
    expect(onlyBalance.find((i) => i.key === "BALANCE_SHEET")?.ok).toBe(true);
    expect(onlyBalance.find((i) => i.key === "INCOME_STATEMENT")?.ok).toBe(
      false,
    );
    expect(onlyBalance.find((i) => i.key === "MANAGER_PAYMENTS")?.ok).toBe(
      true,
    );

    const privateBalance = reportChecklist(
      "ANNUAL",
      figures,
      [
        { kind: "BALANCE_SHEET", stakeholderId: "s1" },
        { kind: "INCOME_STATEMENT", stakeholderId: null },
      ],
      true,
    );
    expect(privateBalance.find((i) => i.key === "BALANCE_SHEET")?.ok).toBe(
      false,
    );
    expect(privateBalance.find((i) => i.key === "INCOME_STATEMENT")?.ok).toBe(
      true,
    );
  });

  test("4: TAX_K1 with one K1 lacking stakeholderId -> not ok", () => {
    const list = reportChecklist(
      "TAX_K1",
      EMPTY_FIGURES,
      [
        { kind: "K1", stakeholderId: "s1" },
        { kind: "K1", stakeholderId: null },
      ],
      true,
    );
    expect(list).toHaveLength(1);
    expect(list[0]?.key).toBe("K1_FILES");
    expect(list[0]?.ok).toBe(false);
    expect(
      reportChecklist(
        "TAX_K1",
        EMPTY_FIGURES,
        [{ kind: "K1", stakeholderId: "s1" }],
        true,
      )[0]?.ok,
    ).toBe(true);
    expect(reportChecklist("TAX_K1", EMPTY_FIGURES, [], true)[0]?.ok).toBe(
      false,
    );
  });

  test("5: figuresFromPeriodData keeps the previous utilization and notes", () => {
    const previous: ReportFigures = {
      ...filled(),
      revenue: { amountCents: 1, note: "Revenue note" },
      utilization: { bps: 8250, note: "Measured by GPU-hours" },
      reserves: {
        balanceCents: 1,
        minimumRequiredCents: 1,
        note: "Reserve note",
      },
      managerPayments: {
        ...EMPTY_FIGURES.managerPayments,
        confirmedNone: true,
      },
    };
    const out = figuresFromPeriodData(
      PERIOD_DATA,
      { start: "2026-10-01", end: "2026-12-31" },
      "2027-01-05T00:00:00.000Z",
      previous,
    );
    expect(out.utilization).toEqual({
      bps: 8250,
      note: "Measured by GPU-hours",
    });
    expect(out.revenue).toEqual({
      amountCents: 9_000_000,
      note: "Revenue note",
    });
    expect(out.reserves.note).toBe("Reserve note");
    expect(out.reserves.balanceCents).toBe(2_000_000);
    expect(out.managerPayments.confirmedNone).toBe(true);
    expect(out.distributions.none).toBe(true);
    expect(out.source).toEqual({
      fetchedAt: "2027-01-05T00:00:00.000Z",
      periodStart: "2026-10-01",
      periodEnd: "2026-12-31",
    });
    expect(ReportFiguresSchema.safeParse(out).success).toBe(true);

    // Without previous: the ledger average is used and notes are empty.
    const fresh = figuresFromPeriodData(
      PERIOD_DATA,
      { start: "2026-10-01", end: "2026-12-31" },
      "2027-01-05T00:00:00.000Z",
    );
    expect(fresh.utilization).toEqual({ bps: 7000, note: "" });
    expect(fresh.managerPayments.confirmedNone).toBe(false);
    expect(fresh.expenses.lines).toEqual([
      { category: "HOSTING", amountCents: 1_000_000 },
    ]);

    // A null previous utilization takes the ledger average.
    const nullPrev = figuresFromPeriodData(
      PERIOD_DATA,
      { start: "2026-10-01", end: "2026-12-31" },
      "2027-01-05T00:00:00.000Z",
      { ...previous, utilization: { bps: null, note: "n" } },
    );
    expect(nullPrev.utilization).toEqual({ bps: 7000, note: "n" });
  });

  test("6: management fee sanity is NOT checked here", () => {
    // 1 cent of fee on 125,000.00 of revenue is far from 5%; still ok.
    const figures: ReportFigures = {
      ...filled(),
      managementFee: {
        accruedCents: 1,
        paidCents: 0,
        unpaidAtEndCents: 1,
        note: "",
      },
    };
    const list = reportChecklist("QUARTERLY", figures, [], true);
    expect(list.find((i) => i.key === "MANAGEMENT_FEE")?.ok).toBe(true);
    expect(list.every((i) => i.ok)).toBe(true);
  });

  test("NOTICE needs a body; titles", () => {
    expect(reportChecklist("NOTICE", EMPTY_FIGURES, [], true)[0]?.ok).toBe(
      false,
    );
    expect(reportChecklist("NOTICE", EMPTY_FIGURES, [], false)[0]).toEqual({
      key: "BODY",
      label: "Notice text",
      section: "13.6",
      ok: true,
    });
    expect(
      defaultReportTitle({
        type: "QUARTERLY",
        fiscalYear: 2026,
        fiscalQuarter: 4,
      }),
    ).toBe("Q4 2026 report to Members");
    expect(defaultReportTitle({ type: "ANNUAL", fiscalYear: 2026 })).toBe(
      "FY2026 annual financial statements",
    );
    expect(defaultReportTitle({ type: "TAX_K1", fiscalYear: 2026 })).toBe(
      "FY2026 Schedule K-1",
    );
    expect(
      defaultReportTitle({
        type: "NOTICE",
        noticeKind: "TRANSFER_NOTICE_COPY",
      }),
    ).toBe("Copy of Transfer Notice");
    expect(isNoticeKind("GENERAL")).toBe(true);
    expect(isNoticeKind("toString")).toBe(false);
    expect(isNoticeKind("__proto__")).toBe(false);
  });

  test("negative cents (netted reversals) are valid integers", () => {
    const figures: ReportFigures = {
      ...filled(),
      managerPayments: {
        lines: [
          {
            paidOn: "2026-11-01",
            payee: "Manager",
            category: "MANAGEMENT_FEE",
            flow: "TO",
            amountCents: -1000,
            memo: null,
            resolutionId: null,
          },
        ],
        insiderDistributions: [],
        insiderLoanPayments: [],
        grandTotalCents: -1000,
        confirmedNone: false,
      },
    };
    expect(ReportFiguresSchema.safeParse(figures).success).toBe(true);
  });
});
