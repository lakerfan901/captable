// Which months the financial snapshots cover (04-investor-portal.md P34, P35,
// 5.9 "Writing snapshots"; package P13a). Pure: relative imports only, no
// database, no clock.
//
// - Release writes every month after the company's latest current snapshot
//   through the last whole month of the report's period, so the series is
//   continuous from inception (a quarter that was never released is filled).
//   Without any snapshot it starts at inception: the month of the earliest
//   dated row of the ledger (a capital receipt of either class, a revenue
//   month, an expense, a reserve entry, a Manager payment, a distribution, a
//   member loan or one of its payments, a tax advance). With no row at all,
//   nothing is written: there is nothing to show yet.
// - Restate rewrites months on or before the latest current snapshot, not
//   before the earlier of the first snapshot and inception, and only months
//   that have ended.

import { compareIso, type IsoDate } from "./dates";
import {
  addMonthKeys,
  isMonthKey,
  type MonthKey,
  monthEnd,
  monthOf,
  monthsBetween,
} from "./financial-periods";
import type { SeriesInput } from "./financial-series-build";

/** The last month whose final day is on or before `periodEnd`. */
export function lastWholeMonth(periodEnd: IsoDate): MonthKey {
  const m = monthOf(periodEnd);
  return compareIso(monthEnd(m), periodEnd) <= 0 ? m : addMonthKeys(m, -1);
}

/** The month of the earliest dated row of the series input (and of `extra`), or null when there is none. */
export function seriesInception(
  input: SeriesInput,
  extra: readonly IsoDate[] = [],
): MonthKey | null {
  let first: IsoDate | null = null;
  const see = (d: IsoDate) => {
    if (first === null || compareIso(d, first) < 0) first = d;
  };
  const l = input.economics.ledger;
  for (const m of l.months) see(m.month);
  for (const r of l.expenses) see(r.on);
  for (const r of l.reserves) see(r.on);
  for (const r of l.defaultIncome) see(r.on);
  for (const r of l.loanPayments) see(r.on);
  for (const r of l.loanProceeds) see(r.on);
  for (const r of l.distributions) see(r.on);
  for (const r of l.capitalReceived) see(r.on);
  for (const p of input.economics.managerPayments) see(p.paidOn);
  for (const d of input.economics.distributions) see(d.paymentDate);
  for (const e of input.events) see(e.on);
  for (const loan of input.memberLoans) {
    see(loan.loan.madeOn);
    for (const p of loan.payments) see(p.paidOn);
  }
  for (const h of input.holders) {
    for (const r of h.receipts) see(r.on);
    for (const a of h.advances) see(a.on);
  }
  for (const d of extra) see(d);
  return first === null ? null : monthOf(first);
}

/**
 * P34: the months a release writes. `latestSnapshotMonth` is the company's
 * latest month with a current (not superseded) fund snapshot.
 */
export function monthsToSnapshot(args: {
  latestSnapshotMonth: MonthKey | null;
  inception: MonthKey | null;
  periodEnd: IsoDate;
}): MonthKey[] {
  const last = lastWholeMonth(args.periodEnd);
  const start =
    args.latestSnapshotMonth !== null
      ? addMonthKeys(args.latestSnapshotMonth, 1)
      : args.inception;
  if (start === null || compareIso(start, last) > 0) return [];
  return monthsBetween(start, last);
}

/** The longest range one restatement may cover (ten years). */
export const MAX_RESTATE_MONTHS = 120;

/**
 * P35: why a restatement of [fromMonth, toMonth] is refused, or null when
 * it may run. Months must be first days, in order, ended before `today`,
 * not after the latest current snapshot, and not before the earlier of the
 * first current snapshot and inception (no month without any figure is
 * created). A range that starts before the first snapshot (rows back-dated
 * before it after the books were reopened) must reach the month before it,
 * so the series stays continuous.
 */
export function restateRangeProblem(args: {
  fromMonth: string;
  toMonth: string;
  firstSnapshotMonth: MonthKey | null;
  latestSnapshotMonth: MonthKey | null;
  inception: MonthKey | null;
  today: IsoDate;
}): string | null {
  const { fromMonth, toMonth } = args;
  if (!isMonthKey(fromMonth) || !isMonthKey(toMonth)) {
    return "Months are given as their first day (YYYY-MM-01).";
  }
  if (compareIso(fromMonth, toMonth) > 0) {
    return "The first month must not be after the last month.";
  }
  const first = args.firstSnapshotMonth;
  const latest = args.latestSnapshotMonth;
  if (first === null || latest === null) {
    return "No financial period has been published yet: there is nothing to restate.";
  }
  if (compareIso(toMonth, latest) > 0) {
    return `Only published months can be restated: the latest is ${latest.slice(0, 7)}.`;
  }
  const lower =
    args.inception !== null && compareIso(args.inception, first) < 0
      ? args.inception
      : first;
  if (compareIso(fromMonth, lower) < 0) {
    return `The ledger has no figures before ${lower.slice(0, 7)}: restate from that month.`;
  }
  if (
    compareIso(fromMonth, first) < 0 &&
    compareIso(toMonth, addMonthKeys(first, -1)) < 0
  ) {
    return `A restatement of months before the first published month (${first.slice(0, 7)}) must run up to it.`;
  }
  if (compareIso(monthEnd(toMonth), args.today) >= 0) {
    return "Only months that have ended can be restated.";
  }
  if (monthsBetween(fromMonth, toMonth).length > MAX_RESTATE_MONTHS) {
    return `At most ${MAX_RESTATE_MONTHS} months can be restated at once.`;
  }
  return null;
}

/** The version a new row of a month gets: one more than any row of that month (fund or holder), 1 for the first. */
export function nextVersion(existing: readonly number[]): number {
  let max = 0;
  for (const v of existing) if (v > max) max = v;
  return max + 1;
}
