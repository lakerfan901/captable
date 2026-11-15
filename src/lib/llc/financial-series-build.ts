// Builds the month records of the financial dashboard (04-investor-portal.md
// 5.9 "Month records and where each number comes from"). Pure: relative
// imports only, no database, no clock (`today` is an input).
//
// It does no arithmetic of its own on ledger rows: each figure is copied from
// one call of an existing economics function per month, so the dashboard and
// the reports (which call the same functions for a quarter or a year) agree:
//
// - fund: `buildPeriodEconomics` for [first day, as-of] of the month,
//   `computePositions` as of the as-of date, `computeUnusedCapital` (capital
//   received), `loanState` (member loans outstanding);
// - holder: `buildMemberStatement` for [first day, as-of] with positions as of
//   the day before the month and as of the as-of date.
//
// The as-of date of a month is its last day, or `today` for the month in
// progress (its figures are as of today: Preferred Return never accrues into
// the future, and Available Cash excludes the unfinished month by its own
// rule). A month that starts after `today` is refused.
//
// Server-side only by convention (it pulls the server's pure *.logic files);
// the browser uses ./financial-series.

import { loanState } from "../../server/llc/economics/financials.logic";
import {
  buildPeriodEconomics,
  type PeriodEconomicsInput,
} from "../../server/llc/economics/report-data.logic";
import {
  buildMemberStatement,
  type StatementAdvanceRow,
  type StatementCommitment,
  type StatementDistributionRow,
  type StatementReceiptRow,
  type StatementTransferRow,
} from "../../server/llc/economics/statements.logic";
import { computeUnusedCapital } from "./available-cash";
import type { LlcEconomicsConfig } from "./config";
import { addDays, compareIso, type IsoDate } from "./dates";
import { type MonthKey, monthEnd, monthsBetween } from "./financial-periods";
import {
  FINANCIAL_SERIES_SCHEMA_VERSION,
  type FundMonth,
  type HolderMonth,
  type HolderValues,
} from "./financial-series";
import { type Cents, LlcMathError, type MicroUnits } from "./money";
import {
  computePositions,
  type LedgerEvent,
  type PositionOptions,
  type PositionsResult,
} from "./positions";

/** Facts the server reads as of a date (they are not derivable from the rows below). */
export interface AsOfFacts {
  /** each holder's commitment as `getMemberStatement` loads it for a statement ending on the date (null: none) */
  commitments: ReadonlyMap<string, StatementCommitment | null>;
  /** each holder's Common Units as of the date (`getMemberPositions`, kind COMMON) */
  commonUnits: ReadonlyMap<string, MicroUnits>;
}

export const EMPTY_FACTS: AsOfFacts = {
  commitments: new Map(),
  commonUnits: new Map(),
};

/** One holder's rows, as `getMemberStatement` loads them (whole history; the statement filters by date). */
export interface HolderSeriesRows {
  holderId: string;
  name: string;
  receipts: readonly StatementReceiptRow[];
  distributions: readonly StatementDistributionRow[];
  transfers: readonly StatementTransferRow[];
  advances: readonly StatementAdvanceRow[];
}

export interface MemberLoanRows {
  loan: {
    madeOn: IsoDate;
    maturityOn: IsoDate;
    principalCents: Cents;
    interestBps: number;
  };
  payments: readonly {
    paidOn: IsoDate;
    principalCents: Cents;
    interestCents: Cents;
  }[];
}

export interface SeriesInput {
  /** the company's "today" (`economicsToday`): decides the month in progress */
  today: IsoDate;
  /**
   * Every input of `buildPeriodEconomics` over the WHOLE history except the
   * period and the loan balance at its end (both set per month here).
   */
  economics: Omit<
    PeriodEconomicsInput,
    "period" | "memberLoansOutstandingAtEnd"
  >;
  /** the Preferred-class ledger events (`loadLedger(...).events`) */
  events: readonly LedgerEvent[];
  positionsConfig: Pick<
    LlcEconomicsConfig,
    "prefReturnBps" | "dayCountBasis" | "capitalReturnLotOrder"
  >;
  /** R8 windows (`loadAccrualPauses`), empty when defaulters accrue */
  accrualPauses?: PositionOptions["accrualPauses"];
  /** every MemberLoan with its payments (as `getLoanStates` reads them) */
  memberLoans: readonly MemberLoanRows[];
  /** rows per holder; a holder only in positions or facts gets empty rows */
  holders: readonly HolderSeriesRows[];
  /** keyed by as-of date: every date of `seriesAsOfDates` */
  facts: ReadonlyMap<IsoDate, AsOfFacts>;
}

/** The date the end-of-month figures of `month` are taken at, and whether the month is in progress. */
export function monthAsOf(
  month: MonthKey,
  today: IsoDate,
): { asOf: IsoDate; inProgress: boolean } {
  if (compareIso(month, today) > 0) {
    throw new LlcMathError(
      "FUTURE_MONTH",
      `The month ${month} has not started on ${today}`,
    );
  }
  const end = monthEnd(month);
  // Same completeness rule as computeAvailableCash: complete when its last day ≤ today.
  return compareIso(end, today) <= 0
    ? { asOf: end, inProgress: false }
    : { asOf: today, inProgress: true };
}

/** The as-of dates for which the caller must supply `facts` to build [from, to]. */
export function seriesAsOfDates(
  from: MonthKey,
  to: MonthKey,
  today: IsoDate,
): IsoDate[] {
  return monthsBetween(from, to).map((m) => monthAsOf(m, today).asOf);
}

class Builder {
  private positions = new Map<IsoDate, PositionsResult>();
  constructor(private readonly i: SeriesInput) {}

  positionsAt(asOf: IsoDate): PositionsResult {
    let p = this.positions.get(asOf);
    if (!p) {
      p = computePositions(this.i.events, asOf, this.i.positionsConfig, {
        accrualPauses: this.i.accrualPauses ?? [],
      });
      this.positions.set(asOf, p);
    }
    return p;
  }

  factsAt(asOf: IsoDate): AsOfFacts {
    const f = this.i.facts.get(asOf);
    if (!f) {
      throw new LlcMathError(
        "MISSING_FACTS",
        `No commitment and Common Unit facts as of ${asOf}`,
      );
    }
    return f;
  }

  loansOutstanding(asOf: IsoDate): Cents {
    let total = 0n;
    for (const l of this.i.memberLoans) {
      total += loanState(l.loan, l.payments, asOf).principalOutstanding;
    }
    return total;
  }

  fundMonth(month: MonthKey): FundMonth {
    const { asOf, inProgress } = monthAsOf(month, this.i.today);
    const pe = buildPeriodEconomics({
      ...this.i.economics,
      period: { periodStart: month, periodEnd: asOf },
      memberLoansOutstandingAtEnd: this.loansOutstanding(asOf),
    });
    const pos = this.positionsAt(asOf);
    const facts = this.factsAt(asOf);
    const ledger = this.i.economics.ledger;
    const capitalReceived =
      computeUnusedCapital(ledger, asOf).capitalReceived -
      computeUnusedCapital(ledger, addDays(month, -1)).capitalReceived;

    let accruedToDate = 0n;
    let paidToDate = 0n;
    for (const h of pos.holders.values()) {
      accruedToDate += h.accruedReturn;
      paidToDate += h.returnPaid;
    }
    let committed = 0n;
    let uncalled = 0n;
    for (const c of facts.commitments.values()) {
      if (c === null) continue;
      committed += c.committed;
      uncalled += c.uncalled;
    }
    const tiers = {
      preferredReturn: 0n,
      returnOfCapital: 0n,
      residualPreferred: 0n,
      residualCommon: 0n,
      gross: 0n,
    };
    for (const d of pe.distributions.items) {
      tiers.preferredReturn += d.tierC;
      tiers.returnOfCapital += d.tierD;
      tiers.residualPreferred += d.tierEPreferred;
      tiers.residualCommon += d.tierECommon;
      tiers.gross += d.gross;
    }
    const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
    return {
      schemaVersion: FINANCIAL_SERIES_SCHEMA_VERSION,
      month,
      asOf,
      inProgress,
      grossRevenue: pe.revenue.grossRevenue,
      otherIncome: pe.revenue.otherIncome,
      assetSaleProceeds: pe.revenue.assetSaleProceeds,
      insuranceProceeds: pe.revenue.insuranceProceeds,
      totalExpenses: pe.expenses.total,
      operatingExpenses: pe.expenses.operating,
      capitalFundedExpenses: pe.expenses.fromCapital,
      expensesByCategory: [...pe.expenses.byCategory]
        .sort((a, b) => byText(a.category, b.category))
        .map((c) => ({ category: c.category, amount: c.amount })),
      managementFeeAccrued: pe.managementFee.accrued,
      managementFeePaid: pe.managementFee.paid,
      managementFeeUnpaid: pe.managementFee.unpaidAtEnd,
      // 5.9: not a defined term of the Agreement; excludes asset-sale and insurance proceeds.
      netOperatingIncome:
        pe.revenue.grossRevenue +
        pe.revenue.otherIncome -
        pe.expenses.operating -
        pe.managementFee.accrued,
      reserveBalance: pe.reserves.balanceAtEnd,
      reservesByKind: [...pe.reserves.byKind]
        .sort((a, b) => byText(a.kind, b.kind))
        .map((k) => ({ kind: k.kind, balance: k.balanceAtEnd })),
      minimumReserve: pe.reserves.minimumRequired,
      reservesEstablished: pe.reserves.established,
      reservesReleased: pe.reserves.released,
      availableCash: pe.availableCashAtEnd.availableCash,
      distributions: tiers,
      capitalReceived,
      paidInCapital: pos.totals.contributed,
      unreturnedCapital: pos.totals.unreturned,
      preferredReturnAccruedToDate: accruedToDate,
      preferredReturnPaidToDate: paidToDate,
      preferredReturnUnpaid: pos.totals.unpaidReturn,
      committed,
      uncalled,
      utilizationBps:
        pe.revenue.byMonth.find((m) => m.month === month)?.utilizationBps ??
        null,
      memberLoansOutstanding: pe.memberLoansOutstandingAtEnd,
      orgExpenseCap: {
        counted: pe.orgExpenseCap.counted,
        limit: pe.orgExpenseCap.limit,
      },
    };
  }

  holderIdsAt(asOf: IsoDate): string[] {
    const ids = new Set<string>(this.i.holders.map((h) => h.holderId));
    for (const id of this.positionsAt(asOf).holders.keys()) ids.add(id);
    const f = this.factsAt(asOf);
    for (const id of f.commitments.keys()) ids.add(id);
    for (const id of f.commonUnits.keys()) ids.add(id);
    return [...ids].sort();
  }

  holderMonth(holderId: string, month: MonthKey): HolderMonth {
    const { asOf, inProgress } = monthAsOf(month, this.i.today);
    const openingOn = addDays(month, -1);
    const opening = this.positionsAt(openingOn);
    const closing = this.positionsAt(asOf);
    const facts = this.factsAt(asOf);
    // Opening Common Units feed only the statement's opening balances, which
    // are not copied into the month record; before the first fact date they are zero.
    const openingFacts = this.i.facts.get(openingOn) ?? EMPTY_FACTS;
    const rows = this.i.holders.find((h) => h.holderId === holderId);
    const st = buildMemberStatement({
      stakeholderId: holderId,
      name: rows?.name ?? holderId,
      from: month,
      to: asOf,
      openingPosition: opening.holders.get(holderId),
      closingPosition: closing.holders.get(holderId),
      openingCommonUnits: openingFacts.commonUnits.get(holderId) ?? 0n,
      closingCommonUnits: facts.commonUnits.get(holderId) ?? 0n,
      openingTotalPreferredUnits: opening.totals.preferredUnits,
      closingTotalPreferredUnits: closing.totals.preferredUnits,
      receipts: rows?.receipts ?? [],
      distributions: rows?.distributions ?? [],
      transfers: rows?.transfers ?? [],
      advances: rows?.advances ?? [],
      commitment: facts.commitments.get(holderId) ?? null,
      // Default detail and tax-advance balances are not copied (5.9).
      defaults: [],
      taxAdvanceOutstanding: 0n,
    });
    return {
      schemaVersion: FINANCIAL_SERIES_SCHEMA_VERSION,
      holderId,
      month,
      asOf,
      inProgress,
      contributions: st.period.contributions,
      credits: st.period.credits,
      forfeited: st.period.forfeited,
      preferredReturnAccrued: st.period.returnAccrued,
      preferredReturnPaid: st.period.returnPaid,
      capitalReturned: st.period.capitalReturned,
      residualPaid: st.period.residualPaid,
      grossDistributions: st.period.grossDistributions,
      defaultOffsets: st.period.defaultOffsets,
      taxAdvanceOffsets: st.period.taxAdvanceOffsets,
      netPaid: st.period.netPaid,
      paidIn: st.closing.contributed,
      unreturnedCapital: st.closing.unreturned,
      preferredUnits: st.closing.preferredUnits,
      commonUnits: st.closing.commonUnits,
      preferredPct: st.closing.preferredPct,
      preferredReturnUnpaid: st.closing.unpaidReturn,
      committed: st.commitment?.committed ?? 0n,
      uncalled: st.commitment?.uncalled ?? 0n,
      calledOutstanding: st.commitment?.calledOutstanding ?? 0n,
    };
  }
}

/** One fund month record (5.9). */
export function buildFundMonth(input: SeriesInput, month: MonthKey): FundMonth {
  return new Builder(input).fundMonth(month);
}

/** One holder month record (5.9); zeros for a month without position or movement. */
export function buildHolderMonth(
  input: SeriesInput,
  holderId: string,
  month: MonthKey,
): HolderMonth {
  return new Builder(input).holderMonth(holderId, month);
}

const HOLDER_CENTS_KEYS = [
  "contributions",
  "credits",
  "forfeited",
  "preferredReturnAccrued",
  "preferredReturnPaid",
  "capitalReturned",
  "residualPaid",
  "grossDistributions",
  "defaultOffsets",
  "taxAdvanceOffsets",
  "netPaid",
  "paidIn",
  "unreturnedCapital",
  "preferredUnits",
  "commonUnits",
  "preferredReturnUnpaid",
  "committed",
  "uncalled",
  "calledOutstanding",
] as const satisfies readonly (keyof HolderValues)[];

/** P34: a holder record is written when the holder has a position or a movement in the month. */
export function holderMonthHasData(h: HolderValues): boolean {
  return HOLDER_CENTS_KEYS.some((k) => h[k] !== 0n);
}

/**
 * Every fund record of [from, to] and every holder record with a position or
 * a movement (P34), sharing one positions computation per date.
 */
export function buildSeries(
  input: SeriesInput,
  range: { from: MonthKey; to: MonthKey },
): { fundMonths: FundMonth[]; holderMonths: HolderMonth[] } {
  const b = new Builder(input);
  const fundMonths: FundMonth[] = [];
  const holderMonths: HolderMonth[] = [];
  for (const month of monthsBetween(range.from, range.to)) {
    fundMonths.push(b.fundMonth(month));
    const { asOf } = monthAsOf(month, input.today);
    for (const id of b.holderIdsAt(asOf)) {
      const h = b.holderMonth(id, month);
      if (holderMonthHasData(h)) holderMonths.push(h);
    }
  }
  return { fundMonths, holderMonths };
}
