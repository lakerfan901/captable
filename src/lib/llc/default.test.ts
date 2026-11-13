import { describe, expect, it } from "vitest";
import { OA_DEFAULTS as cfg } from "./config";
import {
  allocatePaymentToLines,
  type BalanceReduction,
  callNoticeDueDate,
  computeCreditAllocation,
  computeForfeiture,
  creditDate,
  cureStatus,
  defaultInterest,
  forfeitureDate,
  fullyFundedOn,
  isSuspended,
  outstandingBalance,
  replacementWindow,
  suspendedHolderIds,
  uncalledBalance,
} from "./default";
import { LlcMathError } from "./money";

const $ = (dollars: number) => BigInt(Math.round(dollars * 100));
const u = (units: number) => BigInt(Math.round(units * 1_000_000));

describe("callNoticeDueDate", () => {
  it("CN-1..CN-3", () => {
    expect(callNoticeDueDate("2027-01-14", cfg)).toBe("2027-01-20");
    expect(callNoticeDueDate("2027-03-29", cfg)).toBe("2027-03-31");
    expect(callNoticeDueDate("2027-03-26", cfg)).toBe("2027-03-31");
  });
  it("CN-4 throws after the outside date", () => {
    expect(() => callNoticeDueDate("2027-04-01", cfg)).toThrow(LlcMathError);
    try {
      callNoticeDueDate("2027-04-01", cfg);
    } catch (e) {
      expect((e as LlcMathError).code).toBe("AFTER_OUTSIDE_DATE");
    }
  });
  it("no outside date: plain business days", () => {
    expect(
      callNoticeDueDate("2027-04-01", { ...cfg, balanceOutsideDate: null }),
    ).toBe("2027-04-06");
  });
});

describe("uncalledBalance", () => {
  it("CN-5", () => {
    const base = { acceptedCommitment: $(100_000), initialPaid: $(40_000) };
    expect(uncalledBalance({ ...base, calledTotal: $(30_000) })).toBe(
      $(30_000),
    );
    expect(uncalledBalance({ ...base, calledTotal: $(70_000) })).toBe(0n);
  });
});

describe("allocatePaymentToLines", () => {
  const lines = [
    {
      lineId: "L2",
      dueOn: "2027-02-10",
      outstanding: $(30_000),
      createdSeq: 2,
    },
    {
      lineId: "L1",
      dueOn: "2027-01-20",
      outstanding: $(30_000),
      createdSeq: 1,
    },
  ];
  it("CN-6", () => {
    expect(
      allocatePaymentToLines(
        $(50_000),
        "2027-01-19",
        lines,
        "LATER_OF_RECEIPT_AND_DUE",
      ),
    ).toEqual({
      allocations: [
        { lineId: "L1", amount: $(30_000), prefReturnStartOn: "2027-01-20" },
        { lineId: "L2", amount: $(20_000), prefReturnStartOn: "2027-02-10" },
      ],
      unallocated: 0n,
    });
  });
  it("CN-6r RECEIPT_DATE", () => {
    expect(
      allocatePaymentToLines($(50_000), "2027-01-19", lines, "RECEIPT_DATE"),
    ).toEqual({
      allocations: [
        { lineId: "L1", amount: $(30_000), prefReturnStartOn: "2027-01-19" },
        { lineId: "L2", amount: $(20_000), prefReturnStartOn: "2027-01-19" },
      ],
      unallocated: 0n,
    });
  });
  it("CN-7 late payment with excess", () => {
    expect(
      allocatePaymentToLines(
        $(70_000),
        "2027-01-25",
        [
          {
            lineId: "L1",
            dueOn: "2027-01-20",
            outstanding: $(60_000),
            createdSeq: 1,
          },
        ],
        "LATER_OF_RECEIPT_AND_DUE",
      ),
    ).toEqual({
      allocations: [
        { lineId: "L1", amount: $(60_000), prefReturnStartOn: "2027-01-25" },
      ],
      unallocated: $(10_000),
    });
  });
  it("skips lines without a due date; ties broken by createdSeq", () => {
    const r = allocatePaymentToLines(
      $(10),
      "2027-01-01",
      [
        { lineId: "N", dueOn: null, outstanding: $(5), createdSeq: 0 },
        { lineId: "B", dueOn: "2027-01-20", outstanding: $(5), createdSeq: 2 },
        { lineId: "A", dueOn: "2027-01-20", outstanding: $(3), createdSeq: 1 },
      ],
      "LATER_OF_RECEIPT_AND_DUE",
    );
    expect(r.allocations.map((a) => [a.lineId, a.amount])).toEqual([
      ["A", $(3)],
      ["B", $(5)],
    ]);
    expect(r.unallocated).toBe($(2));
  });
});

describe("default dates", () => {
  it("D-dates", () => {
    expect(forfeitureDate("2027-01-20", cfg)).toBe("2027-01-27");
    expect(replacementWindow("2027-01-20", cfg)).toEqual({
      opensOn: "2027-01-21",
      closesOn: "2027-06-30",
    });
  });
  it("D-dates-2", () => {
    expect(forfeitureDate("2027-03-31", cfg)).toBe("2027-04-07");
  });
  const base = { dueOn: "2027-01-20", forfeitureDate: "2027-01-27" };
  it("CD-1..CD-4", () => {
    expect(creditDate({ ...base, fullyFundedOn: null }, cfg)).toBe(
      "2027-02-19",
    );
    expect(creditDate({ ...base, fullyFundedOn: "2027-02-03" }, cfg)).toBe(
      "2027-02-03",
    );
    expect(creditDate({ ...base, fullyFundedOn: "2027-01-25" }, cfg)).toBe(
      "2027-01-27",
    );
    expect(creditDate({ ...base, fullyFundedOn: "2027-03-15" }, cfg)).toBe(
      "2027-02-19",
    );
  });
});

describe("outstandingBalance / fullyFundedOn", () => {
  const rf: BalanceReduction[] = [
    { on: "2027-02-01", amount: $(15_000), by: "REPLACEMENT_FUNDER" },
    { on: "2027-01-25", amount: $(30_000), by: "REPLACEMENT_FUNDER" },
  ];
  it("outstanding as of a date", () => {
    expect(outstandingBalance($(60_000), rf, "2027-01-24")).toBe($(60_000));
    expect(outstandingBalance($(60_000), rf, "2027-01-25")).toBe($(30_000));
    expect(outstandingBalance($(60_000), rf, "2027-02-19")).toBe($(15_000));
  });
  it("fully funded only when a Replacement Funder reaches zero", () => {
    expect(fullyFundedOn($(60_000), rf)).toBeNull();
    expect(
      fullyFundedOn($(45_000), [
        ...rf,
        { on: "2027-03-01", amount: $(1), by: "MEMBER" },
      ]),
    ).toBe("2027-02-01");
    expect(
      fullyFundedOn($(45_000), [
        { on: "2027-01-25", amount: $(30_000), by: "REPLACEMENT_FUNDER" },
        { on: "2027-01-26", amount: $(15_000), by: "MEMBER" },
      ]),
    ).toBeNull();
  });
});

describe("defaultInterest", () => {
  const i = { unpaidAtDue: $(60_000), dueOn: "2027-01-20" };
  it("I-1", () => {
    expect(
      defaultInterest({ ...i, reductions: [], asOf: "2027-02-09" }, cfg),
    ).toBe($(394.52));
  });
  it("I-2", () => {
    expect(
      defaultInterest({ ...i, reductions: [], asOf: "2027-05-14" }, cfg),
    ).toBe($(2_248.77));
  });
  it("I-3", () => {
    expect(
      defaultInterest(
        {
          ...i,
          reductions: [
            { on: "2027-01-25", amount: $(30_000), by: "REPLACEMENT_FUNDER" },
            { on: "2027-02-01", amount: $(15_000), by: "REPLACEMENT_FUNDER" },
          ],
          asOf: "2027-02-19",
        },
        cfg,
      ),
    ).toBe($(256.44));
  });
  it("I-4 rounded once", () => {
    expect(
      defaultInterest(
        {
          ...i,
          reductions: [{ on: "2027-02-09", amount: $(30_000), by: "MEMBER" }],
          asOf: "2027-05-14",
        },
        cfg,
      ),
    ).toBe($(1_321.64));
  });
  it("I-5", () => {
    expect(
      defaultInterest({ ...i, reductions: [], asOf: "2027-01-20" }, cfg),
    ).toBe(0n);
  });
});

describe("computeForfeiture", () => {
  const rf30: BalanceReduction[] = [
    { on: "2027-01-25", amount: $(30_000), by: "REPLACEMENT_FUNDER" },
  ];
  const pos40 = {
    contributed: $(40_000),
    unreturned: $(40_000),
    unpaidReturn: $(508.49),
    preferredUnits: u(40),
  };
  it("FF-1 cap not binding", () => {
    const r = computeForfeiture(
      {
        unpaidAtDue: $(60_000),
        reductions: rf30,
        forfeitureDate: "2027-01-27",
        position: pos40,
      },
      cfg,
    );
    expect(r).toEqual({
      unpaidAtForfeiture: $(60_000),
      halfOfUnpaid: $(30_000),
      capitalPaid: $(40_000),
      capBinding: false,
      forfeited: $(30_000),
      unreturnedDeducted: $(30_000),
      extinguishedReturn: $(381.37),
      contributedAfter: $(10_000),
      unitsBefore: u(40),
      unitsAfter: u(10),
    });
  });
  it("FF-2 switch on", () => {
    const r = computeForfeiture(
      {
        unpaidAtDue: $(60_000),
        reductions: rf30,
        forfeitureDate: "2027-01-27",
        position: pos40,
      },
      { ...cfg, forfeitureBaseNetOfReplacementFunding: true },
    );
    expect(r.unpaidAtForfeiture).toBe($(30_000));
    expect(r.forfeited).toBe($(15_000));
    expect(r.extinguishedReturn).toBe($(190.68));
    expect(r.unitsAfter).toBe(u(25));
  });
  it("FF-3 cap binding", () => {
    const r = computeForfeiture(
      {
        unpaidAtDue: $(75_000),
        reductions: [],
        forfeitureDate: "2027-01-27",
        position: {
          contributed: $(25_000),
          unreturned: $(25_000),
          unpaidReturn: $(317.81),
          preferredUnits: u(25),
        },
      },
      cfg,
    );
    expect(r.halfOfUnpaid).toBe($(37_500));
    expect(r.capitalPaid).toBe($(25_000));
    expect(r.capBinding).toBe(true);
    expect(r.forfeited).toBe($(25_000));
    expect(r.extinguishedReturn).toBe($(317.81));
    expect(r.unitsAfter).toBe(0n);
  });
  it("FF-4 member paid part before", () => {
    const r = computeForfeiture(
      {
        unpaidAtDue: $(60_000),
        reductions: [{ on: "2027-01-22", amount: $(20_000), by: "MEMBER" }],
        forfeitureDate: "2027-01-27",
        position: {
          contributed: $(60_000),
          unreturned: $(60_000),
          unpaidReturn: 0n,
          preferredUnits: u(60),
        },
      },
      cfg,
    );
    expect(r.unpaidAtForfeiture).toBe($(40_000));
    expect(r.forfeited).toBe($(20_000));
    expect(r.contributedAfter).toBe($(40_000));
  });
  it("member payment after the Forfeiture Date does not reduce the base", () => {
    const r = computeForfeiture(
      {
        unpaidAtDue: $(60_000),
        reductions: [{ on: "2027-01-28", amount: $(20_000), by: "MEMBER" }],
        forfeitureDate: "2027-01-27",
        position: pos40,
      },
      cfg,
    );
    expect(r.unpaidAtForfeiture).toBe($(60_000));
  });
  it("FF-5 capital already returned", () => {
    const r = computeForfeiture(
      {
        unpaidAtDue: $(60_000),
        reductions: [],
        forfeitureDate: "2027-01-27",
        position: {
          contributed: $(40_000),
          unreturned: $(20_000),
          unpaidReturn: $(100),
          preferredUnits: u(40),
        },
      },
      cfg,
    );
    expect(r.forfeited).toBe($(30_000));
    expect(r.unreturnedDeducted).toBe($(20_000));
    expect(r.extinguishedReturn).toBe($(100));
    expect(r.contributedAfter).toBe($(10_000));
  });
});

describe("computeCreditAllocation", () => {
  const holders = [
    { holderId: "A", units: u(100) },
    { holderId: "B", units: u(250) },
    { holderId: "K", units: u(50) },
  ];
  const sum = (cs: { amount: bigint }[]) =>
    cs.reduce((s, c) => s + c.amount, 0n);
  it("CR-1 insider redirect", () => {
    const r = computeCreditAllocation(
      {
        forfeited: $(30_000),
        unpaidAtForfeiture: $(60_000),
        fundings: [
          { holderId: "A", amount: $(30_000), isInsider: false },
          { holderId: "K", amount: $(15_000), isInsider: true },
        ],
        holdersOnDueDate: holders,
      },
      cfg,
    );
    expect(r.fundedCounted).toBe($(45_000));
    expect(r.poolA).toBe($(11_250));
    expect(r.redirected).toBe($(3_750));
    expect(r.poolB).toBe($(22_500));
    expect(r.blocked).toBeNull();
    expect(r.credits).toEqual([
      { holderId: "A", clause: "A", amount: $(7_500), units: u(7.5) },
      { holderId: "A", clause: "B", amount: $(5_625), units: u(5.625) },
      { holderId: "B", clause: "B", amount: $(14_062.5), units: u(14.0625) },
      { holderId: "K", clause: "B", amount: $(2_812.5), units: u(2.8125) },
    ]);
    expect(sum(r.credits)).toBe($(30_000));
  });
  it("CR-2 no funders", () => {
    const r = computeCreditAllocation(
      {
        forfeited: $(30_000),
        unpaidAtForfeiture: $(60_000),
        fundings: [],
        holdersOnDueDate: holders,
      },
      cfg,
    );
    expect(r.poolA).toBe(0n);
    expect(r.poolB).toBe($(30_000));
    expect(r.credits.map((c) => [c.holderId, c.amount])).toEqual([
      ["A", $(7_500)],
      ["B", $(18_750)],
      ["K", $(3_750)],
    ]);
  });
  it("CR-3 new investor funds all", () => {
    const r = computeCreditAllocation(
      {
        forfeited: $(30_000),
        unpaidAtForfeiture: $(60_000),
        fundings: [{ holderId: "N", amount: $(60_000), isInsider: false }],
        holdersOnDueDate: holders,
      },
      cfg,
    );
    expect(r.poolA).toBe($(15_000));
    expect(r.poolB).toBe($(15_000));
    expect(r.credits).toEqual([
      { holderId: "N", clause: "A", amount: $(15_000), units: u(15) },
      { holderId: "A", clause: "B", amount: $(3_750), units: u(3.75) },
      { holderId: "B", clause: "B", amount: $(9_375), units: u(9.375) },
      { holderId: "K", clause: "B", amount: $(1_875), units: u(1.875) },
    ]);
  });
  it("CR-4 odd cents", () => {
    const r = computeCreditAllocation(
      {
        forfeited: 1_234_567n,
        unpaidAtForfeiture: 2_469_134n,
        fundings: [
          { holderId: "A", amount: $(10_000), isInsider: false },
          { holderId: "N", amount: $(5_000), isInsider: false },
        ],
        holdersOnDueDate: holders,
      },
      cfg,
    );
    expect(r.poolA).toBe($(3_750));
    expect(r.poolB).toBe(859_567n);
    expect(r.credits.map((c) => [c.holderId, c.clause, c.amount])).toEqual([
      ["A", "A", $(2_500)],
      ["N", "A", $(1_250)],
      ["A", "B", 214_892n],
      ["B", "B", 537_229n],
      ["K", "B", 107_446n],
    ]);
    expect(sum(r.credits)).toBe(1_234_567n);
  });
  it("CR-5 nobody else", () => {
    const r = computeCreditAllocation(
      {
        forfeited: $(30_000),
        unpaidAtForfeiture: $(60_000),
        fundings: [],
        holdersOnDueDate: [],
      },
      cfg,
    );
    expect(r.blocked).toBe("NO_ELIGIBLE_HOLDERS");
    expect(r.credits).toEqual([]);
  });
});

describe("isSuspended / suspendedHolderIds", () => {
  const d = {
    status: "CURED" as const,
    dueOn: "2027-01-20",
    curedOn: "2027-03-10",
  };
  it("SU-1", () => {
    expect(
      ["2027-01-20", "2027-01-21", "2027-03-09", "2027-03-10"].map((a) =>
        isSuspended(d, a),
      ),
    ).toEqual([false, true, true, false]);
  });
  it("SU-2 voided", () => {
    for (const a of ["2027-01-20", "2027-01-21", "2027-03-09", "2027-03-10"]) {
      expect(isSuspended({ ...d, status: "VOIDED" }, a)).toBe(false);
    }
  });
  it("suspendedHolderIds", () => {
    const ids = suspendedHolderIds(
      [
        {
          stakeholderId: "X",
          status: "OPEN",
          dueOn: "2027-01-20",
          curedOn: null,
        },
        { ...d, stakeholderId: "Y" },
        { ...d, stakeholderId: "Z", status: "VOIDED" },
      ],
      "2027-04-01",
    );
    expect([...ids]).toEqual(["X"]);
  });
});

describe("cureStatus", () => {
  const base = {
    outstandingBalance: 0n,
    interestOwed: 0n,
    costsOwed: 0n,
    lastReductionBy: "MEMBER" as const,
    forfeitureConfirmed: false,
    creditConfirmed: false,
    forfeitureDatePassed: false,
  };
  it("CU-1", () => {
    expect(cureStatus(base)).toEqual({ cured: true, method: "PAID_IN_FULL" });
  });
  it("CU-2", () => {
    expect(
      cureStatus({
        ...base,
        lastReductionBy: "REPLACEMENT_FUNDER",
        forfeitureConfirmed: true,
        forfeitureDatePassed: true,
      }),
    ).toEqual({ cured: false, method: null });
  });
  it("CU-3", () => {
    expect(
      cureStatus({
        ...base,
        interestOwed: $(256.44),
        lastReductionBy: "REPLACEMENT_FUNDER",
        forfeitureConfirmed: true,
        creditConfirmed: true,
        forfeitureDatePassed: true,
      }),
    ).toEqual({ cured: true, method: "REPLACEMENT_FUNDED" });
  });
  it("CU-4", () => {
    expect(cureStatus({ ...base, outstandingBalance: $(15_000) })).toEqual({
      cured: false,
      method: null,
    });
  });
  it("member paid balance but interest owed is not cured", () => {
    expect(cureStatus({ ...base, interestOwed: 1n }).cured).toBe(false);
  });
});
