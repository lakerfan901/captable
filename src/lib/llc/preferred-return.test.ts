import { describe, expect, it } from "vitest";
import { SCENARIO_S_EVENTS } from "./fixtures/scenario-s";
import {
  buildCapitalLots,
  type ReceiptRow,
  resolvePrefReturnStart,
  simpleInterest,
} from "./preferred-return";

const later = {
  rule: "LATER_OF_RECEIPT_AND_DUE" as const,
  balanceOutsideDate: "2027-03-31",
};

describe("resolvePrefReturnStart", () => {
  it("LATER_OF_RECEIPT_AND_DUE", () => {
    expect(
      resolvePrefReturnStart({
        ...later,
        kind: "INITIAL",
        receivedOn: "2026-11-16",
        lineDueOn: null,
      }),
    ).toBe("2026-11-16");
    expect(
      resolvePrefReturnStart({
        ...later,
        kind: "BALANCE",
        receivedOn: "2027-01-11",
        lineDueOn: "2027-01-20",
      }),
    ).toBe("2027-01-20");
    expect(
      resolvePrefReturnStart({
        ...later,
        kind: "BALANCE",
        receivedOn: "2027-01-25",
        lineDueOn: "2027-01-20",
      }),
    ).toBe("2027-01-25");
    expect(
      resolvePrefReturnStart({
        ...later,
        kind: "BALANCE",
        receivedOn: "2026-12-01",
        lineDueOn: null,
      }),
    ).toBe("2027-03-31");
    expect(
      resolvePrefReturnStart({
        ...later,
        kind: "BALANCE",
        receivedOn: "2027-04-05",
        lineDueOn: null,
      }),
    ).toBe("2027-04-05");
    expect(
      resolvePrefReturnStart({
        ...later,
        kind: "CREDIT",
        receivedOn: "2027-02-19",
        lineDueOn: null,
      }),
    ).toBe("2027-02-19");
  });

  it("RECEIPT_DATE", () => {
    expect(
      resolvePrefReturnStart({
        rule: "RECEIPT_DATE",
        balanceOutsideDate: "2027-03-31",
        kind: "BALANCE",
        receivedOn: "2027-01-11",
        lineDueOn: "2027-01-20",
      }),
    ).toBe("2027-01-11");
  });

  it("throws TERMS_INCOMPLETE", () => {
    expect(() =>
      resolvePrefReturnStart({
        rule: "LATER_OF_RECEIPT_AND_DUE",
        balanceOutsideDate: null,
        kind: "BALANCE",
        receivedOn: "2027-01-11",
        lineDueOn: null,
      }),
    ).toThrow(expect.objectContaining({ code: "TERMS_INCOMPLETE" }));
  });
});

describe("simpleInterest", () => {
  it("$100,000 × 90 days at 8% / 365", () => {
    expect(simpleInterest(10_000_000n, 90, 800, 365)).toBe(197_260n);
  });
  it("throws on negative days", () => {
    expect(() => simpleInterest(1n, -1, 800, 365)).toThrow(
      expect.objectContaining({ code: "NEGATIVE_DAYS" }),
    );
  });
});

describe("buildCapitalLots", () => {
  const receipt: ReceiptRow = {
    receiptId: "r",
    holderId: "A",
    kind: "BALANCE",
    on: "2026-12-01",
    receivedOn: "2026-12-01",
    amount: 6_000_000n,
    units: 60_000_000n,
    prefReturnStartOn: "2027-03-31",
    seq: 1,
  };

  it("splits allocated and unallocated parts", () => {
    const lots = buildCapitalLots(
      [receipt],
      [{ receiptId: "r", amount: 2_000_000n, prefReturnStartOn: "2027-01-20" }],
    );
    expect(lots).toEqual([
      {
        kind: "CONTRIBUTION",
        on: "2026-12-01",
        seq: 1,
        holderId: "A",
        lotId: "r:0",
        amount: 2_000_000n,
        units: 20_000_000n,
        accrualStartOn: "2027-01-20",
      },
      {
        kind: "CONTRIBUTION",
        on: "2026-12-01",
        seq: 1,
        holderId: "A",
        lotId: "r:rest",
        amount: 4_000_000n,
        units: 40_000_000n,
        accrualStartOn: "2027-03-31",
      },
    ]);
  });

  it("throws OVER_ALLOCATED", () => {
    expect(() =>
      buildCapitalLots(
        [receipt],
        [
          {
            receiptId: "r",
            amount: 4_000_000n,
            prefReturnStartOn: "2027-01-20",
          },
          {
            receiptId: "r",
            amount: 3_000_000n,
            prefReturnStartOn: "2027-02-20",
          },
        ],
      ),
    ).toThrow(expect.objectContaining({ code: "OVER_ALLOCATED" }));
  });

  it("builds Scenario S lots", () => {
    expect(SCENARIO_S_EVENTS.map((e) => [e.lotId, e.accrualStartOn])).toEqual([
      ["a1:rest", "2026-11-16"],
      ["b1:rest", "2026-11-23"],
      ["c1:rest", "2026-11-30"],
      ["c2:0", "2027-01-20"],
    ]);
  });
});
