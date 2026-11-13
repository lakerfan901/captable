import { describe, expect, it } from "vitest";
import { OA_DEFAULTS } from "./config";
import { SCENARIO_S_CONFIG, SCENARIO_S_EVENTS } from "./fixtures/scenario-s";
import {
  type ContributionEvent,
  computePositions,
  type DistributionEvent,
  type LedgerEvent,
} from "./positions";

const cfg = OA_DEFAULTS;
const U = 1_000_000n;

/** dollars → cents; units at $1,000 per unit = cents × 10 micro-units. */
function c(
  holderId: string,
  lotId: string,
  on: string,
  dollars: number,
  seq: number,
  accrualStartOn = on,
): ContributionEvent {
  const amount = BigInt(dollars) * 100n;
  return {
    kind: "CONTRIBUTION",
    on,
    seq,
    holderId,
    lotId,
    amount,
    units: amount * 10n,
    accrualStartOn,
  };
}

function dist(
  on: string,
  seq: number,
  lines: { holderId: string; tierC?: bigint; tierD?: bigint }[],
): DistributionEvent {
  return {
    kind: "DISTRIBUTION",
    on,
    seq,
    distributionId: `d${seq}`,
    lines: lines.map((l) => ({
      holderId: l.holderId,
      tierC: l.tierC ?? 0n,
      tierD: l.tierD ?? 0n,
    })),
  };
}

function pos(events: LedgerEvent[], asOf: string, holder: string, opts = {}) {
  const h = computePositions(events, asOf, cfg, opts).holders.get(holder);
  if (!h) throw new Error(`missing ${holder}`);
  return h;
}

describe("computePositions — Preferred Return", () => {
  const a = [c("A", "a1", "2026-11-16", 100_000, 1)];

  it("PR-1", () => {
    expect(pos(a, "2026-11-16", "A").accruedReturn).toBe(0n);
    expect(pos(a, "2026-12-31", "A").accruedReturn).toBe(98_630n);
    expect(pos(a, "2027-02-14", "A").accruedReturn).toBe(197_260n);
    expect(pos(a, "2027-11-16", "A").accruedReturn).toBe(800_000n);
  });

  it("PR-2 (leap year)", () => {
    const b = [c("B", "b1", "2027-12-31", 250_000, 1)];
    expect(pos(b, "2028-02-29", "B").accruedReturn).toBe(328_767n);
    expect(pos(b, "2028-12-31", "B").accruedReturn).toBe(2_005_479n);
  });

  const pr3 = [
    c("A", "a1", "2026-11-16", 40_000, 1),
    c("A", "a2", "2027-01-11", 60_000, 2, "2027-01-20"),
  ];

  it("PR-3a", () => {
    const h = pos(pr3, "2027-05-14", "A");
    expect(h.accruedReturn).toBe(306_849n);
    expect(h.unreturned).toBe(10_000_000n);
  });

  it("PR-3b / PR-3c", () => {
    const ev = [
      ...pr3,
      dist("2027-05-14", 3, [{ holderId: "A", tierD: 2_500_000n }]),
    ];
    const h = pos(ev, "2027-05-14", "A");
    expect(h.unreturned).toBe(7_500_000n);
    expect(h.capitalReturned).toBe(2_500_000n);
    expect(h.lots.map((l) => [l.lotId, l.outstanding])).toEqual([
      ["a1", 3_000_000n],
      ["a2", 4_500_000n],
    ]);
    expect(h.accruedReturn).toBe(306_849n);
    expect(h.preferredUnits).toBe(100n * U);
    expect(pos(ev, "2027-08-13", "A").accruedReturn).toBe(456_438n);
  });

  const pr4 = [
    c("A", "a1", "2026-11-16", 100_000, 1),
    dist("2027-02-12", 5, [{ holderId: "A", tierC: 100_000n }]),
  ];

  it("PR-4", () => {
    const h = pos(pr4, "2027-02-12", "A");
    expect(h.accruedReturn).toBe(192_877n);
    expect(h.returnPaid).toBe(100_000n);
    expect(h.unpaidReturn).toBe(92_877n);
    const later = pos(pr4, "2027-05-14", "A");
    expect(later.accruedReturn).toBe(392_329n);
    expect(later.unpaidReturn).toBe(292_329n);
  });

  it("PR-5 (prepaid Balance)", () => {
    const ev = [
      c("A", "a1", "2026-11-16", 40_000, 1),
      c("A", "a2", "2026-12-01", 60_000, 2, "2027-03-31"),
    ];
    const h = pos(ev, "2027-03-31", "A");
    expect(h.accruedReturn).toBe(118_356n);
    expect(h.unreturned).toBe(10_000_000n);
    expect(h.preferredUnits).toBe(100n * U);
    expect(pos(ev, "2027-06-30", "A").accruedReturn).toBe(317_808n);
  });

  it("PR-6 OVERPAID_RETURN", () => {
    const ev = [
      c("A", "a1", "2026-11-16", 100_000, 1),
      dist("2027-02-12", 2, [{ holderId: "A", tierC: 192_878n }]),
    ];
    expect(() => computePositions(ev, "2027-02-12", cfg)).toThrow(
      expect.objectContaining({ code: "OVERPAID_RETURN" }),
    );
  });

  it("PR-7 OVER_RETURNED", () => {
    const ev = [
      c("A", "a1", "2026-11-16", 100_000, 1),
      dist("2027-02-12", 2, [{ holderId: "A", tierD: 10_000_001n }]),
    ];
    expect(() => computePositions(ev, "2027-02-12", cfg)).toThrow(
      expect.objectContaining({ code: "OVER_RETURNED" }),
    );
  });

  it("PR-8 untilSeq", () => {
    const h = pos(pr4, "2027-02-12", "A", { untilSeq: 5 });
    expect(h.unpaidReturn).toBe(192_877n);
    expect(h.returnPaid).toBe(0n);
  });

  it("PR-9 accrual pause", () => {
    const h = pos(a, "2027-02-14", "A", {
      accrualPauses: [{ holderId: "A", from: "2027-01-20", to: "2027-02-09" }],
    });
    expect(h.accruedReturn).toBe(153_425n);
  });

  it("PR-10 wired before acceptance", () => {
    const ev = [c("A", "a1", "2026-11-13", 100_000, 1, "2026-11-12")];
    expect(computePositions(ev, "2026-11-12", cfg).holders.has("A")).toBe(
      false,
    );
    expect(pos(ev, "2026-11-16", "A").accruedReturn).toBe(8_767n);
  });

  it("DUPLICATE_SEQ", () => {
    const ev = [
      c("A", "a1", "2026-11-16", 100, 1),
      c("B", "b1", "2026-11-16", 100, 1),
    ];
    expect(() => computePositions(ev, "2026-11-16", cfg)).toThrow(
      expect.objectContaining({ code: "DUPLICATE_SEQ" }),
    );
  });

  it("FIFO lot order", () => {
    const ev = [
      ...pr3,
      dist("2027-05-14", 3, [{ holderId: "A", tierD: 5_000_000n }]),
    ];
    const r = computePositions(ev, "2027-05-14", {
      ...cfg,
      capitalReturnLotOrder: "FIFO",
    });
    expect(r.holders.get("A")?.lots.map((l) => l.outstanding)).toEqual([
      0n,
      5_000_000n,
    ]);
  });
});

describe("computePositions — Scenario S", () => {
  it("S-0", () => {
    const r = computePositions(
      SCENARIO_S_EVENTS,
      "2027-05-14",
      SCENARIO_S_CONFIG,
    );
    const get = (id: string) => r.holders.get(id);
    expect(get("A")?.accruedReturn).toBe(392_329n);
    expect(get("B")?.accruedReturn).toBe(942_466n);
    expect(get("C")?.accruedReturn).toBe(294_575n);
    expect(r.totals.unpaidReturn).toBe(1_629_370n);
    expect(get("A")?.preferredUnits).toBe(100n * U);
    expect(get("B")?.preferredUnits).toBe(250n * U);
    expect(get("C")?.preferredUnits).toBe(100n * U);
    expect(r.totals.unreturned).toBe(45_000_000n);
    expect(r.holders.has("M")).toBe(false);
  });

  it("is deterministic under shuffled input", () => {
    const ev: LedgerEvent[] = [
      ...SCENARIO_S_EVENTS,
      dist("2027-05-14", 10, [
        { holderId: "A", tierC: 100_000n, tierD: 1_000_000n },
        { holderId: "C", tierD: 2_000_000n },
      ]),
    ];
    const perm = [4, 2, 0, 3, 1];
    const shuffled = perm.map((i) => ev[i] as LedgerEvent);
    const a = computePositions(ev, "2027-08-13", SCENARIO_S_CONFIG);
    const b = computePositions(shuffled, "2027-08-13", SCENARIO_S_CONFIG);
    expect(b).toEqual(a);
  });
});

describe("computePositions — forfeiture", () => {
  it("F-1", () => {
    const ev: LedgerEvent[] = [
      c("A", "a1", "2026-11-16", 100_000, 1),
      c("B", "b1", "2026-11-23", 250_000, 2),
      c("C", "c1", "2026-11-30", 40_000, 3),
      {
        kind: "FORFEITURE",
        on: "2027-01-27",
        seq: 4,
        holderId: "C",
        amount: 3_000_000n,
        units: 30n * U,
      },
    ];
    const r = computePositions(ev, "2027-01-27", cfg);
    const cc = r.holders.get("C");
    expect(cc?.accruedReturn).toBe(50_849n);
    expect(cc?.returnExtinguished).toBe(38_137n);
    expect(cc?.unpaidReturn).toBe(12_712n);
    expect(cc?.contributed).toBe(1_000_000n);
    expect(cc?.unreturned).toBe(1_000_000n);
    expect(cc?.forfeited).toBe(3_000_000n);
    expect(cc?.preferredUnits).toBe(10n * U);
    expect(r.forfeitures).toEqual([
      {
        holderId: "C",
        on: "2027-01-27",
        amount: 3_000_000n,
        unreturnedDeducted: 3_000_000n,
        extinguishedReturn: 38_137n,
        unitsBefore: 40n * U,
        unitsAfter: 10n * U,
      },
    ]);
    expect(r.holders.get("A")?.unpaidReturn).toBe(157_808n);
    expect(r.holders.get("B")?.unpaidReturn).toBe(356_164n);
  });

  it("F-2 cap case", () => {
    const ev: LedgerEvent[] = [
      c("D", "d1", "2026-11-30", 25_000, 1),
      {
        kind: "FORFEITURE",
        on: "2027-01-27",
        seq: 2,
        holderId: "D",
        amount: 2_500_000n,
        units: 25n * U,
      },
    ];
    const d = pos(ev, "2027-01-27", "D");
    expect(d.contributed).toBe(0n);
    expect(d.unreturned).toBe(0n);
    expect(d.preferredUnits).toBe(0n);
    expect(d.accruedReturn).toBe(31_781n);
    expect(d.returnExtinguished).toBe(31_781n);
    expect(d.unpaidReturn).toBe(0n);
  });

  it("FORFEIT_EXCEEDS_UNITS / FORFEIT_EXCEEDS_CAPITAL", () => {
    const base = c("D", "d1", "2026-11-30", 25_000, 1);
    const f = (amount: bigint, units: bigint): LedgerEvent => ({
      kind: "FORFEITURE",
      on: "2027-01-27",
      seq: 2,
      holderId: "D",
      amount,
      units,
    });
    expect(() =>
      computePositions([base, f(2_500_001n, 1n)], "2027-01-27", cfg),
    ).toThrow(expect.objectContaining({ code: "FORFEIT_EXCEEDS_CAPITAL" }));
    expect(() =>
      computePositions([base, f(1n, 26n * U)], "2027-01-27", cfg),
    ).toThrow(expect.objectContaining({ code: "FORFEIT_EXCEEDS_UNITS" }));
  });
});

describe("computePositions — transfer", () => {
  const ev: LedgerEvent[] = [
    c("A", "a1", "2026-11-16", 100_000, 1),
    {
      kind: "TRANSFER",
      on: "2027-06-01",
      seq: 2,
      fromHolderId: "A",
      toHolderId: "N",
      units: 40n * U,
    },
  ];

  it("T-1", () => {
    const before = pos(ev, "2027-06-01", "A", { untilSeq: 2 });
    expect(before.unpaidReturn).toBe(431_781n);
    const r = computePositions(ev, "2027-06-01", cfg);
    const A = r.holders.get("A");
    const N = r.holders.get("N");
    expect(A?.returnCarriedOut).toBe(172_712n);
    expect(N?.returnCarriedIn).toBe(172_712n);
    expect(A?.contributed).toBe(6_000_000n);
    expect(A?.unreturned).toBe(6_000_000n);
    expect(A?.preferredUnits).toBe(60n * U);
    expect(A?.unpaidReturn).toBe(259_069n);
    expect(N?.contributed).toBe(4_000_000n);
    expect(N?.unreturned).toBe(4_000_000n);
    expect(N?.preferredUnits).toBe(40n * U);
    expect(N?.unpaidReturn).toBe(172_712n);
    expect(N?.lots.map((l) => l.lotId)).toEqual(["a1>N@2027-06-01"]);
  });

  it("T-2", () => {
    const r = computePositions(ev, "2027-08-13", cfg);
    const A = r.holders.get("A");
    const N = r.holders.get("N");
    expect(A?.accruedReturn).toBe(527_781n);
    expect(A?.unpaidReturn).toBe(355_069n);
    expect(N?.accruedReturn).toBe(64_000n);
    expect(N?.unpaidReturn).toBe(236_712n);
    expect((A?.unpaidReturn ?? 0n) + (N?.unpaidReturn ?? 0n)).toBe(591_781n);
    expect(pos([ev[0] as LedgerEvent], "2027-08-13", "A").accruedReturn).toBe(
      591_781n,
    );
  });

  it("TRANSFER_EXCEEDS_UNITS", () => {
    const bad: LedgerEvent[] = [
      ev[0] as LedgerEvent,
      {
        kind: "TRANSFER",
        on: "2027-06-01",
        seq: 2,
        fromHolderId: "A",
        toHolderId: "N",
        units: 101n * U,
      },
    ];
    expect(() => computePositions(bad, "2027-06-01", cfg)).toThrow(
      expect.objectContaining({ code: "TRANSFER_EXCEEDS_UNITS" }),
    );
  });
});
