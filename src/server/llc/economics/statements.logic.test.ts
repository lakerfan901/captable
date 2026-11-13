import { describe, expect, it } from "vitest";
import { addDays } from "../../../lib/llc/dates";
import {
  SCENARIO_S_CONFIG,
  SCENARIO_S_EVENTS,
} from "../../../lib/llc/fixtures/scenario-s";
import { computePositions, type LedgerEvent } from "../../../lib/llc/positions";
import type { WaterfallHolder } from "../../../lib/llc/waterfall";
import {
  buildMemberStatement,
  computeFairValue,
  memberLoansOwed,
  perPreferredUnit,
  receiptDescription,
} from "./statements.logic";

const U = 1_000_000n;

// W-1 tier (c) lines on 2027-05-14 (seq after the fixture's four receipts).
const W1: LedgerEvent = {
  kind: "DISTRIBUTION",
  on: "2027-05-14",
  seq: 5,
  distributionId: "d1",
  lines: [
    { holderId: "A", tierC: 288_943n, tierD: 0n },
    { holderId: "B", tierC: 694_108n, tierD: 0n },
    { holderId: "C", tierC: 216_949n, tierD: 0n },
  ],
};
const EVENTS: LedgerEvent[] = [...SCENARIO_S_EVENTS, W1];

function statementFor(from: string, to: string) {
  const open = computePositions(EVENTS, addDays(from, -1), SCENARIO_S_CONFIG);
  const close = computePositions(EVENTS, to, SCENARIO_S_CONFIG);
  return buildMemberStatement({
    stakeholderId: "A",
    name: "A",
    from,
    to,
    openingPosition: open.holders.get("A"),
    closingPosition: close.holders.get("A"),
    openingCommonUnits: 0n,
    closingCommonUnits: 0n,
    openingTotalPreferredUnits: open.totals.preferredUnits,
    closingTotalPreferredUnits: close.totals.preferredUnits,
    receipts: [
      {
        id: "a1",
        kind: "INITIAL",
        on: "2026-11-16",
        amount: 10_000_000n,
        units: 100n * U,
      },
    ],
    distributions: [
      {
        distributionId: "d1",
        number: 1,
        type: "OPERATING",
        paymentDate: "2027-05-14",
        tierC: 288_943n,
        tierD: 0n,
        tierEPreferred: 0n,
        tierECommon: 0n,
        gross: 288_943n,
        defaultOffset: 0n,
        taxAdvanceOffset: 0n,
        net: 288_943n,
      },
    ],
    transfers: [],
    advances: [],
    commitment: null,
    defaults: [],
    taxAdvanceOutstanding: 0n,
  });
}

// W-3 holders (positions before a full exit).
const W3_HOLDERS: WaterfallHolder[] = [
  {
    holderId: "A",
    unpaidReturn: 2_920_125n,
    unreturned: 7_961_534n,
    preferredUnits: 100n * U,
    commonUnits: 0n,
  },
  {
    holderId: "B",
    unpaidReturn: 7_300_312n,
    unreturned: 19_903_836n,
    preferredUnits: 250n * U,
    commonUnits: 0n,
  },
  {
    holderId: "C",
    unpaidReturn: 2_920_125n,
    unreturned: 7_961_534n,
    preferredUnits: 100n * U,
    commonUnits: 0n,
  },
  {
    holderId: "M",
    unpaidReturn: 0n,
    unreturned: 0n,
    preferredUnits: 0n,
    commonUnits: 100n * U,
  },
];

describe("buildMemberStatement", () => {
  it("ST-1 holder A, Q2 2027 with the W-1 distribution", () => {
    const s = statementFor("2027-04-01", "2027-06-30");
    expect(s.opening.accruedReturn).toBe(295_890n);
    expect(s.opening.unpaidReturn).toBe(295_890n);
    expect(s.closing.accruedReturn).toBe(495_342n);
    expect(s.period.returnAccrued).toBe(199_452n);
    expect(s.period.returnPaid).toBe(288_943n);
    expect(s.closing.unpaidReturn).toBe(206_399n);
    expect(
      s.opening.unpaidReturn +
        s.period.returnAccrued -
        s.period.returnPaid -
        s.period.returnExtinguished,
    ).toBe(s.closing.unpaidReturn);
    expect(s.period.contributions).toBe(0n);
    expect(s.period.grossDistributions).toBe(288_943n);
    expect(s.period.netPaid).toBe(288_943n);
    expect(s.activity.map((a) => [a.on, a.kind, a.amount])).toEqual([
      ["2027-05-14", "DISTRIBUTION", 288_943n],
    ]);
    expect(s.opening.preferredPct).toBe("22.2222"); // 100 of 450 Preferred Units;
    expect(s.closing.unreturned).toBe(10_000_000n);
  });

  it("member with no activity: all zeros", () => {
    const s = buildMemberStatement({
      stakeholderId: "Z",
      name: "Z",
      from: "2027-01-01",
      to: "2027-03-31",
      openingPosition: undefined,
      closingPosition: undefined,
      openingCommonUnits: 0n,
      closingCommonUnits: 0n,
      openingTotalPreferredUnits: 0n,
      closingTotalPreferredUnits: 0n,
      receipts: [],
      distributions: [],
      transfers: [],
      advances: [],
      commitment: null,
      defaults: [],
      taxAdvanceOutstanding: 0n,
    });
    expect(s.closing.unpaidReturn).toBe(0n);
    expect(s.closing.preferredPct).toBe("0.0000");
    expect(Object.values(s.period).every((v) => v === 0n)).toBe(true);
    expect(s.activity).toEqual([]);
  });

  it("rejects from > to", () => {
    expect(() => statementFor("2027-07-01", "2027-06-30")).toThrow(
      expect.objectContaining({ code: "BAD_RANGE" }),
    );
  });
});

describe("computeFairValue", () => {
  const names = new Map([
    ["A", "A"],
    ["B", "B"],
    ["C", "C"],
    ["M", "M"],
  ]);

  it("ST-2 fair value = H-1", () => {
    const r = computeFairValue({
      assetFmv: 90_000_000n,
      cashOnHand: 15_000_000n,
      liabilities: 3_000_000n,
      memberLoans: 2_000_000n,
      holders: W3_HOLDERS,
      residualPreferredBps: 7000,
      names,
      selection: { stakeholderId: "A", unitsValued: 25n * U },
    });
    expect(r.netToMembers).toBe(100_000_000n);
    const a = r.lines.find((l) => l.holderId === "A");
    expect(a?.gross).toBe(18_820_053n);
    expect(a?.perPreferredUnit).toBe(188_201n);
    expect(r.lines.find((l) => l.holderId === "M")?.perPreferredUnit).toBe(
      null,
    );
    expect(r.selected).toEqual({
      stakeholderId: "A",
      unitClass: "PREFERRED",
      classGross: 18_820_053n,
      unitsHeld: 100n * U,
      unitsValued: 25n * U,
      fairValue: 4_705_013n,
    });
  });

  describe("ST-3 dual-class holder = H-2", () => {
    const holders: WaterfallHolder[] = [
      {
        holderId: "X",
        unpaidReturn: 0n,
        unreturned: 10_000_000n,
        preferredUnits: 100n * U,
        commonUnits: 100n * U,
      },
      {
        holderId: "Y",
        unpaidReturn: 0n,
        unreturned: 10_000_000n,
        preferredUnits: 100n * U,
        commonUnits: 0n,
      },
    ];
    const run = (
      selection: Parameters<typeof computeFairValue>[0]["selection"],
    ) =>
      computeFairValue({
        assetFmv: 30_000_000n,
        cashOnHand: 0n,
        liabilities: 0n,
        memberLoans: 0n,
        holders,
        residualPreferredBps: 7000,
        names: new Map(),
        selection,
      });

    it("line X", () => {
      const x = run(null).lines.find((l) => l.holderId === "X");
      expect(x?.tierD).toBe(10_000_000n);
      expect(x?.tierEPreferred).toBe(3_500_000n);
      expect(x?.tierECommon).toBe(3_000_000n);
      expect(x?.gross).toBe(16_500_000n);
      // Never includes tierECommon: 135,000.00 / 100 units.
      expect(x?.perPreferredUnit).toBe(135_000n);
    });

    it("PREFERRED 50 u → $67,500.00", () => {
      const s = run({
        stakeholderId: "X",
        unitClass: "PREFERRED",
        unitsValued: 50n * U,
      }).selected;
      expect(s?.classGross).toBe(13_500_000n);
      expect(s?.fairValue).toBe(6_750_000n);
    });

    it("COMMON 40 u → $12,000.00", () => {
      const s = run({
        stakeholderId: "X",
        unitClass: "COMMON",
        unitsValued: 40n * U,
      }).selected;
      expect(s?.classGross).toBe(3_000_000n);
      expect(s?.unitsHeld).toBe(100n * U);
      expect(s?.fairValue).toBe(1_200_000n);
    });

    it("requires the class for a holder of both", () => {
      expect(() => run({ stakeholderId: "X" })).toThrow(
        expect.objectContaining({ code: "UNIT_CLASS_REQUIRED" }),
      );
    });

    it("defaults to the only class and all units", () => {
      const s = run({ stakeholderId: "Y" }).selected;
      expect(s?.unitClass).toBe("PREFERRED");
      expect(s?.unitsValued).toBe(100n * U);
      expect(s?.fairValue).toBe(s?.classGross);
    });
  });
});

describe("helpers", () => {
  it("memberLoansOwed: principal + accrued unpaid interest", () => {
    expect(
      memberLoansOwed([
        {
          principalOutstanding: 2_000_000n,
          accruedInterest: 50_000n,
          interestPaid: 20_000n,
        },
        { principalOutstanding: 0n, accruedInterest: 100n, interestPaid: 200n },
      ]),
    ).toBe(2_030_000n);
  });

  it("perPreferredUnit null without Preferred Units", () => {
    expect(
      perPreferredUnit(
        {
          holderId: "M",
          tierC: 0n,
          tierD: 0n,
          tierEPreferred: 0n,
          tierECommon: 5n,
          gross: 5n,
        },
        0n,
      ),
    ).toBe(null);
  });
});

describe("receiptDescription (money wired before acceptance)", () => {
  const base = { id: "r1", amount: 4_000_000n, units: 40n * U };

  it("states the receipt date and the accrual start when they differ from the ledger date", () => {
    expect(
      receiptDescription({
        ...base,
        kind: "INITIAL",
        on: "2026-11-10",
        receivedOn: "2026-11-09",
        accrualStartOn: "2026-11-09",
      }),
    ).toBe(
      "Initial Installment (received 2026-11-09; capital and Units from 2026-11-10 (acceptance); Preferred Return accrues from 2026-11-09)",
    );
  });

  it("keeps the plain label when received on the ledger date", () => {
    expect(
      receiptDescription({
        ...base,
        kind: "INITIAL",
        on: "2026-11-10",
        receivedOn: "2026-11-10",
        accrualStartOn: "2026-11-10",
      }),
    ).toBe("Initial Installment");
  });

  it("never prints a single accrual date for a Balance receipt", () => {
    expect(
      receiptDescription({
        ...base,
        kind: "BALANCE",
        on: "2026-11-10",
        receivedOn: "2026-11-09",
        accrualStartOn: "2027-01-20",
      }),
    ).toBe(
      "Balance payment (received 2026-11-09; capital and Units from 2026-11-10 (acceptance))",
    );
  });
});
