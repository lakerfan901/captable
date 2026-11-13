// Member report figures, checklist and titles (03-governance.md G12; R23–R26).
// Pure: no database, no `@/` imports (vitest has no alias), so the report
// editor (G13), the PDF and the server share one definition.
//
// Cents are integer JS numbers (FOUNDATION B1). They may be negative: the
// ECONOMICS period data nets reversal rows of Manager payments and Member
// loan payments, so a single line can be below zero.

import { z } from "zod";

export type CentsNumber = number; // integer cents (FOUNDATION B1: cents cross JSON as a JS number)

export interface ReportFigures {
  source: { fetchedAt: string; periodStart: string; periodEnd: string } | null;
  revenue: { amountCents: CentsNumber | null; note: string }; // Gross Revenue (OA 6.18 definition)
  utilization: { bps: number | null; note: string }; // 0–10000; prefilled from the ledger average, editable
  expenses: {
    totalCents: CentsNumber | null;
    lines: { category: string; amountCents: CentsNumber }[];
    note: string;
  };
  managementFee: {
    accruedCents: CentsNumber | null;
    paidCents: CentsNumber | null;
    unpaidAtEndCents: CentsNumber | null;
    note: string;
  };
  reserves: {
    balanceCents: CentsNumber | null;
    minimumRequiredCents: CentsNumber | null;
    note: string;
  };
  distributions: {
    totalCents: CentsNumber | null;
    preferredReturnCents: CentsNumber | null;
    returnOfCapitalCents: CentsNumber | null;
    residualCents: CentsNumber | null;
    none: boolean;
    note: string;
  };
  managerPayments: {
    lines: {
      paidOn: string;
      payee: string;
      category: string;
      flow: "TO" | "THROUGH";
      amountCents: CentsNumber;
      memo: string | null;
      resolutionId: string | null;
    }[];
    insiderDistributions: {
      name: string;
      paymentDate: string;
      netCents: CentsNumber;
    }[];
    insiderLoanPayments: {
      name: string;
      paidOn: string;
      principalCents: CentsNumber;
      interestCents: CentsNumber;
    }[];
    grandTotalCents: CentsNumber | null;
    confirmedNone: boolean;
  };
}

export const EMPTY_FIGURES: ReportFigures = {
  source: null,
  revenue: { amountCents: null, note: "" },
  utilization: { bps: null, note: "" },
  expenses: { totalCents: null, lines: [], note: "" },
  managementFee: {
    accruedCents: null,
    paidCents: null,
    unpaidAtEndCents: null,
    note: "",
  },
  reserves: { balanceCents: null, minimumRequiredCents: null, note: "" },
  distributions: {
    totalCents: null,
    preferredReturnCents: null,
    returnOfCapitalCents: null,
    residualCents: null,
    none: false,
    note: "",
  },
  managerPayments: {
    lines: [],
    insiderDistributions: [],
    insiderLoanPayments: [],
    grandTotalCents: null,
    confirmedNone: false,
  },
};

// ---------------------------------------------------------------------------
// Schema (strict; integers only for cents; notes max 2000 chars; max 500
// lines per list; every other string bounded too).

export const MAX_NOTE_CHARS = 2000;
export const MAX_LIST_LINES = 500;

const zCentsNumber = z.number().int(); // int() = safe integer in zod 4
const zNullableCents = zCentsNumber.nullable();
const zNote = z.string().max(MAX_NOTE_CHARS);
const zYmd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const zShort = z.string().max(200);

const ReportFiguresObject = z.strictObject({
  source: z
    .strictObject({
      fetchedAt: z.string().max(40),
      periodStart: zYmd,
      periodEnd: zYmd,
    })
    .nullable(),
  revenue: z.strictObject({ amountCents: zNullableCents, note: zNote }),
  utilization: z.strictObject({
    bps: z.number().int().min(0).max(10_000).nullable(),
    note: zNote,
  }),
  expenses: z.strictObject({
    totalCents: zNullableCents,
    lines: z
      .array(z.strictObject({ category: zShort, amountCents: zCentsNumber }))
      .max(MAX_LIST_LINES),
    note: zNote,
  }),
  managementFee: z.strictObject({
    accruedCents: zNullableCents,
    paidCents: zNullableCents,
    unpaidAtEndCents: zNullableCents,
    note: zNote,
  }),
  reserves: z.strictObject({
    balanceCents: zNullableCents,
    minimumRequiredCents: zNullableCents,
    note: zNote,
  }),
  distributions: z.strictObject({
    totalCents: zNullableCents,
    preferredReturnCents: zNullableCents,
    returnOfCapitalCents: zNullableCents,
    residualCents: zNullableCents,
    none: z.boolean(),
    note: zNote,
  }),
  managerPayments: z.strictObject({
    lines: z
      .array(
        z.strictObject({
          paidOn: zYmd,
          payee: zShort,
          category: zShort,
          flow: z.enum(["TO", "THROUGH"]),
          amountCents: zCentsNumber,
          memo: zNote.nullable(),
          resolutionId: z.string().max(64).nullable(),
        }),
      )
      .max(MAX_LIST_LINES),
    insiderDistributions: z
      .array(
        z.strictObject({
          name: zShort,
          paymentDate: zYmd,
          netCents: zCentsNumber,
        }),
      )
      .max(MAX_LIST_LINES),
    insiderLoanPayments: z
      .array(
        z.strictObject({
          name: zShort,
          paidOn: zYmd,
          principalCents: zCentsNumber,
          interestCents: zCentsNumber,
        }),
      )
      .max(MAX_LIST_LINES),
    grandTotalCents: zNullableCents,
    confirmedNone: z.boolean(),
  }),
});

export const ReportFiguresSchema: z.ZodType<ReportFigures> =
  ReportFiguresObject;

// ---------------------------------------------------------------------------
// Prefill from ECONOMICS period data

/** The fields of ECONOMICS getPeriodEconomics that are used, with bigint cents already converted to numbers by the caller. */
export interface PeriodReportInput {
  revenue: { grossRevenueCents: number; averageUtilizationBps: number | null };
  expenses: {
    totalCents: number;
    byCategory: { category: string; amountCents: number }[];
  };
  managementFee: {
    accruedCents: number;
    paidCents: number;
    unpaidAtEndCents: number;
  };
  reserves: { balanceAtEndCents: number; minimumRequiredCents: number };
  distributions: {
    totalGrossCents: number;
    tierCCents: number;
    tierDCents: number;
    tierECents: number;
  };
  managerAndAffiliatePayments: {
    payments: {
      paidOn: string;
      payee: string;
      category: string;
      flow: "TO" | "THROUGH";
      amountCents: number;
      memo: string | null;
      resolutionId: string | null;
    }[];
    insiderDistributions: {
      name: string;
      paymentDate: string;
      netCents: number;
    }[];
    insiderLoanPayments: {
      name: string;
      paidOn: string;
      principalCents: number;
      interestCents: number;
    }[];
    grandTotalCents: number;
  };
}

/**
 * Figures prefilled from the ledger. With `previous` (a refresh): every
 * `note`, `managerPayments.confirmedNone` and a non-null utilization are
 * kept (utilization is editable and the ledger average may be missing or
 * defined differently; the stored figures do not record whether a value was
 * typed or prefilled, so any non-null previous value is treated as edited).
 */
export function figuresFromPeriodData(
  data: PeriodReportInput,
  period: { start: string; end: string },
  fetchedAt: string,
  previous?: ReportFigures,
): ReportFigures {
  const mp = data.managerAndAffiliatePayments;
  return {
    source: { fetchedAt, periodStart: period.start, periodEnd: period.end },
    revenue: {
      amountCents: data.revenue.grossRevenueCents,
      note: previous?.revenue.note ?? "",
    },
    utilization: {
      bps:
        previous !== undefined && previous.utilization.bps !== null
          ? previous.utilization.bps
          : data.revenue.averageUtilizationBps,
      note: previous?.utilization.note ?? "",
    },
    expenses: {
      totalCents: data.expenses.totalCents,
      lines: data.expenses.byCategory.map((l) => ({
        category: l.category,
        amountCents: l.amountCents,
      })),
      note: previous?.expenses.note ?? "",
    },
    managementFee: {
      accruedCents: data.managementFee.accruedCents,
      paidCents: data.managementFee.paidCents,
      unpaidAtEndCents: data.managementFee.unpaidAtEndCents,
      note: previous?.managementFee.note ?? "",
    },
    reserves: {
      balanceCents: data.reserves.balanceAtEndCents,
      minimumRequiredCents: data.reserves.minimumRequiredCents,
      note: previous?.reserves.note ?? "",
    },
    distributions: {
      totalCents: data.distributions.totalGrossCents,
      preferredReturnCents: data.distributions.tierCCents,
      returnOfCapitalCents: data.distributions.tierDCents,
      residualCents: data.distributions.tierECents,
      none: data.distributions.totalGrossCents === 0,
      note: previous?.distributions.note ?? "",
    },
    managerPayments: {
      lines: mp.payments.map((p) => ({
        paidOn: p.paidOn,
        payee: p.payee,
        category: p.category,
        flow: p.flow,
        amountCents: p.amountCents,
        memo: p.memo,
        resolutionId: p.resolutionId,
      })),
      insiderDistributions: mp.insiderDistributions.map((d) => ({
        name: d.name,
        paymentDate: d.paymentDate,
        netCents: d.netCents,
      })),
      insiderLoanPayments: mp.insiderLoanPayments.map((l) => ({
        name: l.name,
        paidOn: l.paidOn,
        principalCents: l.principalCents,
        interestCents: l.interestCents,
      })),
      grandTotalCents: mp.grandTotalCents,
      confirmedNone: previous?.managerPayments.confirmedNone ?? false,
    },
  };
}

// ---------------------------------------------------------------------------
// Notice kinds, checklist, titles

export const NOTICE_KINDS = {
  GENERAL: { label: "Notice to Members", section: "13.6" },
  OPERATIONS_COMMENCEMENT: {
    label: "Notice of Operations Commencement Date",
    section: "1.21",
  },
  TRANSFER_NOTICE_COPY: { label: "Copy of Transfer Notice", section: "7.1" },
  INVOLUNTARY_TRANSFER: {
    label: "Notice of Involuntary Transfer",
    section: "7.2",
  },
  TAX_PROCEEDING: {
    label: "Notice of audit or tax proceeding",
    section: "9.2",
  },
  MANAGER_RESIGNATION: {
    label: "Notice of Manager resignation",
    section: "6.20",
  },
} as const satisfies Record<string, { label: string; section: string }>;

export type NoticeKind = keyof typeof NOTICE_KINDS;

export const NOTICE_KIND_KEYS = Object.keys(NOTICE_KINDS) as [
  NoticeKind,
  ...NoticeKind[],
];

export function isNoticeKind(value: unknown): value is NoticeKind {
  return typeof value === "string" && Object.hasOwn(NOTICE_KINDS, value);
}

/** Notice kinds whose recipients are the other Preferred Members of a transfer (7.1, 7.2). */
export const TRANSFER_NOTICE_KINDS: readonly NoticeKind[] = [
  "TRANSFER_NOTICE_COPY",
  "INVOLUNTARY_TRANSFER",
];

export type MemberReportType = "QUARTERLY" | "ANNUAL" | "TAX_K1" | "NOTICE";

export interface ChecklistItem {
  key: string;
  label: string;
  section: string;
  ok: boolean;
}

function managerPaymentsItem(figures: ReportFigures): ChecklistItem {
  const mp = figures.managerPayments;
  return {
    key: "MANAGER_PAYMENTS",
    label: "Payments to or through the Manager and Affiliates",
    section: "8.2",
    ok:
      mp.lines.length +
        mp.insiderDistributions.length +
        mp.insiderLoanPayments.length >
        0 || mp.confirmedNone,
  };
}

/**
 * What must be filled before a report can be sent (R23–R26). The Management
 * Fee amount is NOT checked against revenue here: ECONOMICS owns that
 * computation.
 */
export function reportChecklist(
  type: MemberReportType,
  figures: ReportFigures,
  attachments: { kind: string; stakeholderId: string | null }[],
  commentaryEmpty: boolean,
): ChecklistItem[] {
  switch (type) {
    case "QUARTERLY":
      return [
        {
          key: "REVENUE",
          label: "Revenue",
          section: "8.2",
          ok: figures.revenue.amountCents !== null,
        },
        {
          key: "UTILIZATION",
          label: "Utilization",
          section: "8.2",
          ok: figures.utilization.bps !== null,
        },
        {
          key: "EXPENSES",
          label: "Expenses",
          section: "8.2",
          ok: figures.expenses.totalCents !== null,
        },
        {
          key: "MANAGEMENT_FEE",
          label: "Management Fee",
          section: "8.2",
          ok: figures.managementFee.accruedCents !== null,
        },
        {
          key: "RESERVES",
          label: "Reserves",
          section: "8.2; 5.6(a)",
          ok: figures.reserves.balanceCents !== null,
        },
        {
          key: "DISTRIBUTIONS",
          label: "Distributions",
          section: "8.2",
          ok:
            figures.distributions.totalCents !== null ||
            figures.distributions.none,
        },
        managerPaymentsItem(figures),
      ];
    case "ANNUAL": {
      const shared = (kind: string) =>
        attachments.some((a) => a.kind === kind && a.stakeholderId === null);
      return [
        {
          key: "BALANCE_SHEET",
          label: "Balance sheet",
          section: "8.2",
          ok: shared("BALANCE_SHEET"),
        },
        {
          key: "INCOME_STATEMENT",
          label: "Income statement",
          section: "8.2",
          ok: shared("INCOME_STATEMENT"),
        },
        managerPaymentsItem(figures),
      ];
    }
    case "TAX_K1": {
      const k1s = attachments.filter((a) => a.kind === "K1");
      return [
        {
          key: "K1_FILES",
          label: "Schedule K-1 files, each for one holder",
          section: "8.2",
          ok: k1s.length > 0 && k1s.every((a) => a.stakeholderId !== null),
        },
      ];
    }
    case "NOTICE":
      return [
        {
          key: "BODY",
          label: "Notice text",
          section: "13.6",
          ok: !commentaryEmpty,
        },
      ];
  }
}

export function defaultReportTitle(input: {
  type: string;
  fiscalYear?: number;
  fiscalQuarter?: number;
  noticeKind?: string;
}): string {
  switch (input.type) {
    case "QUARTERLY":
      return `Q${input.fiscalQuarter ?? ""} ${input.fiscalYear ?? ""} report to Members`;
    case "ANNUAL":
      return `FY${input.fiscalYear ?? ""} annual financial statements`;
    case "TAX_K1":
      return `FY${input.fiscalYear ?? ""} Schedule K-1`;
    default:
      return isNoticeKind(input.noticeKind)
        ? NOTICE_KINDS[input.noticeKind].label
        : NOTICE_KINDS.GENERAL.label;
  }
}
