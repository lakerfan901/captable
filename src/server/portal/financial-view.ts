import "server-only";

import type { Prisma } from "@prisma/client";
import { fromDateOnly, toDateOnly } from "@/lib/date-only";
import { GOVERNANCE_TIME_ZONE, todayInZone } from "@/lib/governance/dates";
import { OA_DEFAULTS } from "@/lib/llc/config";
import type { IsoDate } from "@/lib/llc/dates";
import {
  type DashboardPeriod,
  dashboardPeriods,
  selfHolderMonth,
  visibleRestatement,
} from "@/lib/llc/financial-dashboard-core";
import { type MonthKey, monthEnd } from "@/lib/llc/financial-periods";
import {
  canonicalJson,
  type FundMonthJson,
  fundMonthToJson,
  type HolderMonthJson,
  HolderMonthJsonSchema,
  holderMonthToJson,
} from "@/lib/llc/financial-series";
import { computeTermClock } from "@/lib/llc/term";
import {
  type ReportHolder,
  visibleReportWhere,
} from "@/lib/portal/report-visibility-core";
import type { TPrismaOrTransaction } from "@/server/db";
import {
  latestSnapshotMonth,
  publishedThroughFor,
  readFundMonths,
  readHolderMonths,
  readRestatements,
} from "./financial-snapshots";

// The dashboard answer built from the stored snapshots (04-investor-portal.md
// 5.9 "Procedures", P33–P36; package P13b). One builder for
// `portal.financials.get` and `financialDashboard.published({ asHolder })`,
// so the team's "Preview as" is exactly what the holder sees.
//
// Like ./financial-snapshots, this module imports nothing from
// `@/server/llc/economics` (S26): the live ledger is not reachable from a
// portal procedure. The term clock is read here from the `LlcTerm` row with
// the pure `computeTermClock`, as `getTermClock` computes it (the integration
// script checks the two agree), without `getOrCreateLlcTerm` (which writes).
//
// Wire form: month records are the stored JSON form (`FundMonthJson`,
// `HolderMonthJson`: cents as JSON numbers, units as 6-dp strings), the form
// the dashboard components' callers convert with `fundMonthFromJson` /
// `holderMonthFromJson`. Dates are "YYYY-MM-DD" strings.

type Tx = TPrismaOrTransaction;

export interface TermClockView {
  /** the Operations Commencement Date (1.21), or null before it is set */
  operationsStart: IsoDate | null;
  /** the effective Target Sale Date (extensions and LOI days included), or null */
  targetSaleDate: IsoDate | null;
}

export interface FinancialView {
  /**
   * Investor and Published view: the date the figures are published
   * through (P33; the team's Published view: the last day of the latest
   * snapshot month). Live view: the date the last month's figures are taken
   * at (its month end, or "today" for the month in progress). Null: nothing.
   */
  publishedThrough: IsoDate | null;
  /** the first month of `fundMonths` (live: the ledger's inception month) */
  inceptionMonth: MonthKey | null;
  timeZone: string;
  fundMonths: FundMonthJson[];
  /** one holder's records, `holderId` = "self" (empty unless a holder is viewed) */
  holderMonths: HolderMonthJson[];
  periods: DashboardPeriod[];
  /** P35: restated months, `at` = the day of the restatement in the company's time zone */
  restatements: { month: MonthKey; at: IsoDate }[];
  termClock: TermClockView | null;
}

export function emptyView(timeZone: string): FinancialView {
  return {
    publishedThrough: null,
    inceptionMonth: null,
    timeZone,
    fundMonths: [],
    holderMonths: [],
    periods: [],
    restatements: [],
    termClock: null,
  };
}

export function zoneOf(company: { timezone: string | null }): string {
  return company.timezone || GOVERNANCE_TIME_ZONE;
}

/** The term clock as `getTermClock` computes it, read without writing. */
export async function readTermClock(
  tx: Tx,
  companyId: string,
): Promise<TermClockView> {
  const term = await tx.llcTerm.findUnique({ where: { companyId } });
  if (term === null || term.operationsCommencementDate === null) {
    return { operationsStart: null, targetSaleDate: null };
  }
  const extensionsApproved = await tx.resolution.count({
    where: { companyId, type: "TERM_EXTENSION", status: "EFFECTIVE" },
  });
  const clock = computeTermClock(
    {
      operationsCommencementDate: toDateOnly(term.operationsCommencementDate),
      extensionsApproved,
      loiExtensionDays: term.loiExtensionDays,
    },
    {
      ...OA_DEFAULTS,
      targetSaleYears: term.targetSaleYears,
      loiExtensionMaxDays: term.loiExtensionMaxDays,
      extensionRequestMonthsBefore: term.extensionRequestMonthsBefore,
      dissolutionElectionDays: term.dissolutionElectionDays,
      ocdNoticeBusinessDays: term.ocdNoticeBusinessDays,
      businessDays: {
        holidays: term.holidayCalendar,
        saturdayObservedOnFriday: term.saturdayHolidayObservedFriday,
        extraHolidays: term.extraHolidays.map(toDateOnly),
      },
    },
  );
  return {
    operationsStart: clock.operationsCommencementDate,
    targetSaleDate: clock.effectiveTargetSaleDate,
  };
}

const PERIOD_REPORT_TYPES = ["QUARTERLY", "ANNUAL"] as const;

async function periodReports(
  tx: Tx,
  where: Prisma.MemberReportWhereInput,
): Promise<{ publicId: string; type: string; periodEnd: IsoDate | null }[]> {
  const rows = await tx.memberReport.findMany({
    where: { ...where, type: { in: [...PERIOD_REPORT_TYPES] } },
    orderBy: [{ sentAt: "desc" }, { createdAt: "desc" }],
    select: { publicId: true, type: true, periodEnd: true },
  });
  return rows.map((r) => ({
    publicId: r.publicId,
    type: r.type,
    periodEnd: r.periodEnd === null ? null : toDateOnly(r.periodEnd),
  }));
}

/**
 * P35 for one holder: the restated months (current fund version > 1) whose
 * restatement changed the fund figures or this holder's own record
 * (`visibleRestatement`), with the day of that restatement.
 */
async function holderRestatements(
  tx: Tx,
  holder: ReportHolder,
  through: IsoDate,
  timeZone: string,
): Promise<{ month: MonthKey; at: IsoDate }[]> {
  const restated = await readRestatements(tx, holder.companyId, { through });
  if (restated.length === 0) return [];
  const dates = restated.map((r) => fromDateOnly(r.month));
  const [fundRows, holderRows] = await Promise.all([
    tx.financialSnapshot.findMany({
      where: { companyId: holder.companyId, month: { in: dates } },
      select: { month: true, version: true, dataHash: true, frozenAt: true },
    }),
    tx.holderFinancialSnapshot.findMany({
      where: {
        companyId: holder.companyId,
        stakeholderId: holder.stakeholderId,
        month: { in: dates },
      },
      select: { month: true, version: true, data: true },
    }),
  ]);
  const out: { month: MonthKey; at: IsoDate }[] = [];
  for (const r of restated) {
    const shown = visibleRestatement(
      fundRows.filter((x) => toDateOnly(x.month) === r.month),
      holderRows
        .filter((x) => toDateOnly(x.month) === r.month)
        .map((x) => ({
          version: x.version,
          canonical: canonicalJson(HolderMonthJsonSchema.parse(x.data)),
        })),
    );
    if (shown !== null) {
      out.push({ month: r.month, at: todayInZone(shown.at, timeZone) });
    }
  }
  return out;
}

/**
 * What one holder sees (P33–P36): fund records and the holder's own records
 * through the holder's published-through date (recomputed now from the
 * reports visible to the holder), the quarters and years of those months
 * with the visible report of each, the restatement notes, the term clock.
 * Nothing at all (and no term clock) without a published period. The
 * holder comes from the caller's context only (`ctx.holder`, or a holder the
 * team loaded by `{ id, companyId }`).
 */
export async function holderFinancialView(
  tx: Tx,
  holder: ReportHolder,
  company: { timezone: string | null },
): Promise<FinancialView> {
  const timeZone = zoneOf(company);
  const through = await publishedThroughFor(tx, holder);
  if (through === null) return emptyView(timeZone);
  const [fund, mine, reports, termClock] = await Promise.all([
    readFundMonths(tx, holder.companyId, { through }),
    readHolderMonths(tx, holder, { through }),
    periodReports(tx, visibleReportWhere(holder)),
    readTermClock(tx, holder.companyId),
  ]);
  const restatements = await holderRestatements(tx, holder, through, timeZone);
  return {
    publishedThrough: through,
    inceptionMonth: fund[0]?.month ?? null,
    timeZone,
    fundMonths: fund.map(fundMonthToJson),
    holderMonths: mine.map((h) => selfHolderMonth(holderMonthToJson(h))),
    periods: dashboardPeriods(
      fund.map((m) => m.month),
      reports,
    ),
    restatements,
    termClock,
  };
}

/**
 * The team's Published view without a holder (P39): every current fund
 * record through the latest snapshot month, no holder records, every
 * restated month, and the released quarterly and annual reports of each
 * period (by report public id, whatever their audience or publish state).
 */
export async function companyPublishedView(
  tx: Tx,
  companyId: string,
  company: { timezone: string | null },
): Promise<FinancialView> {
  const timeZone = zoneOf(company);
  const latest = await latestSnapshotMonth(tx, companyId);
  const termClock = await readTermClock(tx, companyId);
  if (latest === null) return { ...emptyView(timeZone), termClock };
  const through = monthEnd(latest);
  const [fund, restated, reports] = await Promise.all([
    readFundMonths(tx, companyId, { through }),
    readRestatements(tx, companyId, { through }),
    releasedPeriodReports(tx, companyId),
  ]);
  return {
    publishedThrough: through,
    inceptionMonth: fund[0]?.month ?? null,
    timeZone,
    fundMonths: fund.map(fundMonthToJson),
    holderMonths: [],
    periods: dashboardPeriods(
      fund.map((m) => m.month),
      reports,
    ),
    restatements: restated.map((r) => ({
      month: r.month,
      at: todayInZone(r.at, timeZone),
    })),
    termClock,
  };
}

/** Released quarterly and annual reports of the company, newest first (team views). */
export function releasedPeriodReports(tx: Tx, companyId: string) {
  return periodReports(tx, { companyId, status: "SENT" });
}
