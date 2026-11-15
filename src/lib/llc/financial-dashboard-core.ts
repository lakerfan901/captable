// The pure parts of the dashboard procedures (04-investor-portal.md 5.9
// "Procedures", P33–P36, P39; package P13b): the "Periods" strip, the drift
// between stored snapshots and the ledger (`financialDashboard.status`), the
// restatement note a holder is shown (P35) and the holder record as it
// leaves the server. Pure: relative imports only, no clock, no database.

import { compareIso, type IsoDate } from "./dates";
import {
  type Grain,
  type MonthKey,
  monthEnd,
  monthOf,
  periodByKey,
  periodKey,
} from "./financial-periods";
import {
  compareFundMonths,
  compareHolderMonths,
  type FundMonth,
  type HolderMonth,
  type HolderMonthJson,
} from "./financial-series";

/**
 * P35: the length of a Restate reason after trimming. The same numbers as
 * `RESTATE_REASON_MIN` / `RESTATE_REASON_MAX` of the (server-only) write
 * module, here so a browser form can validate with the router's input schema
 * (the integration script checks the two agree).
 */
export const RESTATE_REASON_MIN_LENGTH = 10;
export const RESTATE_REASON_MAX_LENGTH = 500;

// ---------------------------------------------------------------------------
// Holder records as they leave the server

/**
 * The `holderId` every holder record carries when it leaves the server
 * (`portal.financials.get`, `financialDashboard.published({ asHolder })`).
 * The stored value is the internal `Stakeholder.id`; the answer holds one
 * holder's records only (P36), so the id says nothing the viewer needs and
 * is replaced (G4: no internal ids in a portal answer).
 */
export const SELF_HOLDER_ID = "self";

export function selfHolderMonth(m: HolderMonthJson): HolderMonthJson {
  return { ...m, holderId: SELF_HOLDER_ID };
}

// ---------------------------------------------------------------------------
// Periods strip (6.3 "Periods": each published quarter and year, with the
// report of that period where one is visible)

export interface DashboardPeriod {
  /** "2026-Q1" or "2026" (`periodKey`) */
  key: string;
  grain: Extract<Grain, "quarter" | "year">;
  /** first month of the calendar period */
  start: MonthKey;
  /** last day of the calendar period */
  end: IsoDate;
  /** public id of the report of this period the viewer may open, or null */
  reportId: string | null;
}

export interface PeriodReport {
  publicId: string;
  type: string;
  periodEnd: IsoDate | null;
}

/**
 * The calendar quarters and years that end on or before the last month of
 * `months` and contain at least one of them, oldest first (a quarter before
 * the year that ends with it). A year whose fourth quarter is not among the
 * months is not listed (not yet published as a year). The first period of
 * the fund may start before inception; it is listed with its calendar
 * bounds. `reportId`: the first report of `reports` (callers pass them
 * newest release first) of the matching type (QUARTERLY for a quarter,
 * ANNUAL for a year) whose period end falls in the period.
 */
export function dashboardPeriods(
  months: readonly MonthKey[],
  reports: readonly PeriodReport[],
): DashboardPeriod[] {
  if (months.length === 0) return [];
  const sorted = [...months].sort(compareIso);
  const last = sorted[sorted.length - 1] as MonthKey;
  const lastEnd = monthEnd(last);
  const out: DashboardPeriod[] = [];
  const seen = new Set<string>();
  for (const m of sorted) {
    for (const grain of ["quarter", "year"] as const) {
      const key = periodKey(m, grain);
      if (seen.has(key)) continue;
      seen.add(key);
      const p = periodByKey(key);
      if (compareIso(p.end, lastEnd) > 0) continue;
      const type = grain === "quarter" ? "QUARTERLY" : "ANNUAL";
      const report = reports.find(
        (r) =>
          r.type === type &&
          r.periodEnd !== null &&
          periodKey(monthOf(r.periodEnd), grain) === key,
      );
      out.push({
        key,
        grain,
        start: p.start,
        end: p.end,
        reportId: report ? report.publicId : null,
      });
    }
  }
  return out.sort(
    (a, b) =>
      compareIso(a.end, b.end) ||
      (a.grain === b.grain ? 0 : a.grain === "quarter" ? -1 : 1),
  );
}

// ---------------------------------------------------------------------------
// Drift (`financialDashboard.status`)

export interface DriftHolder {
  holderId: string;
  /** fields that differ (`compareHolderMonths`), or ["*"] when the record appeared or disappeared */
  fields: string[];
}

export interface DriftMonth {
  month: MonthKey;
  /** fund fields that differ (`compareFundMonths`), or ["*"] when the month has no current snapshot */
  fields: string[];
  /** holders whose record differs, appeared or disappeared, by holder id */
  holders: DriftHolder[];
}

/**
 * The months of `months` whose current snapshots differ from the ledger
 * today, by exactly the rule `restateSnapshots` uses to decide which months
 * it rewrites: the fund record (a month without a current fund row counts as
 * changed, fields ["*"]) and every holder record (changed, appeared or
 * disappeared). So the drift months are exactly the months a Restate of the
 * same range would write.
 */
export function driftOf(args: {
  months: readonly MonthKey[];
  stored: { fund: readonly FundMonth[]; holders: readonly HolderMonth[] };
  ledger: { fund: readonly FundMonth[]; holders: readonly HolderMonth[] };
}): DriftMonth[] {
  const out: DriftMonth[] = [];
  for (const month of args.months) {
    const next = args.ledger.fund.find((m) => m.month === month);
    if (!next) throw new Error(`No ledger record for ${month}`);
    const current = args.stored.fund.find((m) => m.month === month);
    const fields = current ? compareFundMonths(current, next) : ["*"];
    const before = new Map(
      args.stored.holders
        .filter((h) => h.month === month)
        .map((h) => [h.holderId, h]),
    );
    const after = new Map(
      args.ledger.holders
        .filter((h) => h.month === month)
        .map((h) => [h.holderId, h]),
    );
    const holders: DriftHolder[] = [];
    const ids = [...new Set([...before.keys(), ...after.keys()])].sort();
    for (const id of ids) {
      const a = before.get(id);
      const b = after.get(id);
      const f = a && b ? compareHolderMonths(a, b) : ["*"];
      if (f.length > 0) holders.push({ holderId: id, fields: f });
    }
    if (fields.length > 0 || holders.length > 0) {
      out.push({ month, fields, holders });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The restatement note one holder is shown (P35)

export interface FundVersionRow {
  version: number;
  dataHash: string;
  frozenAt: Date;
}

export interface HolderVersionRow {
  version: number;
  /** canonical JSON of the stored record (`canonicalJson`) */
  canonical: string;
}

/**
 * The latest version of one month at which something THIS holder sees
 * changed: the fund record (its hash differs from the version before) or the
 * holder's own record (it differs, appeared or disappeared). A restatement
 * that changed only another holder's record is not shown to this holder: it
 * changed nothing on this holder's screens, and the note would tell the
 * holder that someone else's figures moved (P36). Null when no version after
 * the first changed anything visible.
 *
 * `fund`: every fund row of the month (all versions); `holder`: every row of
 * this holder for the month (all versions). Versions of a month are shared
 * by its fund and holder rows (a Restate writes both at one version).
 */
export function visibleRestatement(
  fund: readonly FundVersionRow[],
  holder: readonly HolderVersionRow[],
): { version: number; at: Date } | null {
  const fundBy = new Map(fund.map((r) => [r.version, r]));
  const holderBy = new Map(holder.map((r) => [r.version, r.canonical]));
  const versions = [...fundBy.keys()].sort((a, b) => b - a);
  for (const v of versions) {
    if (v <= 1) break;
    const cur = fundBy.get(v) as FundVersionRow;
    const prev = fundBy.get(v - 1);
    const fundChanged = !prev || prev.dataHash !== cur.dataHash;
    const holderChanged = holderBy.get(v) !== holderBy.get(v - 1);
    if (fundChanged || holderChanged) return { version: v, at: cur.frozenAt };
  }
  return null;
}
