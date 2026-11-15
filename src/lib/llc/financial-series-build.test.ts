// Agreement and tie-out tests of the financial series (04-investor-portal.md
// 5.9 "Agreement between the dashboard and the reports", P12 acceptance).
// Every expected value is computed by calling the existing economics
// functions directly for the whole period.

import { describe, expect, it } from "vitest";
import { loanState } from "../../server/llc/economics/financials.logic";
import { buildPeriodEconomics } from "../../server/llc/economics/report-data.logic";
import { buildMemberStatement } from "../../server/llc/economics/statements.logic";
import { figuresFromPeriodData } from "../governance/report-figures";
import {
  periodReportInputFromEconomics,
  periodReportInputFromFundValues,
} from "../governance/report-reconcile";
import { addDays, compareIso, type IsoDate } from "./dates";
import {
  cutAtPublishedThrough,
  type Grain,
  type MonthRange,
  monthEnd,
} from "./financial-periods";
import {
  aggregate,
  aggregateHolder,
  comparePeriodValues,
  dpiBps,
  FUND_METRICS,
  type FundMonth,
  type FundValues,
  fundComparison,
  fundMonthFromJson,
  fundMonthToJson,
  type HolderMonth,
  type HolderValues,
  holderMonthFromJson,
  holderMonthToJson,
  holderSlice,
} from "./financial-series";
import {
  buildFundMonth,
  buildHolderMonth,
  buildSeries,
  monthAsOf,
  type SeriesInput,
  seriesAsOfDates,
} from "./financial-series-build";
import { generateWorld, type World } from "./fixtures/series-world";
import { computePositions } from "./positions";

const SEEDS = [1, 2, 3, 5, 8, 13, 21, 34];
const GRAINS: Grain[] = ["month", "quarter", "year", "inception"];

function peFor(input: SeriesInput, start: IsoDate, end: IsoDate) {
  let loans = 0n;
  for (const l of input.memberLoans) {
    loans += loanState(l.loan, l.payments, end).principalOutstanding;
  }
  return buildPeriodEconomics({
    ...input.economics,
    period: { periodStart: start, periodEnd: end },
    memberLoansOutstandingAtEnd: loans,
  });
}

function positionsAt(input: SeriesInput, asOf: IsoDate) {
  return computePositions(input.events, asOf, input.positionsConfig, {
    accrualPauses: input.accrualPauses ?? [],
  });
}

function statementFor(
  input: SeriesInput,
  holderId: string,
  from: IsoDate,
  to: IsoDate,
) {
  const opening = positionsAt(input, addDays(from, -1));
  const closing = positionsAt(input, to);
  const facts = input.facts.get(to);
  if (!facts) throw new Error(`no facts at ${to}`);
  const rows = input.holders.find((h) => h.holderId === holderId);
  return buildMemberStatement({
    stakeholderId: holderId,
    name: holderId,
    from,
    to,
    openingPosition: opening.holders.get(holderId),
    closingPosition: closing.holders.get(holderId),
    openingCommonUnits: 0n,
    closingCommonUnits: facts.commonUnits.get(holderId) ?? 0n,
    openingTotalPreferredUnits: opening.totals.preferredUnits,
    closingTotalPreferredUnits: closing.totals.preferredUnits,
    receipts: rows?.receipts ?? [],
    distributions: rows?.distributions ?? [],
    transfers: rows?.transfers ?? [],
    advances: rows?.advances ?? [],
    commitment: facts.commitments.get(holderId) ?? null,
    defaults: [],
    taxAdvanceOutstanding: 0n,
  });
}

const asMap = <T>(
  rows: readonly T[],
  k: (r: T) => string,
  v: (r: T) => bigint,
) => new Map(rows.map((r) => [k(r), v(r)]));

/** The fund values of [start, end] must equal the economics functions called once for that range. */
function expectFundAgrees(
  input: SeriesInput,
  v: FundValues,
  start: IsoDate,
  end: IsoDate,
  label: string,
) {
  const pe = peFor(input, start, end);
  const pos = positionsAt(input, end);
  const facts = input.facts.get(end);
  if (!facts) throw new Error(`no facts at ${end}`);
  const items = pe.distributions.items;
  const tier = (f: (i: (typeof items)[number]) => bigint) =>
    items.reduce((a, i) => a + f(i), 0n);
  const inRange = (d: IsoDate) =>
    compareIso(d, start) >= 0 && compareIso(d, end) <= 0;
  const holders = [...pos.holders.values()];
  const commitments = [...facts.commitments.values()].filter(
    (c): c is NonNullable<typeof c> => c !== null,
  );
  expect(
    {
      grossRevenue: v.grossRevenue,
      otherIncome: v.otherIncome,
      assetSaleProceeds: v.assetSaleProceeds,
      insuranceProceeds: v.insuranceProceeds,
      totalExpenses: v.totalExpenses,
      operatingExpenses: v.operatingExpenses,
      capitalFundedExpenses: v.capitalFundedExpenses,
      expensesByCategory: asMap(
        v.expensesByCategory,
        (c) => c.category,
        (c) => c.amount,
      ),
      managementFeeAccrued: v.managementFeeAccrued,
      managementFeePaid: v.managementFeePaid,
      managementFeeUnpaid: v.managementFeeUnpaid,
      netOperatingIncome: v.netOperatingIncome,
      reserveBalance: v.reserveBalance,
      reservesByKind: asMap(
        v.reservesByKind,
        (k) => k.kind,
        (k) => k.balance,
      ),
      minimumReserve: v.minimumReserve,
      reservesEstablished: v.reservesEstablished,
      reservesReleased: v.reservesReleased,
      availableCash: v.availableCash,
      distributions: v.distributions,
      capitalReceived: v.capitalReceived,
      paidInCapital: v.paidInCapital,
      unreturnedCapital: v.unreturnedCapital,
      preferredReturnAccruedToDate: v.preferredReturnAccruedToDate,
      preferredReturnPaidToDate: v.preferredReturnPaidToDate,
      preferredReturnUnpaid: v.preferredReturnUnpaid,
      committed: v.committed,
      uncalled: v.uncalled,
      utilizationBps: v.utilizationBps,
      memberLoansOutstanding: v.memberLoansOutstanding,
      orgExpenseCap: v.orgExpenseCap,
    },
    label,
  ).toEqual({
    grossRevenue: pe.revenue.grossRevenue,
    otherIncome: pe.revenue.otherIncome,
    assetSaleProceeds: pe.revenue.assetSaleProceeds,
    insuranceProceeds: pe.revenue.insuranceProceeds,
    totalExpenses: pe.expenses.total,
    operatingExpenses: pe.expenses.operating,
    capitalFundedExpenses: pe.expenses.fromCapital,
    expensesByCategory: asMap(
      pe.expenses.byCategory,
      (c) => c.category,
      (c) => c.amount,
    ),
    managementFeeAccrued: pe.managementFee.accrued,
    managementFeePaid: pe.managementFee.paid,
    managementFeeUnpaid: pe.managementFee.unpaidAtEnd,
    netOperatingIncome:
      pe.revenue.grossRevenue +
      pe.revenue.otherIncome -
      pe.expenses.operating -
      pe.managementFee.accrued,
    reserveBalance: pe.reserves.balanceAtEnd,
    reservesByKind: asMap(
      pe.reserves.byKind,
      (k) => k.kind,
      (k) => k.balanceAtEnd,
    ),
    minimumReserve: pe.reserves.minimumRequired,
    reservesEstablished: pe.reserves.established,
    reservesReleased: pe.reserves.released,
    availableCash: pe.availableCashAtEnd.availableCash,
    distributions: {
      preferredReturn: tier((i) => i.tierC),
      returnOfCapital: tier((i) => i.tierD),
      residualPreferred: tier((i) => i.tierEPreferred),
      residualCommon: tier((i) => i.tierECommon),
      gross: pe.distributions.totalGross,
    },
    capitalReceived: input.economics.ledger.capitalReceived
      .filter((c) => inRange(c.on))
      .reduce((a, c) => a + c.amount, 0n),
    paidInCapital: pos.totals.contributed,
    unreturnedCapital: pos.totals.unreturned,
    preferredReturnAccruedToDate: holders.reduce(
      (a, h) => a + h.accruedReturn,
      0n,
    ),
    preferredReturnPaidToDate: holders.reduce((a, h) => a + h.returnPaid, 0n),
    preferredReturnUnpaid: pos.totals.unpaidReturn,
    committed: commitments.reduce((a, c) => a + c.committed, 0n),
    uncalled: commitments.reduce((a, c) => a + c.uncalled, 0n),
    utilizationBps: pe.revenue.averageUtilizationBps,
    memberLoansOutstanding: pe.memberLoansOutstandingAtEnd,
    orgExpenseCap: {
      counted: pe.orgExpenseCap.counted,
      limit: pe.orgExpenseCap.limit,
    },
  });
}

function expectHolderAgrees(
  input: SeriesInput,
  holderId: string,
  v: HolderValues,
  start: IsoDate,
  end: IsoDate,
  label: string,
) {
  const st = statementFor(input, holderId, start, end);
  expect({ ...v }, label).toEqual({
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
  });
}

function holderValues(v: HolderValues): HolderValues {
  return {
    contributions: v.contributions,
    credits: v.credits,
    forfeited: v.forfeited,
    preferredReturnAccrued: v.preferredReturnAccrued,
    preferredReturnPaid: v.preferredReturnPaid,
    capitalReturned: v.capitalReturned,
    residualPaid: v.residualPaid,
    grossDistributions: v.grossDistributions,
    defaultOffsets: v.defaultOffsets,
    taxAdvanceOffsets: v.taxAdvanceOffsets,
    netPaid: v.netPaid,
    paidIn: v.paidIn,
    unreturnedCapital: v.unreturnedCapital,
    preferredUnits: v.preferredUnits,
    commonUnits: v.commonUnits,
    preferredPct: v.preferredPct,
    preferredReturnUnpaid: v.preferredReturnUnpaid,
    committed: v.committed,
    uncalled: v.uncalled,
    calledOutstanding: v.calledOutstanding,
  };
}

const worlds = new Map<
  number,
  { world: World; fund: FundMonth[]; holders: HolderMonth[] }
>();
function series(seed: number) {
  let s = worlds.get(seed);
  if (!s) {
    const world = generateWorld(seed);
    const { fundMonths, holderMonths } = buildSeries(world.input, {
      from: world.inception,
      to: world.lastMonth,
    });
    s = { world, fund: fundMonths, holders: holderMonths };
    worlds.set(seed, s);
  }
  return s;
}

const fullRange = (w: World): MonthRange => ({
  from: w.inception,
  to: w.lastMonth,
});

describe("P12 acceptance: Scenario S fixture", () => {
  const { world, fund, holders } = series(1);
  const input = world.input;
  const quarters = aggregate(fund, "quarter", fullRange(world)).filter(
    (q) => !q.partial,
  );

  it("has whole quarters to check", () => {
    expect(quarters.length).toBeGreaterThanOrEqual(3);
  });

  it("for each quarter, the summed fields equal buildPeriodEconomics and the end fields its end values", () => {
    for (const q of quarters) {
      if (!q.values) throw new Error("no values");
      expectFundAgrees(input, q.values, q.start, q.end, q.key);
    }
  });

  it("for each quarter and holder, the holder series equals buildMemberStatement", () => {
    const ids = [...new Set(holders.map((h) => h.holderId))];
    expect(ids).toEqual(expect.arrayContaining(["A", "B", "C", "D", "M"]));
    for (const id of ids) {
      for (const q of aggregateHolder(
        holderSlice(holders, id),
        fund,
        "quarter",
        fullRange(world),
      )) {
        if (q.partial || !q.values) continue;
        expectHolderAgrees(
          input,
          id,
          holderValues(q.values),
          q.start,
          q.end,
          `${id} ${q.key}`,
        );
      }
    }
  });

  it("figuresFromPeriodData gives identical report figures from either source", () => {
    const sortLines = (f: ReturnType<typeof figuresFromPeriodData>) => ({
      ...f,
      expenses: {
        ...f.expenses,
        lines: [...f.expenses.lines].sort((a, b) =>
          a.category < b.category ? -1 : 1,
        ),
      },
    });
    for (const q of quarters) {
      if (!q.values) throw new Error("no values");
      const pe = peFor(input, q.start, q.end);
      const fromLedger = periodReportInputFromEconomics(pe);
      const fromDashboard = periodReportInputFromFundValues(
        q.values,
        fromLedger.managerAndAffiliatePayments,
      );
      const period = { start: q.start, end: q.end };
      expect(
        sortLines(figuresFromPeriodData(fromDashboard, period, "t")),
        q.key,
      ).toEqual(sortLines(figuresFromPeriodData(fromLedger, period, "t")));
    }
  });

  it("one-month builders equal the series", () => {
    const m = fund[5] as FundMonth;
    expect(buildFundMonth(input, m.month)).toEqual(m);
    const h = holders.find((x) => x.holderId === "C" && x.month === m.month);
    expect(h).toBeDefined();
    expect(buildHolderMonth(input, "C", m.month)).toEqual(h);
  });

  it("a month without a revenue row: zero revenue, null utilization; a quarter with one of three values reports it", () => {
    const noRevenue = fund.filter(
      (m) => !input.economics.ledger.months.some((r) => r.month === m.month),
    );
    expect(noRevenue.length).toBeGreaterThan(0);
    for (const m of noRevenue) {
      expect(m.grossRevenue).toBe(0n);
      expect(m.utilizationBps).toBeNull();
    }
  });

  it("stored JSON round-trips every record", () => {
    for (const m of fund) {
      expect(
        fundMonthFromJson(JSON.parse(JSON.stringify(fundMonthToJson(m)))),
      ).toEqual(m);
    }
    for (const h of holders) {
      expect(
        holderMonthFromJson(JSON.parse(JSON.stringify(holderMonthToJson(h)))),
      ).toEqual(h);
    }
  });

  it("a month is complete on its last day (the Available Cash rule), in progress before it", () => {
    expect(monthAsOf("2027-03-01", "2027-03-31")).toEqual({
      asOf: "2027-03-31",
      inProgress: false,
    });
    expect(monthAsOf("2027-03-01", "2027-03-30")).toEqual({
      asOf: "2027-03-30",
      inProgress: true,
    });
    expect(monthAsOf("2027-03-01", "2027-03-01").inProgress).toBe(true);
  });

  it("refuses a month that has not started and missing facts", () => {
    expect(() => buildFundMonth(input, "2099-01-01")).toThrow(
      /has not started/,
    );
    expect(() =>
      buildFundMonth({ ...input, facts: new Map() }, world.inception),
    ).toThrow(/facts/);
    expect(
      seriesAsOfDates(world.inception, world.lastMonth, input.today),
    ).toEqual(fund.map((m) => m.asOf));
  });
});

describe.each(SEEDS)("tie-outs over generated history (seed %i)", (seed) => {
  const { world, fund, holders } = series(seed);
  const input = world.input;
  const range = fullRange(world);
  const ids = [...new Set(holders.map((h) => h.holderId))];

  it("months sum to quarters, years and inception (equal to the economics functions over the same range)", () => {
    for (const grain of GRAINS) {
      for (const p of aggregate(fund, grain, range)) {
        if (!p.values) continue;
        const first = p.presentMonths[0] as string;
        const last = p.presentMonths[p.presentMonths.length - 1] as string;
        expectFundAgrees(
          input,
          p.values,
          first,
          monthEnd(last),
          `${grain} ${p.key}`,
        );
      }
    }
  });

  it("categories sum to totals, in every month and period", () => {
    for (const grain of GRAINS) {
      for (const p of aggregate(fund, grain, range)) {
        const v = p.values;
        if (!v) continue;
        expect(v.expensesByCategory.reduce((a, c) => a + c.amount, 0n)).toBe(
          v.totalExpenses,
        );
        expect(v.operatingExpenses + v.capitalFundedExpenses).toBe(
          v.totalExpenses,
        );
        expect(v.reservesByKind.reduce((a, k) => a + k.balance, 0n)).toBe(
          v.reserveBalance,
        );
        const d = v.distributions;
        expect(
          d.preferredReturn +
            d.returnOfCapital +
            d.residualPreferred +
            d.residualCommon,
        ).toBe(d.gross);
        expect(v.distributionsToPreferred + d.residualCommon).toBe(d.gross);
      }
    }
  });

  it("holders' slices sum exactly to the fund figure for every tier, grain and period", () => {
    for (const grain of GRAINS) {
      const fundPeriods = aggregate(fund, grain, range);
      const holderPeriods = ids.map((id) =>
        aggregateHolder(holderSlice(holders, id), fund, grain, range),
      );
      fundPeriods.forEach((fp, i) => {
        const v = fp.values;
        if (!v) return;
        const sum = (f: (h: HolderValues) => bigint) =>
          holderPeriods.reduce((a, hp) => {
            const hv = hp[i]?.values;
            return a + (hv ? f(hv) : 0n);
          }, 0n);
        const label = `${grain} ${fp.key}`;
        expect(
          sum((h) => h.preferredReturnPaid),
          label,
        ).toBe(v.distributions.preferredReturn);
        expect(
          sum((h) => h.capitalReturned),
          label,
        ).toBe(v.distributions.returnOfCapital);
        expect(
          sum((h) => h.residualPaid),
          label,
        ).toBe(
          v.distributions.residualPreferred + v.distributions.residualCommon,
        );
        expect(
          sum((h) => h.grossDistributions),
          label,
        ).toBe(v.distributions.gross);
        expect(
          sum((h) => h.paidIn),
          label,
        ).toBe(v.paidInCapital);
        expect(
          sum((h) => h.unreturnedCapital),
          label,
        ).toBe(v.unreturnedCapital);
        expect(
          sum((h) => h.preferredReturnUnpaid),
          label,
        ).toBe(v.preferredReturnUnpaid);
        expect(
          sum((h) => h.committed),
          label,
        ).toBe(v.committed);
        expect(
          sum((h) => h.uncalled),
          label,
        ).toBe(v.uncalled);
        // the generator records no credits: every contribution is cash received
        expect(
          sum((h) => h.contributions),
          label,
        ).toBe(v.capitalReceived);
        // accrual over the period = change of the fund's accrued-to-date
        const before = fund
          .filter((m) => compareIso(m.month, fp.start) < 0)
          .at(-1);
        expect(
          sum((h) => h.preferredReturnAccrued),
          label,
        ).toBe(
          v.preferredReturnAccruedToDate -
            (before?.preferredReturnAccruedToDate ?? 0n),
        );
      });
    }
  });

  it("DPI = cumulative distributions to the Preferred class ÷ paid-in, at every period end", () => {
    for (const p of aggregate(fund, "month", range)) {
      const v = p.values;
      if (!v) continue;
      const cum = fund
        .filter((m) => compareIso(m.month, p.start) <= 0)
        .reduce(
          (a, m) =>
            a +
            m.distributions.preferredReturn +
            m.distributions.returnOfCapital +
            m.distributions.residualPreferred,
          0n,
        );
      expect(v.cumulativeDistributionsToPreferred).toBe(cum);
      expect(v.dpiBps).toBe(dpiBps(cum, v.paidInCapital));
    }
    for (const id of ids) {
      const slice = holderSlice(holders, id);
      for (const p of aggregateHolder(slice, fund, "quarter", range)) {
        if (!p.values) continue;
        const cum = slice
          .filter((m) => compareIso(m.month, p.end) <= 0)
          .reduce((a, m) => a + m.grossDistributions, 0n);
        expect(p.values.dpiBps).toBe(dpiBps(cum, p.values.paidIn));
        if (p.values.paidIn === 0n) expect(p.values.dpiBps).toBeNull();
      }
    }
  });

  it("a holder admitted mid-history has records from its admission only, and agrees with its statement", () => {
    const d = holderSlice(holders, "D");
    const dOn = input.holders.find((h) => h.holderId === "D")?.receipts[0]
      ?.on as string;
    expect(d[0]?.month).toBe(`${dOn.slice(0, 8)}01`);
    expect(d[0]?.contributions).toBeGreaterThan(0n);
    for (const id of ["D", "E"]) {
      const slice = holderSlice(holders, id);
      if (slice.length === 0) continue; // seed without a transfer
      for (const p of aggregateHolder(slice, fund, "quarter", range)) {
        if (!p.values) continue;
        const first = p.presentMonths[0] as string;
        const last = p.presentMonths[p.presentMonths.length - 1] as string;
        expectHolderAgrees(
          input,
          id,
          holderValues(p.values),
          first,
          monthEnd(last),
          `${id} ${p.key}`,
        );
      }
    }
  });

  it("the published-through cutoff hides everything after the date", () => {
    const quarterEnds = aggregate(fund, "quarter", range)
      .filter((q) => !q.partial)
      .map((q) => q.end);
    const through = quarterEnds[Math.floor(quarterEnds.length / 2)] as string;
    const visibleFund = cutAtPublishedThrough(fund, through);
    const visibleHolders = cutAtPublishedThrough(holders, through);
    expect(visibleFund.every((m) => compareIso(m.asOf, through) <= 0)).toBe(
      true,
    );
    expect(visibleHolders.every((m) => compareIso(m.asOf, through) <= 0)).toBe(
      true,
    );
    expect(visibleFund.at(-1)?.month).toBe(`${through.slice(0, 8)}01`);
    for (const grain of GRAINS) {
      for (const p of aggregate(visibleFund, grain, range)) {
        if (compareIso(p.start, through) > 0) {
          expect(p.hasData).toBe(false);
          expect(p.values).toBeNull();
        }
      }
    }
    // Since inception through the cutoff equals the economics functions through that date.
    const [inc] = aggregate(visibleFund, "inception", range);
    if (!inc?.values) throw new Error("no values");
    expectFundAgrees(
      input,
      inc.values,
      world.inception,
      through,
      "inception at cutoff",
    );
    for (const id of ids) {
      for (const p of aggregateHolder(
        holderSlice(visibleHolders, id),
        visibleFund,
        "year",
        range,
      )) {
        if (compareIso(p.start, through) > 0) expect(p.values).toBeNull();
      }
    }
  });
});

describe("the month in progress (live view)", () => {
  const world = generateWorld(7, { months: 15, inProgress: true });
  const input = world.input;
  const { fundMonths, holderMonths } = buildSeries(input, fullRange(world));
  const last = fundMonths.at(-1) as FundMonth;

  it("is flagged, and its end figures are as of today: rows dated after today are not counted", () => {
    expect(last.inProgress).toBe(true);
    expect(last.asOf).toBe(input.today);
    expect(fundMonths.slice(0, -1).every((m) => !m.inProgress)).toBe(true);
    expect(world.futureOn && compareIso(world.futureOn, input.today) > 0).toBe(
      true,
    );
    expectFundAgrees(input, last, last.month, input.today, "in progress");
    const throughMonthEnd = peFor(input, last.month, monthEnd(last.month));
    expect(throughMonthEnd.distributions.totalGross).toBeGreaterThan(
      last.distributions.gross,
    );
    expect(throughMonthEnd.expenses.total).toBe(last.totalExpenses + 777_700n);
    expect(monthAsOf(last.month, input.today)).toEqual({
      asOf: input.today,
      inProgress: true,
    });
    for (const h of holderMonths.filter((x) => x.month === last.month)) {
      expect(h.inProgress).toBe(true);
      expectHolderAgrees(
        input,
        h.holderId,
        holderValues(h),
        last.month,
        input.today,
        h.holderId,
      );
    }
  });

  it("its period is partial and is not compared", () => {
    const [p] = aggregate(fundMonths, "month", {
      from: last.month,
      to: last.month,
    });
    if (!p) throw new Error("no period");
    expect(p.partial).toBe(true);
    const changes = comparePeriodValues(
      FUND_METRICS,
      p,
      fundComparison(fundMonths, p, "previous"),
    );
    for (const c of Object.values(changes)) expect(c.status).toBe("PARTIAL");
    // the month before compares normally
    const [prev] = aggregate(fundMonths, "month", {
      from: fundMonths.at(-2)?.month as string,
      to: fundMonths.at(-2)?.month as string,
    });
    if (!prev) throw new Error("no period");
    const ok = comparePeriodValues(
      FUND_METRICS,
      prev,
      fundComparison(fundMonths, prev, "previous"),
    );
    expect(ok.paidInCapital?.status).not.toBe("PARTIAL");
  });
});
