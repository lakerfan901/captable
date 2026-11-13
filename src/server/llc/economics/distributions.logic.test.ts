import { describe, expect, it } from "vitest";
import type { CashLedger } from "../../../lib/llc/available-cash";
import type { LlcEconomicsConfig } from "../../../lib/llc/config";
import {
  SCENARIO_S_ALLOCATIONS,
  SCENARIO_S_CONFIG,
  SCENARIO_S_EVENTS,
  SCENARIO_S_RECEIPTS,
} from "../../../lib/llc/fixtures/scenario-s";
import {
  computePositions,
  type HolderPosition,
  type LedgerEvent,
  type PositionsResult,
} from "../../../lib/llc/positions";
import type { DefaultOwed } from "../../../lib/llc/waterfall";
import {
  assertComputationInvariants,
  assertLineRows,
  type BuildComputationInput,
  buildComputation,
  canonicalForHash,
  type DefaultRecordInfo,
  type DistributionComputation,
  distributionLineRows,
  distributionTotalsRow,
  nextDistributionDeadline,
  offsetWrites,
  reversalLineRows,
  reversalTotalsRow,
  taxRecoveryWrites,
  windDownTopUp,
} from "./distributions.logic";
import { buildLedgerEvents, type RawLedgerItem } from "./ledger.logic";

const U = 1_000_000n;
const cfg: LlcEconomicsConfig = SCENARIO_S_CONFIG;

type Computation = Omit<DistributionComputation, "hash">;

const positionsAt = (
  asOf: string,
  events: readonly LedgerEvent[] = SCENARIO_S_EVENTS,
) => computePositions(events, asOf, cfg);

/** A PositionsResult built by hand from waterfall-style rows (W-3 / W-4 inputs). */
function positionsFromRows(
  asOf: string,
  rows: { id: string; unpaid: bigint; unreturned: bigint; units: bigint }[],
): PositionsResult {
  const holders = new Map<string, HolderPosition>();
  for (const r of rows) {
    holders.set(r.id, {
      holderId: r.id,
      contributed: r.unreturned,
      unreturned: r.unreturned,
      capitalReturned: 0n,
      forfeited: 0n,
      preferredUnits: r.units,
      accruedReturn: r.unpaid,
      returnPaid: 0n,
      returnExtinguished: 0n,
      returnCarriedIn: 0n,
      returnCarriedOut: 0n,
      unpaidReturn: r.unpaid,
      lots: [],
    });
  }
  return {
    asOf,
    holders,
    totals: {
      contributed: 0n,
      unreturned: rows.reduce((s, r) => s + r.unreturned, 0n),
      unpaidReturn: rows.reduce((s, r) => s + r.unpaid, 0n),
      preferredUnits: rows.reduce((s, r) => s + r.units, 0n),
    },
    forfeitures: [],
  };
}

const month = (m: string, receipts = 0n, fee = 0n) => ({
  month: m,
  customerReceipts: receipts,
  passThroughFees: 0n,
  otherIncome: 0n,
  assetSaleProceeds: 0n,
  insuranceProceeds: 0n,
  managementFee: fee,
});

/** Available Cash $12,000.00 on 2027-03-31 ($12,631.58 receipts less the 5% fee of $631.58); $50,000 minimum reserve funded from capital. */
function dr1CashLedger(opts?: {
  minimumReserve?: bigint;
  months?: string[];
}): CashLedger {
  const months = (
    opts?.months ?? ["2027-01-01", "2027-02-01", "2027-03-01"]
  ).map((m) => (m === "2027-03-01" ? month(m, 1_263_158n, 63_158n) : month(m)));
  return {
    months,
    expenses: [],
    reserves: [
      {
        on: "2027-01-15",
        kind: "MINIMUM_OPERATING",
        type: "ESTABLISH",
        amount: opts?.minimumReserve ?? 5_000_000n,
        fundingSource: "CAPITAL_CONTRIBUTIONS",
        releaseTo: null,
      },
    ],
    defaultIncome: [],
    loanPayments: [],
    loanProceeds: [],
    distributions: [],
    capitalReceived: SCENARIO_S_RECEIPTS.map((r) => ({
      on: r.on,
      amount: r.amount,
    })),
  };
}

const EMPTY_CASH: CashLedger = {
  months: [],
  expenses: [],
  reserves: [],
  defaultIncome: [],
  loanPayments: [],
  loanProceeds: [],
  distributions: [],
  capitalReceived: [],
};

const META = new Map(
  ["A", "B", "C", "M"].map((id) => [
    id,
    { name: `Holder ${id}`, isInsider: id === "M" },
  ]),
);
const COMMON = new Map([["M", 100n * U]]);

function dr1Input(
  over: Partial<BuildComputationInput> = {},
): BuildComputationInput {
  const atPayment = positionsAt(over.paymentDate ?? "2027-05-14");
  return {
    inputs: { type: "OPERATING" },
    periodEnd: "2027-03-31",
    paymentDate: "2027-05-14",
    today: "2027-05-14",
    config: cfg,
    positionsAtPayment: atPayment,
    positionsAtCutoff: atPayment,
    commonUnits: COMMON,
    holderMeta: META,
    cashLedger: dr1CashLedger(),
    defaultsOwed: new Map(),
    defaultRecords: new Map(),
    taxAdvances: new Map([["B", 250_000n]]),
    loanStates: [],
    pendingDefaultSteps: [],
    overdueUndeclared: 0,
    lastLedgerEventOn: "2027-01-19",
    booksClosedThrough: null,
    revenueMonthsSaved: ["2027-01-01", "2027-02-01", "2027-03-01"],
    requiredFromMonth: "2027-01-01",
    deadline: "2027-05-15",
    operationsCommencementDate: "2027-01-15",
    ...over,
  };
}

const C_DEFAULT_RECORD: DefaultRecordInfo = {
  memberDefaultId: "dC",
  stakeholderId: "C",
  commitmentId: "cmC",
  callNoticeLineId: "lnC",
  dueOn: "2027-01-20",
  latestLivePaymentOn: null,
  forfeitedOn: null,
  creditDate: null,
};

const owedC = (o: Partial<DefaultOwed>): Map<string, DefaultOwed[]> =>
  new Map([
    [
      "C",
      [
        {
          memberDefaultId: "dC",
          dueOn: "2027-01-20",
          suspended: true,
          balance: 1_500_000n,
          interest: 25_644n,
          costs: 0n,
          cureNeedsConfirmation: false,
          ...o,
        },
      ],
    ],
  ]);

function dr2Input(
  over: Partial<BuildComputationInput> = {},
): BuildComputationInput {
  return dr1Input({
    taxAdvances: new Map(),
    defaultsOwed: owedC({}),
    defaultRecords: new Map([["dC", C_DEFAULT_RECORD]]),
    ...over,
  });
}

const line = (c: Computation, id: string) => {
  const l = c.lines.find((x) => x.stakeholderId === id);
  if (!l) throw new Error(`no line for ${id}`);
  return l;
};
const codes = (c: Computation) => c.blockers.map((b) => b.code);

// W-3 and W-4 positions (02-economics.md E3)
const W3 = [
  { id: "A", unpaid: 2_920_125n, unreturned: 7_961_534n, units: 100n * U },
  { id: "B", unpaid: 7_300_312n, unreturned: 19_903_836n, units: 250n * U },
  { id: "C", unpaid: 2_920_125n, unreturned: 7_961_534n, units: 100n * U },
];
const W4 = [
  { id: "A", unpaid: 178_739n, unreturned: 8_961_534n, units: 100n * U },
  { id: "B", unpaid: 446_849n, unreturned: 22_403_836n, units: 250n * U },
  { id: "C", unpaid: 178_740n, unreturned: 8_961_534n, units: 100n * U },
];

function returnInput(unused: bigint): BuildComputationInput {
  const p = positionsFromRows("2027-06-30", W4);
  return dr1Input({
    inputs: { type: "RETURN_OF_UNUSED_CAPITAL", amountCents: 4_500_000 },
    periodEnd: "2027-06-30",
    paymentDate: "2027-06-30",
    today: "2027-06-30",
    positionsAtPayment: p,
    positionsAtCutoff: p,
    cashLedger: {
      ...EMPTY_CASH,
      capitalReceived: [{ on: "2026-11-30", amount: unused }],
    },
    taxAdvances: new Map(),
    deadline: null,
  });
}

function liquidationInput(): BuildComputationInput {
  const p = positionsFromRows("2027-12-31", W3);
  return dr1Input({
    inputs: {
      type: "SALE_OR_LIQUIDATION",
      liquidation: {
        cashAvailableCents: 105_000_000,
        windDownReserveCents: 0,
        creditors: [
          {
            payee: "Trade creditors",
            amountCents: 2_589_948,
            memo: "",
            managerCategory: null,
          },
          {
            payee: "Octagon Compute LLC",
            amountCents: 410_052,
            memo: "Accrued and unpaid Management Fee",
            managerCategory: "MANAGEMENT_FEE",
          },
        ],
        isFinal: true,
      },
    },
    periodEnd: "2027-12-31",
    paymentDate: "2027-12-31",
    today: "2027-12-31",
    positionsAtPayment: p,
    positionsAtCutoff: p,
    cashLedger: EMPTY_CASH,
    taxAdvances: new Map(),
    loanStates: [
      {
        loanId: "L1",
        lenderStakeholderId: "B",
        principalOutstanding: 2_000_000n,
        accruedInterest: 0n,
        interestPaid: 0n,
        maturityOn: "2027-06-30",
      },
    ],
    requiredFromMonth: null,
    deadline: "2028-02-14",
  });
}

describe("buildComputation — worked examples", () => {
  it("DR-1 operating distribution of $12,000.00 with a tax advance", () => {
    const c = buildComputation(dr1Input());
    expect(c.blockers).toEqual([]);
    expect(c.amount).toBe(1_200_000n);
    expect(c.availableCash?.availableCash).toBe(1_200_000n);
    expect(c.returnMeasuredAsOf).toBe("2027-05-14");
    // lines = W-1
    expect(line(c, "A").tierC).toBe(288_943n);
    expect(line(c, "B").tierC).toBe(694_108n);
    expect(line(c, "C").tierC).toBe(216_949n);
    expect(c.tierC).toBe(1_200_000n);
    expect(c.tierD).toBe(0n);
    expect(c.tierEPreferred + c.tierECommon).toBe(0n);
    expect(line(c, "M").gross).toBe(0n);
    expect(line(c, "B").taxAdvanceOffset).toBe(250_000n);
    expect(line(c, "B").net).toBe(444_108n);
    expect(line(c, "A").net).toBe(288_943n);
    expect(line(c, "C").net).toBe(216_949n);
    expect(line(c, "M").net).toBe(0n);
    expect(line(c, "A").unpaidReturnAfter).toBe(103_386n);
    expect(line(c, "B").unpaidReturnAfter).toBe(248_358n);
    expect(line(c, "C").unpaidReturnAfter).toBe(77_626n);
    expect(c.totalNet).toBe(950_000n);
    expect(c.totalTaxOffset).toBe(250_000n);
    expect(c.lines.map((l) => l.stakeholderId)).toEqual(["A", "B", "C", "M"]);
    expect(c.reserveBalance).toBe(5_000_000n);
  });

  it("DR-2 suspended default: C's line is applied to its Balance", () => {
    const c = buildComputation(dr2Input());
    expect(c.blockers).toEqual([]);
    const lc = line(c, "C");
    expect(lc.defaultOffsetBalance).toBe(216_949n);
    expect(lc.defaultOffsetInterest).toBe(0n);
    expect(lc.net).toBe(0n);
    expect(lc.offsets).toEqual([
      {
        memberDefaultId: "dC",
        toBalance: 216_949n,
        toInterest: 0n,
        toCosts: 0n,
        paysInFull: false,
      },
    ]);
    expect(c.totalNet).toBe(983_051n);
    expect(c.totalDefaultOffset).toBe(216_949n);
    expect(c.offsetReceipts).toEqual([
      {
        stakeholderId: "C",
        memberDefaultId: "dC",
        commitmentId: "cmC",
        callNoticeLineId: "lnC",
        dueOn: "2027-01-20",
        amount: 216_949n,
        units: 2_169_490n, // 2.16949 units
      },
    ]);
    // the defaulter stays in the waterfall (R17): same tier (c) as DR-1
    expect(lc.tierC).toBe(216_949n);
  });

  it("DR-3 return of unused capital goes straight to tier (d)", () => {
    const c = buildComputation(returnInput(6_900_000n));
    expect(c.blockers).toEqual([]);
    expect(c.unusedCapital).toBe(6_900_000n);
    expect(c.tierC).toBe(0n);
    expect(line(c, "A").tierD).toBe(1_000_000n);
    expect(line(c, "B").tierD).toBe(2_500_000n);
    expect(line(c, "C").tierD).toBe(1_000_000n);
    expect(line(c, "A").tierC).toBe(0n);
    expect(line(c, "A").unpaidReturnAfter).toBe(178_739n);
    expect(c.availableCash).toBeNull();
  });

  it("DR-4 return larger than unused capital is blocked", () => {
    const c = buildComputation(returnInput(4_000_000n));
    expect(codes(c)).toContain("EXCEEDS_UNUSED_CAPITAL");
  });

  it("DR-5 liquidation: creditors and loans first, then W-3", () => {
    const c = buildComputation(liquidationInput());
    expect(c.blockers).toEqual([]);
    expect(c.isLiquidation).toBe(true);
    expect(c.liquidation?.netToMembers).toBe(100_000_000n);
    expect(c.liquidation?.creditors).toBe(3_000_000n);
    expect(c.liquidation?.memberLoans).toBe(2_000_000n);
    expect(c.amount).toBe(100_000_000n);
    expect(c.tierC).toBe(13_140_562n);
    expect(c.tierD).toBe(35_826_904n);
    expect(c.tierEPreferred).toBe(35_722_774n);
    expect(c.tierECommon).toBe(15_309_760n);
    expect(line(c, "A").tierEPreferred).toBe(7_938_394n);
    expect(line(c, "B").tierEPreferred).toBe(19_845_986n);
    expect(line(c, "A").gross).toBe(18_820_053n);
    expect(line(c, "B").gross).toBe(47_050_134n);
    expect(line(c, "C").gross).toBe(18_820_053n);
    expect(line(c, "M").gross).toBe(15_309_760n);
    expect(c.liquidation?.loanPayments).toEqual([
      {
        loanId: "L1",
        lenderStakeholderId: "B",
        principal: 2_000_000n,
        interest: 0n,
      },
    ]);
  });

  it("DR-6 minimum operating reserve below $50,000 blocks", () => {
    const c = buildComputation(
      dr1Input({ cashLedger: dr1CashLedger({ minimumReserve: 4_000_000n }) }),
    );
    expect(codes(c)).toEqual(["MIN_RESERVE"]);
  });

  it("DR-7 payment date before the period end blocks", () => {
    const c = buildComputation(dr1Input({ paymentDate: "2027-03-30" }));
    expect(codes(c)).toContain("PAYMENT_BEFORE_PERIOD_END");
  });

  it("DR-8 a missing revenue month blocks", () => {
    const c = buildComputation(
      dr1Input({
        revenueMonthsSaved: ["2027-01-01", "2027-03-01"],
        cashLedger: dr1CashLedger({ months: ["2027-01-01", "2027-03-01"] }),
        operationsCommencementDate: "2027-01-15",
        requiredFromMonth: "2027-01-01",
      }),
    );
    expect(codes(c)).toEqual(["MISSING_REVENUE_MONTH"]);
    expect(c.blockers[0]?.message).toContain("2027-02");
  });

  it("DR-9 the canonical string does not depend on holder order", () => {
    const a = buildComputation(dr1Input());
    const reversedEvents = [...SCENARIO_S_EVENTS].reverse();
    const atPayment = positionsAt("2027-05-14", reversedEvents);
    const reordered = new Map([...atPayment.holders.entries()].reverse());
    const shuffled = { ...atPayment, holders: reordered };
    const b = buildComputation(
      dr1Input({
        positionsAtPayment: shuffled,
        positionsAtCutoff: shuffled,
        commonUnits: new Map([["M", 100n * U]]),
        holderMeta: new Map([...META.entries()].reverse()),
      }),
    );
    expect(canonicalForHash(b)).toBe(canonicalForHash(a));
    expect(canonicalForHash(a)).toContain('"amount":"1200000"');
    const changed = buildComputation(dr2Input());
    expect(canonicalForHash(changed)).not.toBe(canonicalForHash(a));
  });

  it("DR-10 excess held while the cure needs a confirmation", () => {
    const c = buildComputation(
      dr1Input({
        defaultsOwed: owedC({
          balance: 0n,
          interest: 10_000n,
          cureNeedsConfirmation: true,
        }),
        defaultRecords: new Map([["dC", C_DEFAULT_RECORD]]),
      }),
    );
    expect(codes(c)).toContain("DEFAULT_EXCESS_HELD");
    const same = buildComputation(
      dr1Input({
        defaultsOwed: owedC({
          balance: 0n,
          interest: 10_000n,
          cureNeedsConfirmation: false,
        }),
        defaultRecords: new Map([["dC", C_DEFAULT_RECORD]]),
      }),
    );
    expect(codes(same)).not.toContain("DEFAULT_EXCESS_HELD");
    expect(line(same, "C").defaultOffsetInterest).toBe(10_000n);
    expect(line(same, "C").net).toBe(206_949n);
  });
});

describe("stored lines and invariants", () => {
  for (const [name, input] of [
    ["DR-1", dr1Input()],
    ["DR-2", dr2Input()],
    ["DR-3", returnInput(6_900_000n)],
    ["DR-5", liquidationInput()],
  ] as const) {
    it(`${name}: rows sum to the amount; gross = default offsets + tax advance + net on every line`, () => {
      const c = buildComputation(input);
      assertComputationInvariants(c);
      const rows = distributionLineRows(c);
      const totals = distributionTotalsRow(c);
      assertLineRows(rows, totals);
      expect(rows.length).toBe(c.lines.length);
      expect(new Set(rows.map((r) => r.stakeholderId)).size).toBe(rows.length);
      expect(rows.reduce((s, r) => s + r.grossCents, 0n)).toBe(
        totals.amountCents,
      );
      for (const r of rows) {
        expect(
          r.defaultOffsetBalanceCents +
            r.defaultOffsetInterestCents +
            r.defaultOffsetCostsCents +
            r.taxAdvanceOffsetCents +
            r.netCents,
        ).toBe(r.grossCents);
        expect(
          r.tierCCents +
            r.tierDCents +
            r.tierEPreferredCents +
            r.tierECommonCents,
        ).toBe(r.grossCents);
      }
      expect(
        totals.totalDefaultOffsetCents +
          totals.totalTaxOffsetCents +
          totals.totalNetCents,
      ).toBe(totals.amountCents);
    });
  }

  it("the offset, tax-recovery and wind-down writes follow the lines", () => {
    const c = buildComputation(
      dr2Input({ taxAdvances: new Map([["B", 250_000n]]) }),
    );
    expect(offsetWrites(c)).toEqual([
      {
        stakeholderId: "C",
        memberDefaultId: "dC",
        toBalance: 216_949n,
        toInterest: 0n,
        toCosts: 0n,
        receipt: c.offsetReceipts[0],
      },
    ]);
    expect(taxRecoveryWrites(c)).toEqual([
      { stakeholderId: "B", amount: 250_000n },
    ]);
    expect(windDownTopUp(500_000n, 200_000n)).toBe(300_000n);
    expect(windDownTopUp(500_000n, 600_000n)).toBe(0n);
  });

  it("detects a tampered computation", () => {
    const c = buildComputation(dr1Input());
    const tampered = {
      ...c,
      lines: c.lines.map((l) =>
        l.stakeholderId === "A" ? { ...l, net: l.net + 1n } : l,
      ),
    };
    expect(() => assertComputationInvariants(tampered)).toThrow(/A/);
    const rows = distributionLineRows(c);
    expect(() =>
      assertLineRows(rows, {
        ...distributionTotalsRow(c),
        amountCents: 1_200_001n,
      }),
    ).toThrow();
  });

  it("reversal rows negate every money column and keep the position columns", () => {
    const c = buildComputation(dr2Input());
    const rows = distributionLineRows(c);
    const rev = reversalLineRows(rows);
    const totals = distributionTotalsRow(c);
    const revTotals = reversalTotalsRow(totals);
    expect(rev.reduce((s, r) => s + r.grossCents, 0n)).toBe(
      -totals.amountCents,
    );
    expect(revTotals.amountCents).toBe(-1_200_000n);
    expect(revTotals.totalNetCents).toBe(-983_051n);
    for (const [i, r] of rev.entries()) {
      const o = rows[i];
      if (!o) throw new Error("row");
      expect(r.grossCents + o.grossCents).toBe(0n);
      expect(r.netCents + o.netCents).toBe(0n);
      expect(r.defaultOffsetBalanceCents + o.defaultOffsetBalanceCents).toBe(
        0n,
      );
      expect(r.taxAdvanceOffsetCents + o.taxAdvanceOffsetCents).toBe(0n);
      expect(r.preferredUnits).toBe(o.preferredUnits);
      expect(r.unpaidReturnBeforeCents).toBe(o.unpaidReturnBeforeCents);
    }
  });
});

describe("recomputing positions after a finalized distribution", () => {
  const distLines = (c: Computation) =>
    c.lines
      .filter((l) => l.tierC !== 0n || l.tierD !== 0n)
      .map((l) => ({
        holderId: l.stakeholderId,
        tierC: l.tierC,
        tierD: l.tierD,
      }));
  const distEvent = (c: Computation, seq: number): LedgerEvent => ({
    kind: "DISTRIBUTION",
    on: c.paymentDate,
    seq,
    distributionId: "d1",
    lines: distLines(c),
  });

  it("DR-1: the ledger with the distribution reproduces the after-figures, and W-2 on 2027-08-13", () => {
    const c = buildComputation(dr1Input());
    const events = [...SCENARIO_S_EVENTS, distEvent(c, 10)];
    const after = positionsAt("2027-05-14", events);
    for (const l of c.lines) {
      const h = after.holders.get(l.stakeholderId);
      expect(h?.unpaidReturn ?? 0n).toBe(l.unpaidReturnAfter);
      expect(h?.unreturned ?? 0n).toBe(l.unreturnedAfter);
      expect(h?.preferredUnits ?? 0n).toBe(l.preferredUnits);
    }
    // W-2 inputs: positions on 2027-08-13 after W-1
    const later = positionsAt("2027-08-13", events);
    expect(later.holders.get("A")?.unpaidReturn).toBe(302_838n);
    expect(later.holders.get("B")?.unpaidReturn).toBe(746_988n);
    expect(later.holders.get("C")?.unpaidReturn).toBe(277_078n);
  });

  it("DR-2 through the ledger loader's ordering: the offset receipt follows its distribution", () => {
    const c = buildComputation(dr2Input());
    const created = (n: number) => new Date(Date.UTC(2026, 10, 1) + n * 60_000);
    const raw: RawLedgerItem[] = SCENARIO_S_RECEIPTS.map((r, n) => ({
      type: "RECEIPT" as const,
      id: r.receiptId,
      on: r.on,
      createdAt: created(n),
      createdByDistributionId: null,
      receipt: {
        receiptId: r.receiptId,
        holderId: r.holderId,
        kind: r.kind,
        on: r.on,
        receivedOn: r.receivedOn,
        amount: r.amount,
        units: r.units,
        prefReturnStartOn: r.prefReturnStartOn,
      },
    }));
    const receipt = c.offsetReceipts[0];
    if (!receipt) throw new Error("no planned receipt");
    raw.push(
      // created before the distribution row in wall-clock terms: order must still put it after
      {
        type: "RECEIPT",
        id: "offset-c",
        on: c.paymentDate,
        createdAt: created(1),
        createdByDistributionId: "d1",
        receipt: {
          receiptId: "offset-c",
          holderId: "C",
          kind: "BALANCE",
          on: c.paymentDate,
          receivedOn: c.paymentDate,
          amount: receipt.amount,
          units: receipt.units,
          prefReturnStartOn: c.paymentDate,
        },
      },
      {
        type: "DISTRIBUTION",
        id: "d1",
        on: c.paymentDate,
        createdAt: created(100),
        number: 1,
        lines: distLines(c),
      },
    );
    const events = buildLedgerEvents(raw, [
      ...SCENARIO_S_ALLOCATIONS,
      {
        receiptId: "offset-c",
        amount: receipt.amount,
        prefReturnStartOn: c.paymentDate,
      },
    ]);
    const dist = events.find((e) => e.kind === "DISTRIBUTION");
    if (!dist) throw new Error("no distribution event");
    // up to and including the distribution: exactly the after-figures
    const after = computePositions(events, c.paymentDate, cfg, {
      untilSeq: dist.seq + 1,
    });
    for (const l of c.lines) {
      const h = after.holders.get(l.stakeholderId);
      expect(h?.unpaidReturn ?? 0n).toBe(l.unpaidReturnAfter);
      expect(h?.unreturned ?? 0n).toBe(l.unreturnedAfter);
    }
    // the whole day: C also has the offset as new capital and units (R17)
    const day = computePositions(events, c.paymentDate, cfg);
    expect(day.holders.get("C")?.unreturned).toBe(
      line(c, "C").unreturnedAfter + 216_949n,
    );
    expect(day.holders.get("C")?.preferredUnits).toBe(100n * U + 2_169_490n);
    expect(day.holders.get("C")?.unpaidReturn).toBe(
      line(c, "C").unpaidReturnAfter,
    );
  });
});

describe("blockers added for the code as it is", () => {
  it("a Balance offset dated after today cannot be finalized (FOUNDATION refuses future receipts)", () => {
    const c = buildComputation(dr2Input({ today: "2027-05-10" }));
    expect(codes(c)).toEqual(["OFFSET_RECEIPT_IN_FUTURE"]);
    // an interest-only offset needs no receipt
    const interestOnly = buildComputation(
      dr1Input({
        today: "2027-05-10",
        defaultsOwed: owedC({
          suspended: false,
          balance: 0n,
          interest: 10_000n,
        }),
        defaultRecords: new Map([["dC", C_DEFAULT_RECORD]]),
      }),
    );
    expect(interestOnly.blockers).toEqual([]);
  });

  it("an offset must respect E11's payment date rules", () => {
    const late = buildComputation(
      dr2Input({
        defaultRecords: new Map([
          ["dC", { ...C_DEFAULT_RECORD, latestLivePaymentOn: "2027-05-20" }],
        ]),
      }),
    );
    expect(codes(late)).toEqual(["OFFSET_DATE_ORDER"]);
    const credited = buildComputation(
      dr2Input({
        defaultRecords: new Map([
          ["dC", { ...C_DEFAULT_RECORD, creditDate: "2027-05-14" }],
        ]),
      }),
    );
    expect(codes(credited)).toEqual(["OFFSET_DATE_ORDER"]);
  });

  it("PERIOD_END cutoff: refuses tier (c) above what is unpaid on the payment date", () => {
    const periodEndCfg: LlcEconomicsConfig = {
      ...cfg,
      prefAccrualCutoff: "PERIOD_END",
    };
    const cutoff = positionsAt("2027-03-31");
    const atApril = positionsAt("2027-04-15");
    const earlier: LedgerEvent = {
      kind: "DISTRIBUTION",
      on: "2027-04-15",
      seq: 20,
      distributionId: "d0",
      lines: ["A", "B", "C"].map((id) => ({
        holderId: id,
        tierC: atApril.holders.get(id)?.unpaidReturn ?? 0n,
        tierD: 0n,
      })),
    };
    const atPayment = positionsAt("2027-05-14", [
      ...SCENARIO_S_EVENTS,
      earlier,
    ]);
    const c = buildComputation(
      dr1Input({
        config: periodEndCfg,
        positionsAtCutoff: cutoff,
        positionsAtPayment: atPayment,
        taxAdvances: new Map(),
        lastLedgerEventOn: "2027-04-15",
      }),
    );
    expect(c.returnMeasuredAsOf).toBe("2027-03-31");
    expect(codes(c)).toContain("RETURN_EXCEEDS_UNPAID");
    expect(c.warnings.map((w) => w.code)).toContain("RETURN_NOT_PERIOD_END");
    // without the earlier distribution the measured figure is below the unpaid one: no blocker
    const plain = buildComputation(
      dr1Input({
        config: periodEndCfg,
        positionsAtCutoff: cutoff,
        taxAdvances: new Map(),
      }),
    );
    expect(plain.blockers).toEqual([]);
    expect(line(plain, "A").unpaidReturnMeasured).toBe(
      cutoff.holders.get("A")?.unpaidReturn,
    );
    expect(line(plain, "A").unpaidReturnBefore).toBe(392_329n);
  });

  it("a holder owed money but holding no units blocks instead of being skipped", () => {
    const p = positionsFromRows("2027-05-14", [
      ...W3,
      { id: "Z", unpaid: 100n, unreturned: 50_000n, units: 0n },
    ]);
    const c = buildComputation(
      dr1Input({
        positionsAtPayment: p,
        positionsAtCutoff: p,
        taxAdvances: new Map(),
      }),
    );
    expect(codes(c)).toEqual(["HOLDER_WITHOUT_UNITS"]);
    expect(c.lines.map((l) => l.stakeholderId)).not.toContain("Z");
  });
});

describe("other blockers and warnings", () => {
  it("payment date at most 14 days ahead", () => {
    expect(codes(buildComputation(dr1Input({ today: "2027-04-29" })))).toEqual([
      "PAYMENT_TOO_FAR_AHEAD",
    ]);
    expect(
      buildComputation(dr1Input({ today: "2027-04-30" })).blockers,
    ).toEqual([]);
  });

  it("ledger date, closed books, month end, zero amount, pending steps, loans", () => {
    expect(
      codes(buildComputation(dr1Input({ lastLedgerEventOn: "2027-05-15" }))),
    ).toContain("PAYMENT_BEFORE_LEDGER_EVENT");
    expect(
      codes(buildComputation(dr1Input({ booksClosedThrough: "2027-04-30" }))),
    ).toEqual(["PERIOD_CLOSED"]);
    expect(
      buildComputation(dr1Input({ booksClosedThrough: "2027-03-31" })).blockers,
    ).toEqual([]);
    expect(
      codes(buildComputation(dr1Input({ periodEnd: "2027-03-30" }))),
    ).toContain("PERIOD_END_NOT_MONTH_END");
    expect(
      codes(
        buildComputation(
          dr1Input({ cashLedger: { ...dr1CashLedger(), months: [] } }),
        ),
      ),
    ).toContain("AMOUNT_ZERO");
    expect(
      codes(
        buildComputation(
          dr1Input({ pendingDefaultSteps: ["Confirm the forfeiture first."] }),
        ),
      ),
    ).toEqual(["PENDING_DEFAULT_STEP"]);
    const loan = {
      loanId: "L1",
      lenderStakeholderId: "B",
      principalOutstanding: 100_000n,
      accruedInterest: 0n,
      interestPaid: 0n,
      maturityOn: "2027-05-14",
    };
    expect(codes(buildComputation(dr1Input({ loanStates: [loan] })))).toEqual([
      "LOAN_PAST_MATURITY",
    ]);
    expect(
      buildComputation(
        dr1Input({ loanStates: [{ ...loan, maturityOn: "2027-05-15" }] }),
      ).blockers,
    ).toEqual([]);
    const noOutside = buildComputation(
      dr1Input({ config: { ...cfg, balanceOutsideDate: null } }),
    );
    expect(codes(noOutside)).toEqual(["TERMS_INCOMPLETE"]);
  });

  it("waterfall refusals become blockers, not errors", () => {
    const tooMuch = returnInput(100_000_000n);
    const c = buildComputation({
      ...tooMuch,
      inputs: { type: "RETURN_OF_UNUSED_CAPITAL", amountCents: 50_000_000 },
    });
    expect(codes(c)).toContain("EXCEEDS_UNRETURNED_CAPITAL");
    expect(c.lines.every((l) => l.gross === 0n)).toBe(true);
    const liq = liquidationInput();
    const short = buildComputation({
      ...liq,
      inputs: {
        type: "SALE_OR_LIQUIDATION",
        liquidation: {
          cashAvailableCents: 4_000_000,
          windDownReserveCents: 0,
          creditors: [
            {
              payee: "Trade",
              amountCents: 5_000_000,
              memo: "",
              managerCategory: null,
            },
          ],
          isFinal: true,
        },
      },
    });
    expect(codes(short)).toContain("INSUFFICIENT_FOR_CREDITORS");
    expect(short.amount).toBe(0n);
  });

  it("liquidation repays loan interest accrued and not yet paid", () => {
    const liq = liquidationInput();
    const c = buildComputation({
      ...liq,
      loanStates: [
        {
          loanId: "L1",
          lenderStakeholderId: "B",
          principalOutstanding: 2_000_000n,
          accruedInterest: 50_000n,
          interestPaid: 20_000n,
          maturityOn: "2027-06-30",
        },
      ],
    });
    expect(c.liquidation?.memberLoans).toBe(2_030_000n);
    expect(c.liquidation?.netToMembers).toBe(99_970_000n);
    expect(c.liquidation?.loanPayments[0]?.interest).toBe(30_000n);
  });

  it("warnings", () => {
    const c = buildComputation(
      dr1Input({
        overdueUndeclared: 2,
        deadline: "2027-05-13",
        operationsCommencementDate: null,
      }),
    );
    expect(c.blockers).toEqual([]);
    expect(c.warnings.map((w) => w.code)).toEqual([
      "OVERDUE_UNDECLARED",
      "DEADLINE_PASSED",
      "OCD_NOT_SET",
    ]);
  });
});

describe("nextDistributionDeadline (R42)", () => {
  it("quarter just ended, then the current quarter", () => {
    expect(nextDistributionDeadline("2027-04-01", cfg, [])).toEqual({
      quarterEnd: "2027-03-31",
      deadline: "2027-05-15",
      label: "Q1 2027",
      distributed: false,
    });
    expect(
      nextDistributionDeadline("2027-04-01", cfg, ["2027-03-31"]).deadline,
    ).toBe("2027-08-14");
    expect(nextDistributionDeadline("2027-05-16", cfg, []).label).toBe(
      "Q2 2027",
    );
    expect(nextDistributionDeadline("2027-05-15", cfg, []).label).toBe(
      "Q1 2027",
    );
  });
});
