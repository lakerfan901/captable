// View logic of the portal dashboard pages (04-investor-portal.md 6.3;
// package P15): which reports belong to the period on screen, the latest
// report, the holder's own distribution and contribution tables, and the
// links between the dashboard and the reports. Pure: relative imports only,
// no clock, tested. The figures come from `portal.financials.get` (the
// holder's snapshots through its published-through date, P33, P34); this
// module only picks, orders and labels them.

import type { IsoDate } from "../llc/dates";
import type { DashboardPeriod } from "../llc/financial-dashboard-core";
import {
  type Grain,
  type MonthKey,
  monthEnd,
  periodLabel,
} from "../llc/financial-periods";
import type { HolderMonth } from "../llc/financial-series";
import { accessBasePath } from "./portal-nav";

// ---------------------------------------------------------------------------
// Links

/** `/portal/[access]/reports/[reportId]` (6.1). */
export function reportHref(access: string, reportId: string): string {
  return `${accessBasePath(access)}/reports/${encodeURIComponent(reportId)}`;
}

/**
 * `/portal/[access]/financials` with a period selected (the query keys of
 * the dashboard's URL state, `period-state.ts`): the "See this period in
 * Financials" link of a report page (6.3) and the Overview's way into the
 * dashboard. A period that is not a quarter or a year opens the default view.
 */
export function financialsHref(
  access: string,
  period?: { grain: Grain; key: string } | null,
  section: "financials" | "investment" = "financials",
): string {
  const base = `${accessBasePath(access)}/${section}`;
  if (!period) return base;
  if (period.grain === "quarter") return `${base}?period=${period.key}`;
  if (period.grain === "year") {
    return `${base}?grain=year&period=${period.key}`;
  }
  return base;
}

/**
 * The dashboard period of a report, for "See this period in Financials":
 * a quarterly or annual report whose period is one whole calendar quarter or
 * year. Anything else (a notice, a K-1, an odd range) has no such link.
 */
export function dashboardPeriodOfReport(report: {
  type: string;
  periodStart: string | null;
  periodEnd: string | null;
}): { grain: "quarter" | "year"; key: string } | null {
  const { periodStart: start, periodEnd: end } = report;
  if (start === null || end === null) return null;
  const m = /^(\d{4})-(\d{2})-01$/.exec(start);
  if (!m) return null;
  const year = m[1] as string;
  const month = Number(m[2]);
  if (report.type === "QUARTERLY" && (month - 1) % 3 === 0) {
    const last = `${year}-${String(month + 2).padStart(2, "0")}-01`;
    if (monthEnd(last) !== end) return null;
    return { grain: "quarter", key: `${year}-Q${(month - 1) / 3 + 1}` };
  }
  if (report.type === "ANNUAL" && month === 1 && end === `${year}-12-31`) {
    return { grain: "year", key: year };
  }
  return null;
}

/**
 * "See this period in Financials" of a report page, or null: the report
 * covers one dashboard period (`dashboardPeriodOfReport`) and that period is
 * on the holder's dashboard now (`periods` of `portal.financials.get`: its
 * months are published to the holder). A report whose months have no
 * figures, a notice or a K-1 has no link, so it never lands on an empty page.
 */
export function reportFinancialsHref(
  access: string,
  report: {
    type: string;
    periodStart: string | null;
    periodEnd: string | null;
  },
  periods: readonly { grain: string; key: string }[],
): string | null {
  const period = dashboardPeriodOfReport(report);
  if (period === null) return null;
  const shown = periods.some(
    (p) => p.grain === period.grain && p.key === period.key,
  );
  return shown ? financialsHref(access, period) : null;
}

// ---------------------------------------------------------------------------
// Reports of the period on screen

/** What the page knows of a visible report (`portal.reports.list`, fields picked). */
export interface ReportSummary {
  id: string;
  title: string;
  /** "YYYY-MM-DD", or null */
  releasedOn: IsoDate | null;
}

export interface PeriodReportRow {
  /** "2026-Q2" or "2026" */
  key: string;
  /** "Q2 2026", "FY2026" */
  label: string;
  grain: "quarter" | "year";
  start: MonthKey;
  end: IsoDate;
  /** the report's frozen title, or null when the list does not have it */
  title: string | null;
  releasedOn: IsoDate | null;
  href: string;
}

/** The period on screen, as far as reports are concerned. */
export interface FocusSpan {
  start: MonthKey;
  /** last day */
  end: IsoDate;
}

/**
 * The reports that belong to the period on screen: the quarterly or annual
 * report of every published period that contains it (a month: its quarter
 * and year) or ends inside it (a year: its quarters; since inception: all).
 * Only periods with a report the holder may open (`reportId`, P11); newest
 * period end first, a year before the quarter that ends with it.
 */
export function reportsForPeriod(
  access: string,
  periods: readonly DashboardPeriod[],
  focus: FocusSpan,
  reports: readonly ReportSummary[] = [],
): PeriodReportRow[] {
  const byId = new Map(reports.map((r) => [r.id, r]));
  return periods
    .filter((p): p is DashboardPeriod & { reportId: string } => {
      if (p.reportId === null) return false;
      const contains = p.start <= focus.start && p.end >= focus.end;
      // ends inside: a year's quarters, every period since inception (a
      // year that began before the fund's first month included)
      const endsInside = p.end >= focus.start && p.end <= focus.end;
      return contains || endsInside;
    })
    .sort(byEndDescYearFirst)
    .map((p) => {
      const r = byId.get(p.reportId);
      return {
        key: p.key,
        label: periodLabel(p.key),
        grain: p.grain,
        start: p.start,
        end: p.end,
        title: r?.title ?? null,
        releasedOn: r?.releasedOn ?? null,
        href: reportHref(access, p.reportId),
      };
    });
}

/**
 * The Overview's "Latest report": the report of the latest published
 * period that has one the holder may open, or null.
 */
export function latestPeriodReport(
  access: string,
  periods: readonly DashboardPeriod[],
  reports: readonly ReportSummary[] = [],
): PeriodReportRow | null {
  const latest = [...periods]
    .filter((p) => p.reportId !== null)
    .sort(byEndDescYearFirst)[0];
  if (!latest) return null;
  return (
    reportsForPeriod(access, [latest], latest, reports).find(
      (r) => r.key === latest.key,
    ) ?? null
  );
}

function byEndDescYearFirst(a: DashboardPeriod, b: DashboardPeriod): number {
  if (a.end !== b.end) return a.end < b.end ? 1 : -1;
  if (a.grain !== b.grain) return a.grain === "year" ? -1 : 1;
  return 0;
}

// ---------------------------------------------------------------------------
// My investment: tables

/** A month in which the holder received a distribution (6.3 "my distributions"). */
export interface DistributionRow {
  month: MonthKey;
  /** "Jun 2026" */
  label: string;
  preferredReturn: bigint;
  returnOfCapital: bigint;
  residual: bigint;
  gross: bigint;
  /** default and tax-advance offsets taken from the holder's own distribution */
  offsets: bigint;
  net: bigint;
  /** P35: the day this month's figures were restated, or null */
  restatedOn: IsoDate | null;
}

export interface ContributionRow {
  month: MonthKey;
  label: string;
  contributions: bigint;
  credits: bigint;
  restatedOn: IsoDate | null;
}

export interface Totals<R> {
  rows: R[];
  total: Omit<R, "month" | "label" | "restatedOn">;
}

function restatedIndex(
  restatements: readonly { month: MonthKey; at: IsoDate }[],
): Map<MonthKey, IsoDate> {
  const out = new Map<MonthKey, IsoDate>();
  for (const r of restatements) {
    const prev = out.get(r.month);
    if (prev === undefined || r.at > prev) out.set(r.month, r.at);
  }
  return out;
}

function sortedNewestFirst(months: readonly HolderMonth[]): HolderMonth[] {
  return [...months].sort((a, b) =>
    a.month === b.month ? 0 : a.month < b.month ? 1 : -1,
  );
}

/**
 * The holder's distributions by month, newest first, with a total row. The
 * snapshots are month totals (5.9), so a row is a month, not a payment.
 * Months with nothing paid are left out.
 */
export function distributionRows(
  holderMonths: readonly HolderMonth[],
  restatements: readonly { month: MonthKey; at: IsoDate }[] = [],
): Totals<DistributionRow> {
  const restated = restatedIndex(restatements);
  const rows: DistributionRow[] = sortedNewestFirst(holderMonths)
    .filter(
      (m) =>
        m.grossDistributions !== 0n ||
        m.netPaid !== 0n ||
        m.defaultOffsets !== 0n ||
        m.taxAdvanceOffsets !== 0n,
    )
    .map((m) => ({
      month: m.month,
      label: periodLabel(m.month.slice(0, 7)),
      preferredReturn: m.preferredReturnPaid,
      returnOfCapital: m.capitalReturned,
      residual: m.residualPaid,
      gross: m.grossDistributions,
      offsets: m.defaultOffsets + m.taxAdvanceOffsets,
      net: m.netPaid,
      restatedOn: restated.get(m.month) ?? null,
    }));
  const sum = (f: (r: DistributionRow) => bigint) =>
    rows.reduce((n, r) => n + f(r), 0n);
  return {
    rows,
    total: {
      preferredReturn: sum((r) => r.preferredReturn),
      returnOfCapital: sum((r) => r.returnOfCapital),
      residual: sum((r) => r.residual),
      gross: sum((r) => r.gross),
      offsets: sum((r) => r.offsets),
      net: sum((r) => r.net),
    },
  };
}

/**
 * The holder's contributions by month, newest first, with a total row.
 * "Credits" are capital credited without cash (5.9 `credits`); months with
 * neither are left out.
 */
export function contributionRows(
  holderMonths: readonly HolderMonth[],
  restatements: readonly { month: MonthKey; at: IsoDate }[] = [],
): Totals<ContributionRow> {
  const restated = restatedIndex(restatements);
  const rows: ContributionRow[] = sortedNewestFirst(holderMonths)
    .filter((m) => m.contributions !== 0n || m.credits !== 0n)
    .map((m) => ({
      month: m.month,
      label: periodLabel(m.month.slice(0, 7)),
      contributions: m.contributions,
      credits: m.credits,
      restatedOn: restated.get(m.month) ?? null,
    }));
  return {
    rows,
    total: {
      contributions: rows.reduce((n, r) => n + r.contributions, 0n),
      credits: rows.reduce((n, r) => n + r.credits, 0n),
    },
  };
}

// ---------------------------------------------------------------------------
// Overview

/** The newest `n` shared documents (the list arrives newest share first; sorted again to be sure). */
export function newestDocuments<T extends { sharedAt: Date }>(
  docs: readonly T[],
  n = 3,
): T[] {
  return [...docs]
    .sort((a, b) => b.sharedAt.getTime() - a.sharedAt.getTime())
    .slice(0, n);
}
