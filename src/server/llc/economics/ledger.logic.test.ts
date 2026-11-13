import { describe, expect, it } from "vitest";
import {
  SCENARIO_S_CONFIG,
  SCENARIO_S_RECEIPTS,
} from "../../../lib/llc/fixtures/scenario-s";
import { computePositions } from "../../../lib/llc/positions";
import {
  assignSeq,
  buildLedgerEvents,
  buildWaterfallHolders,
  findLedgerMismatches,
  type LedgerReceipt,
  netAllocations,
  type RawLedgerItem,
  receiptsToEvents,
} from "./ledger.logic";

const U = 1_000_000n;
const cfg = SCENARIO_S_CONFIG;

let clock = Date.UTC(2026, 10, 1);
function receipt(
  r: Partial<LedgerReceipt> &
    Pick<LedgerReceipt, "id" | "stakeholderId" | "receivedOn" | "appliedCents">,
): LedgerReceipt {
  clock += 60_000;
  return {
    kind: "INITIAL",
    appliedOn: r.receivedOn,
    unitsIssued: (r.appliedCents * U) / 100_000n,
    prefReturnStartDate: r.receivedOn,
    createdAt: new Date(clock),
    ...r,
  };
}

describe("assignSeq", () => {
  it("orders ordinary receipt < distribution < its offset receipt on the same day", () => {
    const on = "2027-05-14";
    const distribution: RawLedgerItem = {
      type: "DISTRIBUTION",
      id: "dist-1",
      on,
      createdAt: new Date("2027-05-14T10:00:00Z"),
      number: 1,
      lines: [{ holderId: "A", tierC: 0n, tierD: 0n }],
    };
    const raw: RawLedgerItem[] = [
      // offset receipt, created when the distribution was finalized
      ...receiptsToEvents(
        [
          receipt({
            id: "offset",
            stakeholderId: "D",
            kind: "BALANCE",
            receivedOn: on,
            appliedCents: 500_000n,
            createdAt: new Date("2027-05-14T10:00:01Z"),
          }),
        ],
        new Map([["offset", "dist-1"]]),
      ),
      distribution,
      // ordinary receipt recorded later in the day, dated the same day
      ...receiptsToEvents([
        receipt({
          id: "ordinary",
          stakeholderId: "B",
          receivedOn: on,
          appliedCents: 1_000_000n,
          createdAt: new Date("2027-05-14T18:00:00Z"),
        }),
      ]),
    ];
    const ordered = assignSeq(raw);
    expect(ordered.map((i) => [i.id, i.seq])).toEqual([
      ["ordinary", 0],
      ["dist-1", 1],
      ["offset", 2],
    ]);
  });

  it("orders by date, then createdAt, then id, and distributions by number", () => {
    const at = new Date("2027-01-01T00:00:00Z");
    const raw: RawLedgerItem[] = [
      {
        type: "DISTRIBUTION",
        id: "d2",
        on: "2027-02-01",
        createdAt: at,
        number: 2,
        lines: [],
      },
      {
        type: "DISTRIBUTION",
        id: "d1",
        on: "2027-02-01",
        createdAt: new Date("2027-03-01T00:00:00Z"),
        number: 1,
        lines: [],
      },
      {
        type: "TRANSFER",
        id: "t",
        on: "2027-02-01",
        createdAt: at,
        fromHolderId: "A",
        toHolderId: "N",
        units: U,
      },
      {
        type: "FORFEITURE",
        id: "f",
        on: "2027-02-01",
        createdAt: at,
        holderId: "C",
        amount: 1n,
        units: 1n,
      },
      {
        type: "FORFEITURE",
        id: "early",
        on: "2027-01-31",
        createdAt: new Date("2027-06-01T00:00:00Z"),
        holderId: "C",
        amount: 1n,
        units: 1n,
      },
    ];
    expect(assignSeq(raw).map((i) => i.id)).toEqual([
      "early",
      "f",
      "t",
      "d1",
      "d2",
    ]);
  });
});

describe("receiptsToEvents + buildLedgerEvents", () => {
  it("Scenario S rows produce the S-0 positions", () => {
    const rows = SCENARIO_S_RECEIPTS.map((r) =>
      receipt({
        id: r.receiptId,
        stakeholderId: r.holderId,
        kind: r.kind,
        receivedOn: r.receivedOn,
        appliedOn: r.on,
        appliedCents: r.amount,
        unitsIssued: r.units,
        // c2: FOUNDATION's prepaid start; the allocation fixes the real start
        prefReturnStartDate: r.kind === "BALANCE" ? "2027-03-31" : r.receivedOn,
      }),
    );
    const allocations = netAllocations([
      {
        capitalReceiptId: "c2",
        amountCents: 6_000_000n,
        prefReturnStartOn: "2027-01-20",
      },
      // an allocation and its reversal net to nothing
      {
        capitalReceiptId: "c2",
        amountCents: 1_000_000n,
        prefReturnStartOn: "2027-02-01",
      },
      {
        capitalReceiptId: "c2",
        amountCents: -1_000_000n,
        prefReturnStartOn: "2027-02-01",
      },
    ]);
    const events = buildLedgerEvents(receiptsToEvents(rows), allocations);
    const p = computePositions(events, "2027-05-14", cfg);
    expect(p.holders.get("A")?.unpaidReturn).toBe(392_329n);
    expect(p.holders.get("B")?.unpaidReturn).toBe(942_466n);
    expect(p.holders.get("C")?.unpaidReturn).toBe(294_575n);
    expect(p.totals.unpaidReturn).toBe(1_629_370n);
    expect(p.holders.get("A")?.preferredUnits).toBe(100n * U);
    expect(p.holders.get("B")?.preferredUnits).toBe(250n * U);
    expect(p.holders.get("C")?.preferredUnits).toBe(100n * U);
    expect(p.totals.unreturned).toBe(45_000_000n);
  });

  it("maps a FORFEITURE receipt to the F-1 event", () => {
    const rows = [
      receipt({
        id: "a1",
        stakeholderId: "A",
        receivedOn: "2026-11-16",
        appliedCents: 10_000_000n,
      }),
      receipt({
        id: "b1",
        stakeholderId: "B",
        receivedOn: "2026-11-23",
        appliedCents: 25_000_000n,
      }),
      receipt({
        id: "c1",
        stakeholderId: "C",
        receivedOn: "2026-11-30",
        appliedCents: 4_000_000n,
      }),
      receipt({
        id: "cf",
        stakeholderId: "C",
        kind: "FORFEITURE",
        receivedOn: "2027-01-27",
        appliedCents: -3_000_000n,
        unitsIssued: -30n * U,
        prefReturnStartDate: null,
      }),
    ];
    const raw = receiptsToEvents(rows);
    expect(raw.find((i) => i.id === "cf")).toMatchObject({
      type: "FORFEITURE",
      on: "2027-01-27",
      holderId: "C",
      amount: 3_000_000n,
      units: 30n * U,
    });
    const events = buildLedgerEvents(raw, []);
    expect(events.find((e) => e.kind === "FORFEITURE")).toEqual({
      kind: "FORFEITURE",
      on: "2027-01-27",
      seq: 3,
      holderId: "C",
      amount: 3_000_000n,
      units: 30n * U,
    });
    const p = computePositions(events, "2027-01-27", cfg);
    const c = p.holders.get("C");
    expect(c?.accruedReturn).toBe(50_849n);
    expect(c?.returnExtinguished).toBe(38_137n);
    expect(c?.unpaidReturn).toBe(12_712n);
    expect(c?.contributed).toBe(1_000_000n);
    expect(c?.unreturned).toBe(1_000_000n);
    expect(c?.preferredUnits).toBe(10n * U);
    expect(p.holders.get("A")?.unpaidReturn).toBe(157_808n);
    expect(p.holders.get("B")?.unpaidReturn).toBe(356_164n);
  });

  it("reproduces PR-10 (money wired before acceptance)", () => {
    const rows = [
      receipt({
        id: "w1",
        stakeholderId: "A",
        receivedOn: "2026-11-12",
        appliedOn: "2026-11-13",
        appliedCents: 10_000_000n,
        prefReturnStartDate: "2026-11-12",
      }),
    ];
    const events = buildLedgerEvents(receiptsToEvents(rows), []);
    expect(events).toEqual([
      expect.objectContaining({
        kind: "CONTRIBUTION",
        on: "2026-11-13",
        accrualStartOn: "2026-11-12",
        amount: 10_000_000n,
      }),
    ]);
    expect(computePositions(events, "2026-11-12", cfg).holders.has("A")).toBe(
      false,
    );
    expect(
      computePositions(events, "2026-11-16", cfg).holders.get("A")
        ?.accruedReturn,
    ).toBe(8_767n);
  });

  it("skips unapplied rows", () => {
    const rows = [
      receipt({
        id: "held",
        stakeholderId: "A",
        receivedOn: "2026-11-12",
        appliedCents: 0n,
        unitsIssued: 0n,
      }),
      receipt({
        id: "zero-forfeit",
        stakeholderId: "A",
        kind: "FORFEITURE",
        receivedOn: "2026-11-12",
        appliedCents: 0n,
        unitsIssued: 0n,
      }),
    ];
    expect(receiptsToEvents(rows)).toEqual([]);
  });
});

describe("netAllocations", () => {
  it("nets reversals per (receipt, start) and drops zero nets", () => {
    expect(
      netAllocations([
        {
          capitalReceiptId: "r2",
          amountCents: 5n,
          prefReturnStartOn: "2027-01-20",
        },
        {
          capitalReceiptId: "r1",
          amountCents: 7n,
          prefReturnStartOn: "2027-02-01",
        },
        {
          capitalReceiptId: "r1",
          amountCents: 3n,
          prefReturnStartOn: "2027-01-20",
        },
        {
          capitalReceiptId: "r1",
          amountCents: -3n,
          prefReturnStartOn: "2027-01-20",
        },
        {
          capitalReceiptId: "r2",
          amountCents: 2n,
          prefReturnStartOn: "2027-01-20",
        },
      ]),
    ).toEqual([
      { receiptId: "r1", amount: 7n, prefReturnStartOn: "2027-02-01" },
      { receiptId: "r2", amount: 7n, prefReturnStartOn: "2027-01-20" },
    ]);
  });
});

describe("findLedgerMismatches", () => {
  const events = buildLedgerEvents(
    receiptsToEvents([
      receipt({
        id: "x",
        stakeholderId: "A",
        receivedOn: "2026-11-16",
        appliedCents: 25_000_000n,
      }),
    ]),
    [],
  );
  const p = computePositions(events, "2026-12-01", cfg);

  it("passes when units and capital agree, with zero rows on the other side", () => {
    expect(
      findLedgerMismatches(p, [
        { stakeholderId: "A", units: 250n * U, capitalCents: 25_000_000n },
        // accepted Replacement commitment, no receipts yet
        { stakeholderId: "R", units: 0n, capitalCents: 0n },
      ]),
    ).toEqual([]);
  });

  it("reports a difference in units or capital, or a missing holder", () => {
    expect(
      findLedgerMismatches(p, [
        { stakeholderId: "A", units: 250n * U, capitalCents: 24_999_999n },
      ]),
    ).toEqual(["A"]);
    expect(findLedgerMismatches(p, [])).toEqual(["A"]);
    expect(
      findLedgerMismatches(p, [
        { stakeholderId: "A", units: 250n * U, capitalCents: 25_000_000n },
        { stakeholderId: "B", units: U, capitalCents: 0n },
      ]),
    ).toEqual(["B"]);
  });
});

describe("buildWaterfallHolders", () => {
  it("has one row per holder with Preferred or Common Units", () => {
    const events = buildLedgerEvents(
      receiptsToEvents([
        receipt({
          id: "a1",
          stakeholderId: "A",
          receivedOn: "2026-11-16",
          appliedCents: 10_000_000n,
        }),
      ]),
      [],
    );
    const p = computePositions(events, "2026-12-31", cfg);
    expect(
      buildWaterfallHolders(
        p,
        new Map([
          ["M", 100n * U],
          ["Z", 0n],
        ]),
      ),
    ).toEqual([
      {
        holderId: "A",
        unpaidReturn: 98_630n,
        unreturned: 10_000_000n,
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
    ]);
  });
});
