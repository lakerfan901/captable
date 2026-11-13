import { describe, expect, it } from "vitest";
import {
  type OfferingTerms,
  validateAcceptance,
} from "../../../lib/admission/commitment-rules";
import { OA_DEFAULTS } from "../../../lib/llc/config";
import {
  type BalanceReduction,
  computeCreditAllocation,
  computeForfeiture,
  forfeitureDate,
  fullyFundedOn,
  isSuspended,
  replacementWindow,
} from "../../../lib/llc/default";
import { LlcMathError } from "../../../lib/llc/money";
import {
  computePositions,
  type ForfeitureEvent,
  type LedgerEvent,
} from "../../../lib/llc/positions";
import {
  buildCapitalLots,
  type ReceiptRow,
} from "../../../lib/llc/preferred-return";
import { forfeitureUnits, validateSpecialReceipt } from "../receipt-rules";
import {
  blockingDefaultSteps,
  buildReductions,
  type DefaultAllocationRow,
  type DefaultEvaluationInput,
  type DefaultFundingRow,
  declarationErrors,
  defaultStage,
  evaluateDefault,
  fundingErrors,
  lastReductionBy,
  livePayments,
  netAllocationRows,
  type OtherDefault,
  orderReductions,
  pendingDefaultSteps,
  planCreditTargets,
  planDefaultPayment,
} from "./defaults.logic";

const cfg = OA_DEFAULTS;
const $ = (dollars: number) => BigInt(Math.round(dollars * 100));
const u = (units: number) => BigInt(Math.round(units * 1_000_000));

// ---------------------------------------------------------------------------
// Worked case (02-economics.md E11): Scenario S, but C never pays its $60,000
// call (sent 2027-01-14, due 2027-01-20); A funds $30,000 on 2027-01-25; K
// (insider, 50 units since 2026-11-20) funds $15,000 on 2027-02-01.

const DUE = "2027-01-20";
const FD = "2027-01-27";

const fundingA: DefaultFundingRow = {
  id: "fA",
  funderStakeholderId: "A",
  funderCommitmentId: "cmtA-R",
  funderIsInsider: false,
  amount: $(30_000),
  fundedOn: "2027-01-25",
};
const fundingK: DefaultFundingRow = {
  id: "fK",
  funderStakeholderId: "K",
  funderCommitmentId: "cmtK-R",
  funderIsInsider: true,
  amount: $(15_000),
  fundedOn: "2027-02-01",
};

function receipt(
  receiptId: string,
  holderId: string,
  kind: ReceiptRow["kind"],
  on: string,
  amount: bigint,
  seq: number,
): ReceiptRow {
  return {
    receiptId,
    holderId,
    kind,
    on,
    receivedOn: on,
    amount,
    units: amount * 10n, // $1,000 per unit: 1 cent = 10 micro-units
    prefReturnStartOn: on,
    seq,
  };
}

/** Capital before the default: S without c2, plus K. */
const BASE_RECEIPTS: ReceiptRow[] = [
  receipt("a1", "A", "INITIAL", "2026-11-16", $(100_000), 1),
  receipt("k1", "K", "INITIAL", "2026-11-20", $(50_000), 2),
  receipt("b1", "B", "INITIAL", "2026-11-23", $(250_000), 3),
  receipt("c1", "C", "INITIAL", "2026-11-30", $(40_000), 4),
  receipt("aR", "A", "REPLACEMENT", "2027-01-25", $(30_000), 5),
  receipt("kR", "K", "REPLACEMENT", "2027-02-01", $(15_000), 7),
];

function input(
  over: Partial<DefaultEvaluationInput> = {},
): DefaultEvaluationInput {
  return {
    status: "OPEN",
    dueOn: DUE,
    forfeitureDate: FD,
    amountCalled: $(60_000),
    allocations: [],
    fundings: [fundingA, fundingK],
    payments: [],
    charges: [],
    forfeiture: null,
    credit: null,
    cure: null,
    today: "2027-02-19",
    asOf: "2027-02-19",
    ...over,
  };
}

describe("E11 worked case (ends at 485 units)", () => {
  it("declared 2027-01-21: unpaid at due, Forfeiture Date, window, suspension", () => {
    const ev = evaluateDefault(
      input({ fundings: [], today: "2027-01-21", asOf: "2027-01-21" }),
      cfg,
    );
    expect(ev.unpaidAtDue).toBe($(60_000));
    expect(forfeitureDate(DUE, cfg)).toBe(FD);
    expect(replacementWindow(DUE, cfg)).toEqual({
      opensOn: "2027-01-21",
      closesOn: "2027-06-30",
    });
    expect(ev.suspended).toBe(true);
    expect(
      isSuspended({ status: "OPEN", dueOn: DUE, curedOn: null }, DUE),
    ).toBe(false);
    expect(ev.forfeiture.available).toBe(false);
    expect(ev.cure.cured).toBe(false);
    expect(
      declarationErrors({
        lineStatus: "SENT",
        dueOn: DUE,
        today: "2027-01-21",
        hasDefault: false,
        outstanding: ev.outstanding,
      }),
    ).toEqual([]);
  });

  it("runs end to end through forfeiture, credit and the final units", () => {
    // Funding A (2027-01-25) passes FOUNDATION's acceptance rules as a
    // Replacement commitment after the Final Closing with nothing held.
    const terms: OfferingTerms = {
      minCommitmentCents: $(25_000),
      minCommitmentFloorCents: $(10_000),
      offeringCapCents: $(2_000_000),
      initialInstallmentBps: 4000,
      finalClosingDate: "2026-11-30",
      balanceOutsideDate: "2027-03-31",
      acceptanceBusinessDays: 10,
      refundBusinessDays: 5,
      prefReturnBps: 800,
      balanceReturnStartRule: "LATER_OF_RECEIPT_AND_DUE",
    };
    for (const f of [fundingA, fundingK]) {
      expect(
        validateAcceptance({
          terms,
          committedCents: f.amount,
          acceptedCents: f.amount,
          acceptedOn: f.fundedOn,
          signedOn: f.fundedOn,
          today: f.fundedOn,
          heldCents: 0n,
          keepCents: 0n,
          otherAcceptedCents: $(440_000), // after the defaulter was reduced first
          minimumWaived: false,
          isReplacement: true,
          skipClosingDateCheck: true,
        }),
      ).toEqual([]);
      expect(
        validateSpecialReceipt({
          kind: "REPLACEMENT",
          status: "ACCEPTED",
          isReplacement: true,
          amountCents: f.amount,
          appliedCents: f.amount,
          acceptedCents: f.amount,
          cashAppliedCents: 0n,
          receivedOn: f.fundedOn,
          today: f.fundedOn,
          memberCapitalCents: 0n,
        }),
      ).toEqual([]);
    }

    // Forfeiture, confirmed on 2027-01-28 (effective 2027-01-27): FF-1.
    const before = input({
      fundings: [fundingA],
      today: "2027-01-28",
      asOf: "2027-01-28",
    });
    const evAtFd = evaluateDefault(before, cfg);
    expect(evAtFd.forfeiture.available).toBe(true);
    expect(
      evaluateDefault({ ...before, today: FD, asOf: FD }, cfg).forfeiture
        .available,
    ).toBe(false);
    const baseEvents: LedgerEvent[] = buildCapitalLots(BASE_RECEIPTS, []);
    const atFd = computePositions(baseEvents, FD, cfg);
    const c = atFd.holders.get("C");
    expect(c).toBeDefined();
    if (!c) return;
    expect(c.unpaidReturn).toBe($(508.49));
    const ff = computeForfeiture(
      {
        unpaidAtDue: evAtFd.unpaidAtDue,
        reductions: evAtFd.reductions,
        forfeitureDate: FD,
        position: c,
      },
      cfg,
    );
    expect(ff.unpaidAtForfeiture).toBe($(60_000)); // RF funding not deducted
    expect(ff.forfeited).toBe($(30_000));
    expect(ff.extinguishedReturn).toBe($(381.37));
    expect(ff.unitsBefore).toBe(u(40));
    expect(ff.unitsAfter).toBe(u(10));
    expect(
      validateSpecialReceipt({
        kind: "FORFEITURE",
        status: "ACCEPTED",
        isReplacement: false,
        amountCents: 0n,
        appliedCents: -ff.forfeited,
        acceptedCents: $(70_000),
        cashAppliedCents: $(40_000),
        receivedOn: FD,
        today: "2027-01-28",
        memberCapitalCents: $(40_000),
      }),
    ).toEqual([]);
    expect(forfeitureUnits(-ff.forfeited, 100_000n, true)).toBe("-30.000000");
    const forfeitureEvent: ForfeitureEvent = {
      kind: "FORFEITURE",
      on: FD,
      seq: 6,
      holderId: "C",
      amount: ff.forfeited,
      units: ff.unitsBefore - ff.unitsAfter,
    };
    const withForfeiture = computePositions(
      [...baseEvents, forfeitureEvent],
      FD,
      cfg,
    );
    const entry = withForfeiture.forfeitures.at(-1);
    expect(entry?.extinguishedReturn).toBe(ff.extinguishedReturn);
    expect(entry?.unitsAfter).toBe(ff.unitsAfter);

    // Credit Date: not fully funded → 2027-02-19.
    const stored = {
      forfeitedOn: FD,
      unpaidAtForfeiture: ff.unpaidAtForfeiture,
      forfeited: ff.forfeited,
    };
    const ev = evaluateDefault(input({ forfeiture: stored }), cfg);
    expect(ev.fullyFundedOn).toBeNull();
    expect(ev.credit.creditDate).toBe("2027-02-19");
    expect(ev.credit.available).toBe(true);
    expect(
      evaluateDefault(
        input({ forfeiture: stored, today: "2027-02-18", asOf: "2027-02-18" }),
        cfg,
      ).credit.available,
    ).toBe(false);

    // On 2027-02-19: interest I-3, outstanding $15,000, not cured (CU-4).
    expect(ev.interestOwed).toBe($(256.44));
    expect(ev.outstanding).toBe($(15_000));
    expect(ev.lineOutstanding).toBe($(15_000));
    expect(ev.cure.cured).toBe(false);
    expect($(100_000) - ev.replacementFunded).toBe($(55_000)); // C's acceptedCents

    // Proposal = CR-1.
    const onDue = computePositions(baseEvents, DUE, cfg);
    const holdersOnDueDate = [...onDue.holders.values()]
      .filter((h) => h.holderId !== "C" && h.preferredUnits > 0n)
      .map((h) => ({ holderId: h.holderId, units: h.preferredUnits }))
      .sort((a, b) => (a.holderId < b.holderId ? -1 : 1));
    expect(holdersOnDueDate).toEqual([
      { holderId: "A", units: u(100) },
      { holderId: "B", units: u(250) },
      { holderId: "K", units: u(50) },
    ]);
    const counted = [fundingA, fundingK].filter(
      (f) => f.fundedOn <= ev.credit.creditDate,
    );
    const cr = computeCreditAllocation(
      {
        forfeited: stored.forfeited,
        unpaidAtForfeiture: stored.unpaidAtForfeiture,
        fundings: counted.map((f) => ({
          holderId: f.funderStakeholderId,
          amount: f.amount,
          isInsider: f.funderIsInsider,
        })),
        holdersOnDueDate,
      },
      cfg,
    );
    expect(cr.poolA).toBe($(11_250));
    expect(cr.redirected).toBe($(3_750));
    expect(cr.poolB).toBe($(22_500));
    const creditTo = (h: string) =>
      cr.credits
        .filter((x) => x.holderId === h)
        .reduce((s, x) => s + x.amount, 0n);
    expect(creditTo("A")).toBe($(13_125));
    expect(creditTo("B")).toBe($(14_062.5));
    expect(creditTo("K")).toBe($(2_812.5));

    // Commitments the credits go on (RULING): A clause A on its Replacement
    // commitment, everything else on the oldest active commitment.
    const { targets, missing } = planCreditTargets({
      credits: cr.credits,
      fundings: counted,
      activeCommitments: new Map([
        [
          "A",
          [
            { id: "cmtA", acceptedOn: "2026-11-16" },
            { id: "cmtA-R", acceptedOn: "2027-01-25" },
          ],
        ],
        ["B", [{ id: "cmtB", acceptedOn: "2026-11-23" }]],
        [
          "K",
          [
            { id: "cmtK", acceptedOn: "2026-11-20" },
            { id: "cmtK-R", acceptedOn: "2027-02-01" },
          ],
        ],
      ]),
    });
    expect(missing).toEqual([]);
    expect(targets.map((t) => [t.holderId, t.clause, t.commitmentId])).toEqual([
      ["A", "A", "cmtA-R"],
      ["A", "B", "cmtA"],
      ["B", "B", "cmtB"],
      ["K", "B", "cmtK"],
    ]);
    for (const t of targets) {
      expect(
        validateSpecialReceipt({
          kind: "CREDIT",
          status: "ACCEPTED",
          isReplacement: t.clause === "A",
          amountCents: 0n,
          appliedCents: t.amount,
          acceptedCents: $(30_000),
          cashAppliedCents: $(30_000),
          receivedOn: "2027-02-19",
          today: "2027-02-19",
          memberCapitalCents: 0n,
        }),
      ).toEqual([]);
    }

    // Units after the credit (receipts dated 2027-02-19).
    const creditReceipts = cr.credits.map((x, index) =>
      receipt(
        `cr${index}`,
        x.holderId,
        "CREDIT",
        "2027-02-19",
        x.amount,
        10 + index,
      ),
    );
    const finalEvents: LedgerEvent[] = [
      ...baseEvents,
      forfeitureEvent,
      ...buildCapitalLots(creditReceipts, []),
    ];
    const after = computePositions(finalEvents, "2027-02-19", cfg);
    const units = (h: string) => after.holders.get(h)?.preferredUnits;
    expect(units("A")).toBe(u(143.125));
    expect(units("B")).toBe(u(264.0625));
    expect(units("K")).toBe(u(67.8125));
    expect(units("C")).toBe(u(10));
    expect(after.totals.preferredUnits).toBe(u(485));
    expect(after.totals.contributed).toBe($(485_000));
  });
});

// ---------------------------------------------------------------------------

describe("buildReductions / netAllocationRows", () => {
  const alloc = (
    id: string,
    amount: number,
    receivedOn: string,
    reversesAllocationId: string | null = null,
  ): DefaultAllocationRow => ({
    id,
    amount: $(amount),
    receivedOn,
    reversesAllocationId,
  });

  it("splits allocations into paid-by-due and member reductions by date, whatever the source", () => {
    const { paidByDue, reductions } = buildReductions(
      [alloc("p1", 20_000, "2026-12-01"), alloc("late", 10_000, "2027-01-25")],
      [{ amount: $(5_000), fundedOn: "2027-01-24" }],
      DUE,
    );
    expect(paidByDue).toBe($(20_000));
    expect(reductions).toEqual([
      { on: "2027-01-24", amount: $(5_000), by: "REPLACEMENT_FUNDER" },
      { on: "2027-01-25", amount: $(10_000), by: "MEMBER" },
    ]);
  });

  it("drops a reversed allocation together with its reversal", () => {
    expect(
      netAllocationRows([
        alloc("x", 10_000, "2027-01-25"),
        alloc("y", 5_000, "2027-01-26"),
        alloc("rx", -10_000, "2027-01-25", "x"),
      ]).map((a) => a.id),
    ).toEqual(["y"]);
  });

  it("rejects a reversal that does not negate a row of the line", () => {
    expect(() =>
      netAllocationRows([
        alloc("x", 10_000, "2027-01-25"),
        alloc("rx", -9_000, "2027-01-25", "x"),
      ]),
    ).toThrow(LlcMathError);
    expect(() => netAllocationRows([alloc("neg", -1, "2027-01-25")])).toThrow(
      LlcMathError,
    );
  });

  it("D-same-day: the same order (MEMBER first) whatever the input order", () => {
    const m: BalanceReduction = {
      on: "2027-01-25",
      amount: $(30_000),
      by: "MEMBER",
    };
    const r: BalanceReduction = {
      on: "2027-01-25",
      amount: $(30_000),
      by: "REPLACEMENT_FUNDER",
    };
    for (const list of [
      [m, r],
      [r, m],
    ]) {
      const ordered = orderReductions(list);
      expect(ordered.map((x) => x.by)).toEqual([
        "MEMBER",
        "REPLACEMENT_FUNDER",
      ]);
      expect(lastReductionBy(ordered, "2027-01-25")).toBe("REPLACEMENT_FUNDER");
      expect(fullyFundedOn($(60_000), ordered)).toBe("2027-01-25");
    }
  });
});

describe("evaluateDefault: cure (R37)", () => {
  // CU-5: Replacement Funder funds $30,000 on 01-25, member pays the rest
  // with interest on 01-26 (before the Forfeiture Date).
  const interest = $(108.49); // (60,000×5 + 30,000×1) × 12% / 365
  const cu5 = input({
    fundings: [fundingA],
    allocations: [
      {
        id: "pay",
        amount: $(30_000),
        receivedOn: "2027-01-26",
        reversesAllocationId: null,
      },
    ],
    payments: [
      {
        id: "p",
        paidOn: "2027-01-26",
        toBalance: $(30_000),
        toInterest: interest,
        toCosts: 0n,
      },
    ],
    today: "2027-01-28",
    asOf: "2027-01-28",
  });

  it("CU-5: partial replacement then the member pays the rest → PAID_IN_FULL on that date, no forfeiture", () => {
    const ev = evaluateDefault(cu5, cfg);
    expect(ev.fullyFundedOn).toBeNull();
    expect(ev.interestOwed).toBe(0n);
    expect(ev.cure).toEqual({
      confirmed: false,
      cured: true,
      method: "PAID_IN_FULL",
      curedOn: "2027-01-26",
      blockedByForfeiture: false,
    });
    expect(ev.forfeiture.paidInFullByForfeitureDate).toBe(true);
    expect(ev.forfeiture.available).toBe(false);
    expect(ev.lineSettledOn).toBe("2027-01-26");
    expect(defaultStage("OPEN", FD, ev).stage).toBe("CURE_AVAILABLE");
  });

  it("interest still owed → not cured", () => {
    const ev = evaluateDefault(
      {
        ...cu5,
        payments: [
          {
            id: "p",
            paidOn: "2027-01-26",
            toBalance: $(30_000),
            toInterest: 0n,
            toCosts: 0n,
          },
        ],
      },
      cfg,
    );
    expect(ev.cure.cured).toBe(false);
    expect(ev.interestOwed).toBe(interest);
  });

  it("paid in full after the Forfeiture Date: the cure waits for the forfeiture", () => {
    const late = input({
      fundings: [],
      allocations: [
        {
          id: "pay",
          amount: $(60_000),
          receivedOn: "2027-01-29",
          reversesAllocationId: null,
        },
      ],
      payments: [
        // 60,000 × 9 days × 12% / 365 = 177.53
        {
          id: "p",
          paidOn: "2027-01-29",
          toBalance: $(60_000),
          toInterest: $(177.53),
          toCosts: 0n,
        },
      ],
      today: "2027-02-01",
      asOf: "2027-02-01",
    });
    const ev = evaluateDefault(late, cfg);
    expect(ev.interestOwed).toBe(0n);
    expect(ev.cure.cured).toBe(false);
    expect(ev.cure.blockedByForfeiture).toBe(true);
    expect(ev.forfeiture.available).toBe(true);
    expect(pendingDefaultSteps("OPEN", FD, ev, "2027-02-10")).toEqual([
      "FORFEITURE",
      "CURE",
    ]);
    // Once the forfeiture is confirmed the cure is available, dated the payment.
    const confirmed = evaluateDefault(
      {
        ...late,
        forfeiture: {
          forfeitedOn: FD,
          unpaidAtForfeiture: $(60_000),
          forfeited: $(30_000),
        },
      },
      cfg,
    );
    expect(confirmed.cure.cured).toBe(true);
    expect(confirmed.cure.curedOn).toBe("2027-01-29");
  });

  it("CU-3: fully funded by Replacement Funders, forfeiture and credit confirmed → REPLACEMENT_FUNDED at the Credit Date", () => {
    const all: DefaultFundingRow = { ...fundingA, amount: $(60_000) };
    const pending = evaluateDefault(
      input({
        fundings: [all],
        forfeiture: {
          forfeitedOn: FD,
          unpaidAtForfeiture: $(60_000),
          forfeited: $(30_000),
        },
        today: "2027-01-28",
        asOf: "2027-01-28",
      }),
      cfg,
    );
    expect(pending.fullyFundedOn).toBe("2027-01-25");
    expect(pending.credit.creditDate).toBe(FD); // CD-3
    expect(pending.cure.cured).toBe(false); // CU-2
    expect(pending.cureNeedsConfirmation).toBe(true); // DR-10
    const done = evaluateDefault(
      input({
        fundings: [all],
        forfeiture: {
          forfeitedOn: FD,
          unpaidAtForfeiture: $(60_000),
          forfeited: $(30_000),
        },
        credit: { creditDate: FD },
        today: "2027-01-28",
        asOf: "2027-01-28",
      }),
      cfg,
    );
    expect(done.interestOwed).toBeGreaterThan(0n);
    expect(done.cure.method).toBe("REPLACEMENT_FUNDED");
    expect(done.cure.cured).toBe(true);
    expect(done.cure.curedOn).toBe(FD);
  });

  it("balance paid late but interest unpaid: a $0 forfeiture is still due", () => {
    const ev = evaluateDefault(
      input({
        fundings: [],
        allocations: [
          {
            id: "pay",
            amount: $(60_000),
            receivedOn: "2027-01-25",
            reversesAllocationId: null,
          },
        ],
        today: "2027-01-28",
        asOf: "2027-01-28",
      }),
      cfg,
    );
    expect(ev.forfeiture.available).toBe(true);
    const ff = computeForfeiture(
      {
        unpaidAtDue: ev.unpaidAtDue,
        reductions: ev.reductions,
        forfeitureDate: FD,
        position: {
          contributed: $(100_000),
          unreturned: $(100_000),
          unpaidReturn: 0n,
          preferredUnits: u(100),
        },
      },
      cfg,
    );
    expect(ff.forfeited).toBe(0n);
    expect(ff.unitsAfter).toBe(u(100));
  });

  it("forfeitureBaseNetOfReplacementFunding flows through unchanged (FF-2)", () => {
    const ev = evaluateDefault(
      input({ fundings: [fundingA], today: "2027-01-28", asOf: "2027-01-28" }),
      cfg,
    );
    const position = {
      contributed: $(40_000),
      unreturned: $(40_000),
      unpaidReturn: $(508.49),
      preferredUnits: u(40),
    };
    const run = (net: boolean) =>
      computeForfeiture(
        {
          unpaidAtDue: ev.unpaidAtDue,
          reductions: ev.reductions,
          forfeitureDate: FD,
          position,
        },
        { ...cfg, forfeitureBaseNetOfReplacementFunding: net },
      );
    expect(run(false).forfeited).toBe($(30_000));
    expect(run(true).forfeited).toBe($(15_000));
    expect(run(true).unitsAfter).toBe(u(25));
  });

  it("rejects a line reduced below zero", () => {
    expect(() =>
      evaluateDefault(
        input({ fundings: [{ ...fundingA, amount: $(70_000) }] }),
        cfg,
      ),
    ).toThrow(LlcMathError);
  });

  it("VOIDED: not suspended, no actions", () => {
    const ev = evaluateDefault(input({ status: "VOIDED", fundings: [] }), cfg);
    expect(ev.suspended).toBe(false);
    expect(defaultStage("VOIDED", FD, ev)).toEqual({
      stage: "VOIDED",
      actions: [],
    });
  });

  it("stage and actions while the forfeiture is pending", () => {
    const ev = evaluateDefault(
      input({ fundings: [fundingA], today: "2027-01-22", asOf: "2027-01-22" }),
      cfg,
    );
    expect(defaultStage("OPEN", FD, ev)).toEqual({
      stage: "DECLARED",
      actions: [
        {
          action: "CONFIRM_FORFEITURE",
          availableOn: "2027-01-28",
          available: false,
        },
      ],
    });
  });
});

describe("fundingErrors (R31)", () => {
  const ok = {
    status: "OPEN" as const,
    today: "2027-02-01",
    fundedOn: "2027-01-25",
    window: { opensOn: "2027-01-21", closesOn: "2027-06-30" },
    amount: $(30_000),
    outstandingAtFundedOn: $(60_000),
    outstandingNow: $(60_000),
    funderIsDefaulter: false,
    funderIsInsider: false,
    earlierTranchesInsider: [],
    forfeiture: null,
    credit: null,
    forfeitureBaseNetOfReplacementFunding: false,
    interestPaymentDates: [],
  };

  it("accepts the worked-case funding", () => {
    expect(fundingErrors(ok)).toEqual([]);
  });

  it("rejects 2027-01-20 (the due date) and 2027-07-01 (after the outside date)", () => {
    expect(fundingErrors({ ...ok, fundedOn: "2027-01-20" })).toHaveLength(1);
    expect(
      fundingErrors({ ...ok, fundedOn: "2027-07-01", today: "2027-07-01" }),
    ).toHaveLength(1);
  });

  it("caps the amount by the outstanding Balance now, not only at the funding date", () => {
    expect(fundingErrors({ ...ok, outstandingNow: $(20_000) })).toHaveLength(1);
  });

  it("rejects the defaulter, a changed insider status, and dates a confirmed step relied on", () => {
    expect(fundingErrors({ ...ok, funderIsDefaulter: true })).toHaveLength(1);
    expect(
      fundingErrors({ ...ok, earlierTranchesInsider: [true] }),
    ).toHaveLength(1);
    expect(
      fundingErrors({ ...ok, credit: { creditDate: "2027-02-19" } }),
    ).toHaveLength(1);
    const forfeiture = { forfeitedOn: FD };
    expect(fundingErrors({ ...ok, forfeiture })).toEqual([]);
    expect(
      fundingErrors({
        ...ok,
        forfeiture,
        forfeitureBaseNetOfReplacementFunding: true,
      }),
    ).toHaveLength(1);
    expect(
      fundingErrors({ ...ok, interestPaymentDates: ["2027-01-30"] }),
    ).toHaveLength(1);
    expect(fundingErrors({ ...ok, status: "CURED" })).toHaveLength(1);
  });
});

describe("planDefaultPayment", () => {
  const base = {
    status: "OPEN" as const,
    dueOn: DUE,
    paidOn: "2027-02-19",
    today: "2027-02-19",
    figures: {
      outstanding: $(15_000),
      interestOwed: $(256.44),
      costsOwed: $(1_000),
    },
    lineOutstandingNow: $(15_000),
    latestPaymentOn: null,
    forfeiture: null,
    credit: null,
    order: cfg.defaultOffsetOrder,
  };

  it("applies Balance, then interest, then costs", () => {
    const plan = planDefaultPayment({ ...base, amount: $(15_100) });
    expect(plan.errors).toEqual([]);
    expect([plan.toBalance, plan.toInterest, plan.toCosts]).toEqual([
      $(15_000),
      $(100),
      0n,
    ]);
    const reverse = planDefaultPayment({
      ...base,
      amount: $(1_100),
      order: ["COSTS", "INTEREST", "BALANCE"],
    });
    expect([reverse.toBalance, reverse.toInterest, reverse.toCosts]).toEqual([
      0n,
      $(100),
      $(1_000),
    ]);
  });

  it("rejects more than is owed, a date on or before the due date, and out-of-order dates", () => {
    expect(
      planDefaultPayment({ ...base, amount: $(20_000) }).errors,
    ).toHaveLength(1);
    expect(
      planDefaultPayment({ ...base, amount: $(1), paidOn: DUE }).errors,
    ).toHaveLength(1);
    expect(
      planDefaultPayment({
        ...base,
        amount: $(1),
        latestPaymentOn: "2027-02-20",
      }).errors,
    ).toHaveLength(1);
    expect(
      planDefaultPayment({
        ...base,
        amount: $(1),
        paidOn: FD,
        forfeiture: { forfeitedOn: FD },
      }).errors.length,
    ).toBeGreaterThan(0);
  });

  it("a CURED default owes no Balance (R18) and caps by the line outstanding now", () => {
    const cured = planDefaultPayment({
      ...base,
      status: "CURED",
      amount: $(256.44),
    });
    expect([cured.toBalance, cured.toInterest]).toEqual([0n, $(256.44)]);
    const capped = planDefaultPayment({
      ...base,
      amount: $(15_000),
      lineOutstandingNow: $(5_000),
    });
    expect(capped.owed.balance).toBe($(5_000));
    expect(capped.errors).toHaveLength(1);
  });
});

describe("planCreditTargets (RULING)", () => {
  it("records the whole clause-A credit on the commitment of the earliest funding", () => {
    const { targets, missing } = planCreditTargets({
      credits: [
        { holderId: "A", clause: "A", amount: $(7_500), units: u(7.5) },
      ],
      fundings: [
        {
          funderStakeholderId: "A",
          funderCommitmentId: "late",
          fundedOn: "2027-02-01",
        },
        {
          funderStakeholderId: "A",
          funderCommitmentId: "early",
          fundedOn: "2027-01-25",
        },
        {
          funderStakeholderId: "A",
          funderCommitmentId: "sameDay2",
          fundedOn: "2027-01-25",
        },
      ],
      activeCommitments: new Map([
        [
          "A",
          [
            { id: "late", acceptedOn: "2027-02-01" },
            { id: "early", acceptedOn: "2027-01-25" },
            { id: "sameDay2", acceptedOn: "2027-01-25" },
          ],
        ],
      ]),
    });
    expect(missing).toEqual([]);
    expect(targets[0]?.commitmentId).toBe("early");
    expect(targets[0]?.note).toContain("earliest funding (2027-01-25)");
  });

  it("reports a holder with units only by transfer (no active commitment) and an inactive Replacement commitment", () => {
    const { targets, missing } = planCreditTargets({
      credits: [
        { holderId: "T", clause: "B", amount: $(100), units: u(0.1) },
        { holderId: "N", clause: "A", amount: $(100), units: u(0.1) },
      ],
      fundings: [
        {
          funderStakeholderId: "N",
          funderCommitmentId: "gone",
          fundedOn: "2027-01-25",
        },
      ],
      activeCommitments: new Map(),
    });
    expect(targets).toEqual([]);
    expect(missing).toEqual([
      { holderId: "T", clause: "B" },
      { holderId: "N", clause: "A" },
    ]);
  });
});

describe("declarationErrors", () => {
  it("refuses an unsent, not yet due, already declared or paid line", () => {
    const ok = {
      lineStatus: "SENT",
      dueOn: DUE,
      today: "2027-01-21",
      hasDefault: false,
      outstanding: $(1),
    };
    expect(declarationErrors(ok)).toEqual([]);
    expect(declarationErrors({ ...ok, lineStatus: "SENDING" })).toHaveLength(1);
    expect(declarationErrors({ ...ok, today: DUE })).toHaveLength(1);
    expect(declarationErrors({ ...ok, hasDefault: true })).toHaveLength(1);
    expect(declarationErrors({ ...ok, outstanding: 0n })).toHaveLength(1);
  });
});

describe("livePayments", () => {
  it("drops a reversed payment and its reversal", () => {
    const rows = [
      { id: "p1", reversesPaymentId: null },
      { id: "p2", reversesPaymentId: null },
      { id: "r1", reversesPaymentId: "p1" },
    ];
    expect(livePayments(rows).map((r) => r.id)).toEqual(["p2"]);
  });
});

describe("blockingDefaultSteps (confirmation order across defaults)", () => {
  const STORED = {
    forfeitedOn: FD,
    unpaidAtForfeiture: $(60_000),
    forfeited: $(30_000),
  };
  // C's worked-case default, forfeiture not yet confirmed (today 2027-04-05).
  const cPending: OtherDefault = {
    id: "dC",
    stakeholderId: "C",
    status: "OPEN",
    forfeitureDate: FD,
    seq: 0,
    ev: evaluateDefault(
      input({ today: "2027-04-05", asOf: "2027-04-05" }),
      cfg,
    ),
  };
  const cForfeited: OtherDefault = {
    ...cPending,
    ev: evaluateDefault(
      input({ forfeiture: STORED, today: "2027-04-05", asOf: "2027-04-05" }),
      cfg,
    ),
  };
  const later = { id: "dX", stakeholderId: "X", seq: 1 };

  it("a later default's credit waits for C's earlier forfeiture and credit", () => {
    expect(
      blockingDefaultSteps({
        self: later,
        step: "CREDIT",
        readsOn: "2027-03-31",
        others: [cPending],
      }),
    ).toEqual([{ id: "dC", step: "FORFEITURE", on: FD }]);
    expect(
      blockingDefaultSteps({
        self: later,
        step: "CREDIT",
        readsOn: "2027-03-31",
        others: [cForfeited],
      }),
    ).toEqual([{ id: "dC", step: "CREDIT", on: "2027-02-19" }]);
    expect(
      blockingDefaultSteps({
        self: later,
        step: "CREDIT",
        readsOn: "2027-01-26",
        others: [cPending],
      }),
    ).toEqual([]);
  });

  it("a forfeiture waits only for the same member's earlier forfeiture, and for any earlier credit", () => {
    expect(
      blockingDefaultSteps({
        self: later,
        step: "FORFEITURE",
        readsOn: "2027-04-07",
        others: [cPending],
      }),
    ).toEqual([]);
    expect(
      blockingDefaultSteps({
        self: { id: "dC2", stakeholderId: "C", seq: 1 },
        step: "FORFEITURE",
        readsOn: FD,
        others: [cPending],
      }),
    ).toEqual([{ id: "dC", step: "FORFEITURE", on: FD }]);
    // Same member, same date: only the earlier-declared one blocks (no cycle).
    expect(
      blockingDefaultSteps({
        self: { id: "dC", stakeholderId: "C", seq: 0 },
        step: "FORFEITURE",
        readsOn: FD,
        others: [{ ...cPending, id: "dC2", seq: 1 }],
      }),
    ).toEqual([]);
    expect(
      blockingDefaultSteps({
        self: later,
        step: "FORFEITURE",
        readsOn: "2027-04-07",
        others: [cForfeited],
      }),
    ).toEqual([{ id: "dC", step: "CREDIT", on: "2027-02-19" }]);
  });
});
