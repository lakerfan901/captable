import { describe, expect, it } from "vitest";
import type { OffsetTarget } from "./config";
import { LlcMathError } from "./money";
import {
  applyDefaultOffset,
  type DefaultOwed,
  fairValueOfUnits,
  hypotheticalLiquidation,
  liquidationWaterfall,
  netDistributionLine,
  runWaterfall,
  type WaterfallHolder,
  type WaterfallResult,
} from "./waterfall";

// Scenario S-style holder rows are built by hand from the plan's E3 table
// (E3 does not depend on E2's positions code or fixture).

const U = 1_000_000n; // micro-units per unit
const FULL = { mode: "FULL", residualPreferredBps: 7000 } as const;
const D_ONLY = { mode: "D_ONLY", residualPreferredBps: 7000 } as const;
const TEXT_ORDER: OffsetTarget[] = ["BALANCE", "INTEREST", "COSTS"];
const ALT_ORDER: OffsetTarget[] = ["COSTS", "INTEREST", "BALANCE"];

function pref(
  holderId: string,
  unpaidReturn: bigint,
  unreturned: bigint,
  units: bigint,
): WaterfallHolder {
  return {
    holderId,
    unpaidReturn,
    unreturned,
    preferredUnits: units * U,
    commonUnits: 0n,
  };
}
const M: WaterfallHolder = {
  holderId: "M",
  unpaidReturn: 0n,
  unreturned: 0n,
  preferredUnits: 0n,
  commonUnits: 100n * U,
};

function line(r: WaterfallResult, id: string) {
  const l = r.lines.find((x) => x.holderId === id);
  if (!l) throw new Error(`no line for ${id}`);
  return l;
}

function expectCode(fn: () => unknown, code: string) {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(LlcMathError);
    expect((e as LlcMathError).code).toBe(code);
    return;
  }
  throw new Error(`expected throw ${code}`);
}

function owed(p: Partial<DefaultOwed> = {}): DefaultOwed {
  return {
    memberDefaultId: "d1",
    dueOn: "2027-01-20",
    suspended: true,
    balance: 6_000_000n,
    interest: 224_877n,
    costs: 120_000n,
    cureNeedsConfirmation: false,
    ...p,
  };
}

const W3_HOLDERS: WaterfallHolder[] = [
  pref("A", 2_920_125n, 7_961_534n, 100n),
  pref("B", 7_300_312n, 19_903_836n, 250n),
  pref("C", 2_920_125n, 7_961_534n, 100n),
  M,
];

const W4_HOLDERS: WaterfallHolder[] = [
  pref("A", 178_739n, 8_961_534n, 100n),
  pref("B", 446_849n, 22_403_836n, 250n),
  pref("C", 178_740n, 8_961_534n, 100n),
  M,
];

const XYZ = (unpaid: bigint) => [
  pref("X", unpaid, 0n, 1n),
  pref("Y", unpaid, 0n, 1n),
  pref("Z", unpaid, 0n, 1n),
  M,
];

describe("runWaterfall", () => {
  it("W-1 partial tier (c)", () => {
    const r = runWaterfall(
      1_200_000n,
      [
        pref("A", 392_329n, 10_000_000n, 100n),
        pref("B", 942_466n, 25_000_000n, 250n),
        pref("C", 294_575n, 10_000_000n, 100n),
        M,
      ],
      FULL,
    );
    expect(r.tierC).toBe(1_200_000n);
    expect(line(r, "A").tierC).toBe(288_943n);
    expect(line(r, "B").tierC).toBe(694_108n);
    expect(line(r, "C").tierC).toBe(216_949n);
    expect(r.tierD).toBe(0n);
    expect(r.tierEPreferred + r.tierECommon).toBe(0n);
    expect(line(r, "M").gross).toBe(0n);
  });

  it("W-2 exhausts (c), part of (d)", () => {
    const r = runWaterfall(
      6_000_000n,
      [
        pref("A", 302_838n, 10_000_000n, 100n),
        pref("B", 746_988n, 25_000_000n, 250n),
        pref("C", 277_078n, 10_000_000n, 100n),
        M,
      ],
      FULL,
    );
    expect(r.tierC).toBe(1_326_904n);
    expect(line(r, "A").tierC).toBe(302_838n);
    expect(line(r, "B").tierC).toBe(746_988n);
    expect(line(r, "C").tierC).toBe(277_078n);
    expect(r.tierD).toBe(4_673_096n);
    expect(line(r, "A").tierD).toBe(1_038_466n);
    expect(line(r, "B").tierD).toBe(2_596_164n);
    expect(line(r, "C").tierD).toBe(1_038_466n);
    expect(line(r, "A").gross).toBe(1_341_304n);
    expect(line(r, "B").gross).toBe(3_343_152n);
    expect(line(r, "C").gross).toBe(1_315_544n);
    expect(r.tierEPreferred + r.tierECommon).toBe(0n);
  });

  it("W-3 full exit through (e)", () => {
    const r = runWaterfall(100_000_000n, W3_HOLDERS, FULL);
    expect(r.tierC).toBe(13_140_562n);
    expect(r.tierD).toBe(35_826_904n);
    expect(r.tierEPreferred).toBe(35_722_774n);
    expect(r.tierECommon).toBe(15_309_760n);
    expect(r.tierEPreferred + r.tierECommon).toBe(51_032_534n);
    expect(line(r, "A").tierEPreferred).toBe(7_938_394n);
    expect(line(r, "B").tierEPreferred).toBe(19_845_986n);
    expect(line(r, "C").tierEPreferred).toBe(7_938_394n);
    expect(line(r, "A").gross).toBe(18_820_053n);
    expect(line(r, "B").gross).toBe(47_050_134n);
    expect(line(r, "C").gross).toBe(18_820_053n);
    expect(line(r, "M").gross).toBe(15_309_760n);
    expect(line(r, "M").tierECommon).toBe(15_309_760n);
    expect(r.lines.reduce((s, l) => s + l.gross, 0n)).toBe(100_000_000n);
    expect(r.lines.map((l) => l.holderId)).toEqual(["A", "B", "C", "M"]);
  });

  it("W-4 return of unused capital (D_ONLY)", () => {
    const r = runWaterfall(4_500_000n, W4_HOLDERS, D_ONLY);
    expect(r.tierC).toBe(0n);
    expect(r.tierEPreferred + r.tierECommon).toBe(0n);
    expect(line(r, "A").tierD).toBe(1_000_000n);
    expect(line(r, "B").tierD).toBe(2_500_000n);
    expect(line(r, "C").tierD).toBe(1_000_000n);
    for (const l of r.lines) expect(l.tierC).toBe(0n);
  });

  it("W-5 D_ONLY larger than unreturned capital", () => {
    expectCode(
      () => runWaterfall(50_000_000n, W4_HOLDERS, D_ONLY),
      "EXCEEDS_UNRETURNED_CAPITAL",
    );
  });

  it("W-6 cents: residual split", () => {
    const r = runWaterfall(10_000n, XYZ(1_000n), FULL);
    expect(r.tierC).toBe(3_000n);
    for (const id of ["X", "Y", "Z"]) expect(line(r, id).tierC).toBe(1_000n);
    expect(r.tierEPreferred).toBe(4_900n);
    expect(line(r, "X").tierEPreferred).toBe(1_634n);
    expect(line(r, "Y").tierEPreferred).toBe(1_633n);
    expect(line(r, "Z").tierEPreferred).toBe(1_633n);
    expect(r.tierECommon).toBe(2_100n);
    expect(line(r, "M").tierECommon).toBe(2_100n);
  });

  it("W-7 cents: tier (c) remainder by key", () => {
    const r = runWaterfall(100n, XYZ(1_000n), FULL);
    expect(line(r, "X").tierC).toBe(34n);
    expect(line(r, "Y").tierC).toBe(33n);
    expect(line(r, "Z").tierC).toBe(33n);
    expect(r.tierD + r.tierEPreferred + r.tierECommon).toBe(0n);
  });

  it("W-8 cents: pool tie goes to the larger weight", () => {
    const r = runWaterfall(
      5n,
      [pref("X", 0n, 0n, 1n), pref("Y", 0n, 0n, 1n), M],
      FULL,
    );
    expect(r.tierEPreferred).toBe(4n);
    expect(line(r, "X").tierEPreferred).toBe(2n);
    expect(line(r, "Y").tierEPreferred).toBe(2n);
    expect(r.tierECommon).toBe(1n);
    expect(line(r, "M").tierECommon).toBe(1n);
  });

  it("W-9 amount 0", () => {
    const r = runWaterfall(0n, W3_HOLDERS, FULL);
    expect(r).toEqual({
      amount: 0n,
      tierC: 0n,
      tierD: 0n,
      tierEPreferred: 0n,
      tierECommon: 0n,
      lines: ["A", "B", "C", "M"].map((holderId) => ({
        holderId,
        tierC: 0n,
        tierD: 0n,
        tierEPreferred: 0n,
        tierECommon: 0n,
        gross: 0n,
      })),
    });
    // zero amount with no common holder does not throw
    expect(runWaterfall(0n, [pref("X", 0n, 0n, 1n)], FULL).lines).toHaveLength(
      1,
    );
    expect(runWaterfall(0n, [], FULL).lines).toEqual([]);
  });

  it("W-10 no common units", () => {
    expectCode(
      () => runWaterfall(1_000n, [pref("X", 0n, 0n, 1n)], FULL),
      "NO_UNITS_IN_CLASS",
    );
  });

  it("throws on bad input", () => {
    expectCode(() => runWaterfall(-1n, W3_HOLDERS, FULL), "NEGATIVE");
    expectCode(
      () => runWaterfall(1n, [pref("X", -1n, 0n, 1n), M], FULL),
      "NEGATIVE",
    );
    expectCode(
      () =>
        runWaterfall(1n, [pref("X", 0n, 0n, 1n), pref("X", 0n, 0n, 1n)], FULL),
      "DUPLICATE_HOLDER",
    );
    expectCode(
      () =>
        runWaterfall(1n, W3_HOLDERS, {
          mode: "FULL",
          residualPreferredBps: 10_001,
        }),
      "BAD_BPS",
    );
  });

  it("lines are sorted by holderId regardless of input order", () => {
    const a = runWaterfall(100_000_000n, W3_HOLDERS, FULL);
    const b = runWaterfall(100_000_000n, [...W3_HOLDERS].reverse(), FULL);
    expect(b).toEqual(a);
  });
});

describe("applyDefaultOffset", () => {
  it("suspended default, text order", () => {
    expect(applyDefaultOffset(500_000n, owed(), TEXT_ORDER)).toEqual({
      memberDefaultId: "d1",
      toBalance: 500_000n,
      toInterest: 0n,
      toCosts: 0n,
      paysInFull: false,
      remaining: 0n,
    });
  });

  it("cured default skips BALANCE", () => {
    const r = applyDefaultOffset(
      100_000n,
      owed({
        suspended: false,
        balance: 0n,
        interest: 25_644n,
        costs: 30_000n,
      }),
      TEXT_ORDER,
    );
    expect(r).toMatchObject({
      toBalance: 0n,
      toInterest: 25_644n,
      toCosts: 30_000n,
      paysInFull: true,
      remaining: 44_356n,
    });
  });

  it("rejects an order that is not a permutation of the three targets", () => {
    expectCode(
      () => applyDefaultOffset(1n, owed(), ["BALANCE", "BALANCE", "COSTS"]),
      "BAD_OFFSET_ORDER",
    );
    expectCode(
      () => applyDefaultOffset(1n, owed(), ["INTEREST", "COSTS"]),
      "BAD_OFFSET_ORDER",
    );
    expectCode(() => applyDefaultOffset(-1n, owed(), TEXT_ORDER), "NEGATIVE");
  });
});

describe("netDistributionLine", () => {
  it("N-1 suspended, text order", () => {
    const r = netDistributionLine({
      gross: 500_000n,
      defaults: [owed()],
      taxAdvanceOutstanding: 0n,
      order: TEXT_ORDER,
    });
    expect(r.offsets[0]?.toBalance).toBe(500_000n);
    expect(r.defaultOffsetBalance).toBe(500_000n);
    expect(r.net).toBe(0n);
    expect(r.excessHeld).toBe(false);
  });

  it("N-2 alternative order", () => {
    const r = netDistributionLine({
      gross: 500_000n,
      defaults: [owed()],
      taxAdvanceOutstanding: 0n,
      order: ALT_ORDER,
    });
    expect(r.offsets[0]).toMatchObject({
      toCosts: 120_000n,
      toInterest: 224_877n,
      toBalance: 155_123n,
      paysInFull: false,
    });
    expect(r.net).toBe(0n);
  });

  it("N-3 pays in full", () => {
    const r = netDistributionLine({
      gross: 7_000_000n,
      defaults: [owed()],
      taxAdvanceOutstanding: 0n,
      order: TEXT_ORDER,
    });
    expect(r.offsets).toEqual([
      {
        memberDefaultId: "d1",
        toBalance: 6_000_000n,
        toInterest: 224_877n,
        toCosts: 120_000n,
        paysInFull: true,
      },
    ]);
    expect(r.net).toBe(655_123n);
    expect(r.excessHeld).toBe(false);
  });

  it("N-4 tax advance", () => {
    const r = netDistributionLine({
      gross: 1_341_304n,
      defaults: [],
      taxAdvanceOutstanding: 250_000n,
      order: TEXT_ORDER,
    });
    expect(r.taxAdvanceOffset).toBe(250_000n);
    expect(r.net).toBe(1_091_304n);
  });

  it("N-5 tax advance larger than the line", () => {
    const r = netDistributionLine({
      gross: 288_943n,
      defaults: [],
      taxAdvanceOutstanding: 400_000n,
      order: TEXT_ORDER,
    });
    expect(r.taxAdvanceOffset).toBe(288_943n);
    expect(r.net).toBe(0n);
    expect(400_000n - r.taxAdvanceOffset).toBe(111_057n);
  });

  it("N-6 cured default, costs still owed", () => {
    const r = netDistributionLine({
      gross: 100_000n,
      defaults: [
        owed({
          suspended: false,
          balance: 0n,
          interest: 25_644n,
          costs: 30_000n,
        }),
      ],
      taxAdvanceOutstanding: 0n,
      order: TEXT_ORDER,
    });
    expect(r.defaultOffsetInterest).toBe(25_644n);
    expect(r.defaultOffsetCosts).toBe(30_000n);
    expect(r.defaultOffsetBalance).toBe(0n);
    expect(r.net).toBe(44_356n);
  });

  it("N-7 default then tax advance", () => {
    const r = netDistributionLine({
      gross: 7_000_000n,
      defaults: [owed()],
      taxAdvanceOutstanding: 500_000n,
      order: TEXT_ORDER,
    });
    expect(r.defaultOffsetBalance).toBe(6_000_000n);
    expect(r.defaultOffsetInterest).toBe(224_877n);
    expect(r.defaultOffsetCosts).toBe(120_000n);
    expect(r.taxAdvanceOffset).toBe(500_000n);
    expect(r.net).toBe(155_123n);
  });

  it("N-8 excess held", () => {
    const input = (cureNeedsConfirmation: boolean) => ({
      gross: 100_000n,
      defaults: [
        owed({
          suspended: true,
          cureNeedsConfirmation,
          balance: 0n,
          interest: 10_000n,
          costs: 0n,
        }),
      ],
      taxAdvanceOutstanding: 0n,
      order: TEXT_ORDER,
    });
    const held = netDistributionLine(input(true));
    expect(held.offsets[0]).toMatchObject({
      toInterest: 10_000n,
      paysInFull: true,
    });
    expect(held.net).toBe(90_000n);
    expect(held.excessHeld).toBe(true);
    const notHeld = netDistributionLine(input(false));
    expect(notHeld.net).toBe(90_000n);
    expect(notHeld.excessHeld).toBe(false);
  });

  it("gross 0 gives all zeros", () => {
    const r = netDistributionLine({
      gross: 0n,
      defaults: [owed()],
      taxAdvanceOutstanding: 100n,
      order: TEXT_ORDER,
    });
    expect(r.defaultOffsetBalance + r.defaultOffsetInterest).toBe(0n);
    expect(r.defaultOffsetCosts + r.taxAdvanceOffset + r.net).toBe(0n);
    expect(r.excessHeld).toBe(false);
  });

  it("processes defaults by dueOn then id; a suspended default absorbs the rest", () => {
    const r = netDistributionLine({
      gross: 1_000_000n,
      defaults: [
        owed({
          memberDefaultId: "late",
          dueOn: "2027-03-31",
          balance: 5_000_000n,
          interest: 0n,
          costs: 0n,
        }),
        owed({
          memberDefaultId: "b",
          dueOn: "2027-01-20",
          balance: 300_000n,
          interest: 0n,
          costs: 0n,
        }),
        owed({
          memberDefaultId: "a",
          dueOn: "2027-01-20",
          balance: 200_000n,
          interest: 0n,
          costs: 0n,
        }),
      ],
      taxAdvanceOutstanding: 50_000n,
      order: TEXT_ORDER,
    });
    expect(r.offsets.map((o) => [o.memberDefaultId, o.toBalance])).toEqual([
      ["a", 200_000n],
      ["b", 300_000n],
      ["late", 500_000n],
    ]);
    expect(r.taxAdvanceOffset).toBe(0n);
    expect(r.net).toBe(0n);
  });
});

describe("liquidationWaterfall", () => {
  it("L-1 creditors and loans first, then W-3", () => {
    const r = liquidationWaterfall({
      cash: 105_000_000n,
      creditors: 3_000_000n,
      memberLoans: 2_000_000n,
      windDownReserve: 0n,
      holders: W3_HOLDERS,
      residualPreferredBps: 7000,
    });
    expect(r.netToMembers).toBe(100_000_000n);
    expect(r.waterfall).toEqual(runWaterfall(100_000_000n, W3_HOLDERS, FULL));
  });

  it("L-2 insufficient for creditors", () => {
    expectCode(
      () =>
        liquidationWaterfall({
          cash: 4_000_000n,
          creditors: 5_000_000n,
          memberLoans: 0n,
          windDownReserve: 0n,
          holders: W3_HOLDERS,
          residualPreferredBps: 7000,
        }),
      "INSUFFICIENT_FOR_CREDITORS",
    );
  });

  it("wind-down reserve is retained before members", () => {
    const r = liquidationWaterfall({
      cash: 1_000_000n,
      creditors: 100_000n,
      memberLoans: 0n,
      windDownReserve: 400_000n,
      holders: W3_HOLDERS,
      residualPreferredBps: 7000,
    });
    expect(r.netToMembers).toBe(500_000n);
    expect(r.waterfall.amount).toBe(500_000n);
  });
});

describe("hypotheticalLiquidation and fairValueOfUnits", () => {
  it("H-1 fair value", () => {
    const r = hypotheticalLiquidation({
      assetFmv: 90_000_000n,
      cashOnHand: 15_000_000n,
      liabilities: 3_000_000n,
      memberLoans: 2_000_000n,
      holders: W3_HOLDERS,
      residualPreferredBps: 7000,
    });
    expect(r.netToMembers).toBe(100_000_000n);
    expect(r.waterfall).toEqual(runWaterfall(100_000_000n, W3_HOLDERS, FULL));
    expect(line(r.waterfall, "A").gross).toBe(18_820_053n);
    expect(fairValueOfUnits(18_820_053n, 25n * U, 100n * U)).toBe(4_705_013n);
  });

  it("negative net gives zero and an all-zero waterfall", () => {
    const r = hypotheticalLiquidation({
      assetFmv: 1_000n,
      cashOnHand: 0n,
      liabilities: 5_000n,
      memberLoans: 0n,
      holders: W3_HOLDERS,
      residualPreferredBps: 7000,
    });
    expect(r.netToMembers).toBe(0n);
    expect(r.waterfall).toEqual(runWaterfall(0n, W3_HOLDERS, FULL));
    for (const l of r.waterfall.lines) expect(l.gross).toBe(0n);
  });

  it("fairValueOfUnits bounds", () => {
    expect(fairValueOfUnits(18_820_053n, 100n * U, 100n * U)).toBe(18_820_053n);
    expect(fairValueOfUnits(18_820_053n, 0n, 100n * U)).toBe(0n);
    expectCode(
      () => fairValueOfUnits(1_000n, 101n * U, 100n * U),
      "BAD_UNITS_VALUED",
    );
    expectCode(() => fairValueOfUnits(1_000n, 0n, 0n), "BAD_UNITS_VALUED");
  });
});

describe("properties (fixed-seed LCG)", () => {
  function lcg(start: bigint) {
    let seed = start;
    return (mod: bigint) => {
      seed = (seed * 6364136223846793005n + 1442695040888963407n) % 2n ** 64n;
      return (seed >> 33n) % mod;
    };
  }

  function randomHolders(next: (m: bigint) => bigint): WaterfallHolder[] {
    const count = Number(next(6n)) + 1;
    const holders: WaterfallHolder[] = [];
    for (let j = 0; j < count; j++) {
      const zero = next(4n) === 0n; // some zero-weight holders
      holders.push({
        holderId: `h${j}`,
        unpaidReturn: zero ? 0n : next(5_000_000n),
        unreturned: zero ? 0n : next(50_000_000n),
        preferredUnits: zero ? 0n : next(500n * U),
        commonUnits: 0n,
      });
    }
    const first = holders[0];
    if (first && first.preferredUnits === 0n) first.preferredUnits = 1n * U;
    holders.push({
      holderId: "common",
      unpaidReturn: 0n,
      unreturned: 0n,
      preferredUnits: 0n,
      commonUnits: next(100n * U) + 1n,
    });
    return holders;
  }

  function checkResult(
    r: WaterfallResult,
    amount: bigint,
    holders: readonly WaterfallHolder[],
    mode: "FULL" | "D_ONLY" = "FULL",
  ) {
    const sumUnpaid = holders.reduce((s, h) => s + h.unpaidReturn, 0n);
    const sumUnreturned = holders.reduce((s, h) => s + h.unreturned, 0n);
    expect(r.amount).toBe(amount);
    expect(r.lines).toHaveLength(holders.length);
    let gross = 0n;
    let c = 0n;
    let d = 0n;
    let ep = 0n;
    let ec = 0n;
    for (const l of r.lines) {
      const h = holders.find((x) => x.holderId === l.holderId);
      if (!h) throw new Error("missing holder");
      expect(l.tierC <= h.unpaidReturn).toBe(true);
      expect(l.tierD <= h.unreturned).toBe(true);
      expect(l.tierC >= 0n && l.tierD >= 0n).toBe(true);
      expect(l.tierEPreferred >= 0n && l.tierECommon >= 0n).toBe(true);
      expect(l.gross).toBe(
        l.tierC + l.tierD + l.tierEPreferred + l.tierECommon,
      );
      gross += l.gross;
      c += l.tierC;
      d += l.tierD;
      ep += l.tierEPreferred;
      ec += l.tierECommon;
    }
    expect(gross).toBe(amount);
    expect(c).toBe(r.tierC);
    expect(d).toBe(r.tierD);
    expect(ep).toBe(r.tierEPreferred);
    expect(ec).toBe(r.tierECommon);
    // FULL priority: (d) only after (c) is paid in full, (e) only after (d).
    // D_ONLY (R13) skips (c) by design.
    if (mode === "FULL" && r.tierD > 0n) expect(r.tierC).toBe(sumUnpaid);
    if (r.tierEPreferred + r.tierECommon > 0n) {
      expect(r.tierC).toBe(sumUnpaid);
      expect(r.tierD).toBe(sumUnreturned);
    }
  }

  it("300 random waterfalls: no cent created or lost, caps and priority hold", () => {
    const next = lcg(20261113n);
    const regimes = { c: 0, d: 0, e: 0 };
    for (let i = 0; i < 300; i++) {
      const holders = randomHolders(next);
      const sumUnpaid = holders.reduce((s, h) => s + h.unpaidReturn, 0n);
      const sumUnreturned = holders.reduce((s, h) => s + h.unreturned, 0n);
      // spread amounts over: inside (c), inside (d), into (e)
      const regime = i % 3;
      const amount =
        regime === 0
          ? next(sumUnpaid + 1n)
          : regime === 1
            ? sumUnpaid + next(sumUnreturned + 1n)
            : sumUnpaid + sumUnreturned + next(100_000_000n);
      const r = runWaterfall(amount, holders, FULL);
      checkResult(r, amount, holders);
      if (r.tierEPreferred + r.tierECommon > 0n) regimes.e++;
      else if (r.tierD > 0n) regimes.d++;
      else regimes.c++;
      expect(runWaterfall(amount, [...holders].reverse(), FULL)).toEqual(r);

      if (sumUnreturned > 0n) {
        const dAmount = next(sumUnreturned + 1n);
        const dr = runWaterfall(dAmount, holders, D_ONLY);
        checkResult(dr, dAmount, holders, "D_ONLY");
        expect(dr.tierD).toBe(dAmount);
        expect(dr.tierC + dr.tierEPreferred + dr.tierECommon).toBe(0n);
      }
    }
    expect(regimes.c).toBeGreaterThan(50);
    expect(regimes.d).toBeGreaterThan(50);
    expect(regimes.e).toBeGreaterThan(50);
  });

  it("amount sweep over a fixed holder set: lines always sum to the amount", () => {
    // Every cent from $0.00 to $20.00, then every $1,234.57 step to $1.2M on W-3 holders.
    const small = [
      pref("X", 1_000n, 333n, 1n),
      pref("Y", 7n, 0n, 3n),
      pref("Z", 0n, 101n, 0n),
      M,
    ];
    for (let amount = 0n; amount <= 2_000n; amount++) {
      checkResult(runWaterfall(amount, small, FULL), amount, small);
    }
    for (let amount = 0n; amount <= 120_000_000n; amount += 123_457n) {
      checkResult(runWaterfall(amount, W3_HOLDERS, FULL), amount, W3_HOLDERS);
    }
  });

  it("300 random netted lines: gross = offsets + tax advance + net", () => {
    const next = lcg(777n);
    const orders: OffsetTarget[][] = [TEXT_ORDER, ALT_ORDER];
    for (let i = 0; i < 300; i++) {
      const count = Number(next(3n));
      const defaults: DefaultOwed[] = Array.from({ length: count }, (_, j) => ({
        memberDefaultId: `d${j}`,
        dueOn: `2027-0${Number(next(3n)) + 1}-15`,
        suspended: next(2n) === 0n,
        balance: next(3_000_000n),
        interest: next(200_000n),
        costs: next(100_000n),
        cureNeedsConfirmation: next(2n) === 0n,
      }));
      const gross = next(5_000_000n);
      const r = netDistributionLine({
        gross,
        defaults,
        taxAdvanceOutstanding: next(500_000n),
        order: orders[i % 2] ?? TEXT_ORDER,
      });
      const offs = r.offsets.reduce(
        (s, o) => s + o.toBalance + o.toInterest + o.toCosts,
        0n,
      );
      expect(offs).toBe(
        r.defaultOffsetBalance + r.defaultOffsetInterest + r.defaultOffsetCosts,
      );
      expect(offs + r.taxAdvanceOffset + r.net).toBe(gross);
      expect(r.net >= 0n).toBe(true);
      // money left after the defaults means every suspended default was paid in full
      if (r.net + r.taxAdvanceOffset > 0n) {
        for (const o of r.offsets) {
          const dflt = defaults.find(
            (x) => x.memberDefaultId === o.memberDefaultId,
          );
          if (dflt?.suspended) expect(o.paysInFull).toBe(true);
        }
      }
      for (const o of r.offsets) {
        const dflt = defaults.find(
          (x) => x.memberDefaultId === o.memberDefaultId,
        );
        if (!dflt) throw new Error("missing default");
        expect(o.toBalance <= dflt.balance).toBe(true);
        expect(o.toInterest <= dflt.interest).toBe(true);
        expect(o.toCosts <= dflt.costs).toBe(true);
        if (!dflt.suspended) expect(o.toBalance).toBe(0n);
      }
    }
  });
});
