import { describe, expect, it } from "vitest";
import {
  type AcceptanceInput,
  allocateHeldReceipts,
  computeSubscriptionClock,
  decisionStatus,
  defaultKeepCents,
  deriveReceiptKind,
  type OfferingTerms,
  outstandingBalanceCents,
  prefReturnStartDate,
  refundDueCents,
  requiredInitialInstallmentCents,
  validateAcceptance,
  validateCashReceipt,
} from "./commitment-rules";

const $ = (dollars: number) => BigInt(Math.round(dollars * 100));

const TERMS: OfferingTerms = {
  minCommitmentCents: $(100_000),
  minCommitmentFloorCents: $(50_000),
  offeringCapCents: $(2_000_000),
  initialInstallmentBps: 4000,
  finalClosingDate: "2026-11-30",
  balanceOutsideDate: "2027-03-31",
  acceptanceBusinessDays: 10,
  refundBusinessDays: 5,
  prefReturnBps: 800,
  balanceReturnStartRule: "LATER_OF_RECEIPT_AND_DUE",
};

type Case = Partial<Omit<AcceptanceInput, "keepCents">> & {
  keepCents?: bigint;
};

/** Builds an acceptance input; keep defaults to `defaultKeepCents`. */
function input(c: Case): AcceptanceInput {
  const committedCents = c.committedCents ?? $(250_000);
  const acceptedCents = c.acceptedCents ?? committedCents;
  const heldCents = c.heldCents ?? 0n;
  return {
    terms: TERMS,
    acceptedOn: "2026-11-20",
    signedOn: null,
    today: "2026-11-20",
    otherAcceptedCents: 0n,
    minimumWaived: false,
    isReplacement: false,
    skipClosingDateCheck: false,
    ...c,
    committedCents,
    acceptedCents,
    heldCents,
    keepCents:
      c.keepCents ??
      defaultKeepCents({ heldCents, acceptedCents, committedCents }),
  };
}

const codes = (i: AcceptanceInput) => validateAcceptance(i).map((e) => e.code);

const A1: Case = {
  committedCents: $(250_000),
  acceptedCents: $(250_000),
  heldCents: $(100_000),
};
const A9: Case = {
  committedCents: $(200_000),
  acceptedCents: $(100_000),
  heldCents: $(80_000),
};
const A12: Case = { ...A1, acceptedOn: "2026-12-01", today: "2026-12-01" };

describe("validateAcceptance worked examples", () => {
  it("A1: full acceptance with 40% held", () => {
    const i = input(A1);
    expect(validateAcceptance(i)).toEqual([]);
    expect(i.keepCents).toBe($(100_000));
    expect(refundDueCents(i.heldCents, i.keepCents)).toBe(0n);
    expect(decisionStatus(i.acceptedCents, i.committedCents)).toBe("ACCEPTED");
    expect(outstandingBalanceCents(i.acceptedCents, i.keepCents)).toBe(
      $(150_000),
    );
  });

  it("A2: one cent short of the Initial Installment", () => {
    const errs = validateAcceptance(input({ ...A1, heldCents: $(99_999.99) }));
    expect(errs.map((e) => e.code)).toEqual(["INITIAL_INSTALLMENT_SHORT"]);
    expect(errs[0]?.message).toBe(
      "Received $99,999.99; at least $100,000.00 (40% of the accepted amount) must be received before acceptance (Section 4.9).",
    );
  });

  it("A3: minimum, paid in full", () => {
    const i = input({
      committedCents: $(100_000),
      acceptedCents: $(100_000),
      heldCents: $(100_000),
    });
    expect(validateAcceptance(i)).toEqual([]);
    expect(i.keepCents).toBe($(100_000));
    expect(outstandingBalanceCents(i.acceptedCents, i.keepCents)).toBe(0n);
  });

  const A4: Case = {
    committedCents: $(75_000),
    acceptedCents: $(75_000),
    heldCents: $(30_000),
  };
  it("A4: below minimum, not waived", () => {
    const errs = validateAcceptance(input(A4));
    expect(errs.map((e) => e.code)).toEqual(["MINIMUM_WAIVER_REQUIRED"]);
    expect(errs[0]?.message).toBe(
      "$75,000.00 is below the $100,000.00 minimum. Tick the waiver to admit at not less than $50,000.00 (Section 3.7).",
    );
  });

  it("A5: below minimum, waived", () => {
    const i = input({ ...A4, minimumWaived: true });
    expect(validateAcceptance(i)).toEqual([]);
    expect(i.keepCents).toBe($(30_000));
  });

  it("A6: below the floor even when waived", () => {
    const errs = validateAcceptance(
      input({
        committedCents: $(49_999.99),
        acceptedCents: $(49_999.99),
        heldCents: $(20_000),
        minimumWaived: true,
      }),
    );
    expect(errs.map((e) => e.code)).toEqual(["BELOW_FLOOR"]);
    expect(errs[0]?.message).toBe(
      "The minimum Capital Contribution cannot be waived below $50,000.00 (Section 3.7).",
    );
  });

  it("A7: cap exceeded", () => {
    const errs = validateAcceptance(
      input({
        otherAcceptedCents: $(1_950_000),
        committedCents: $(100_000),
        acceptedCents: $(100_000),
        heldCents: $(40_000),
      }),
    );
    expect(errs.map((e) => e.code)).toEqual(["CAP_EXCEEDED"]);
    expect(errs[0]?.message).toBe(
      "Accepting $100,000.00 would exceed the $2,000,000.00 cap; $50,000.00 remains (Section 4.8).",
    );
  });

  it("A8: reduced to fit the cap, waived", () => {
    const i = input({
      otherAcceptedCents: $(1_950_000),
      committedCents: $(100_000),
      acceptedCents: $(50_000),
      minimumWaived: true,
      heldCents: $(40_000),
    });
    expect(validateAcceptance(i)).toEqual([]);
    expect(i.keepCents).toBe($(20_000));
    expect(refundDueCents(i.heldCents, i.keepCents)).toBe($(20_000));
    expect(decisionStatus(i.acceptedCents, i.committedCents)).toBe("REDUCED");
  });

  it("A9: reduced, pro rata keep", () => {
    const i = input(A9);
    expect(validateAcceptance(i)).toEqual([]);
    expect(i.keepCents).toBe($(40_000));
    expect(refundDueCents(i.heldCents, i.keepCents)).toBe($(40_000));
  });

  it("A10: reduced, Manager keeps everything held", () => {
    const i = input({ ...A9, keepCents: $(80_000) });
    expect(validateAcceptance(i)).toEqual([]);
    expect(refundDueCents(i.heldCents, i.keepCents)).toBe(0n);
  });

  it("A11: keep below 40% of accepted", () => {
    const errs = validateAcceptance(input({ ...A9, keepCents: $(39_999.99) }));
    expect(errs.map((e) => e.code)).toEqual(["KEEP_OUT_OF_RANGE"]);
    expect(errs[0]?.message).toBe(
      "The amount kept must be between $40,000.00 and $80,000.00.",
    );
  });

  it("A12: after the Final Closing Date", () => {
    const errs = validateAcceptance(input(A12));
    expect(errs.map((e) => e.code)).toEqual(["AFTER_FINAL_CLOSING"]);
    expect(errs[0]?.message).toBe(
      "No Preferred Member may be admitted after the Final Closing Date (2026-11-30) (Section 4.8).",
    );
  });

  it("A13: acceptance dated on the closing date, entered later", () => {
    expect(
      codes(input({ ...A1, acceptedOn: "2026-11-30", today: "2026-12-15" })),
    ).toEqual([]);
  });

  it("A14: Replacement Funder skips closing date and minimum", () => {
    const c = codes(input({ ...A12, isReplacement: true }));
    expect(c).not.toContain("AFTER_FINAL_CLOSING");
    expect(c).not.toContain("BELOW_FLOOR");
    expect(c).not.toContain("MINIMUM_WAIVER_REQUIRED");
    expect(c).toEqual([]);
  });

  it("A14b: Replacement Funder with no held cash", () => {
    const base: Case = {
      isReplacement: true,
      committedCents: $(30_000),
      acceptedCents: $(30_000),
      heldCents: 0n,
      keepCents: 0n,
      acceptedOn: "2027-04-10",
      today: "2027-04-10",
    };
    expect(codes(input(base))).toEqual([]);
    expect(codes(input({ ...base, otherAcceptedCents: $(1_990_000) }))).toEqual(
      ["CAP_EXCEEDED"],
    );
  });

  it("A15: overpaid subscription refunds the excess", () => {
    const i = input({
      committedCents: $(100_000),
      acceptedCents: $(100_000),
      heldCents: $(120_000),
    });
    expect(validateAcceptance(i)).toEqual([]);
    expect(i.keepCents).toBe($(100_000));
    expect(refundDueCents(i.heldCents, i.keepCents)).toBe($(20_000));
  });

  it("A16: Initial Installment rounds up to the cent", () => {
    expect(requiredInitialInstallmentCents($(100_000.01), 4000)).toBe(
      $(40_000.01),
    );
  });

  it("A17: cap reached exactly", () => {
    expect(
      codes(
        input({
          otherAcceptedCents: $(1_900_000),
          committedCents: $(100_000),
          acceptedCents: $(100_000),
          heldCents: $(40_000),
        }),
      ),
    ).toEqual([]);
  });

  it("A18: missing Final Closing Date", () => {
    const i = input(A1);
    const errs = validateAcceptance({
      ...i,
      terms: { ...TERMS, finalClosingDate: null },
    });
    expect(errs).toEqual([
      {
        code: "TERMS_INCOMPLETE",
        message:
          "Set the minimum, cap and Final Closing Date of the unit class first.",
      },
    ]);
  });

  it("A19: acceptance before the signature date", () => {
    const errs = validateAcceptance(input({ ...A1, signedOn: "2026-11-21" }));
    expect(errs).toEqual([
      {
        code: "DATE_ORDER",
        message: "The acceptance date cannot be before the signature date.",
      },
    ]);
  });
});

describe("allocateHeldReceipts", () => {
  it("applies keep in receipt order", () => {
    expect(
      allocateHeldReceipts(
        [
          { id: "r2", receivedOn: "2026-11-05", amountCents: $(50_000) },
          { id: "r1", receivedOn: "2026-11-02", amountCents: $(30_000) },
        ],
        $(40_000),
      ),
    ).toEqual([
      { id: "r1", appliedCents: $(30_000) },
      { id: "r2", appliedCents: $(10_000) },
    ]);
  });
});

/** Test double: Monday–Friday, holidays 2026-11-11 and 2026-11-26. */
const HOLIDAYS = new Set(["2026-11-11", "2026-11-26"]);
function addBusinessDaysDouble(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00.000Z`);
  let count = 0;
  while (count < n) {
    d.setUTCDate(d.getUTCDate() + 1);
    const iso = d.toISOString().slice(0, 10);
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6 && !HOLIDAYS.has(iso)) count++;
  }
  return d.toISOString().slice(0, 10);
}

describe("computeSubscriptionClock", () => {
  const base = {
    committedCents: $(250_000),
    initialInstallmentBps: 4000,
    acceptanceBusinessDays: 10,
    refundBusinessDays: 5,
    finalClosingDate: "2026-11-30",
  };
  const allNull = {
    clockStart: null,
    acceptanceDeadline: null,
    effectiveDecisionDeadline: null,
    refundDueBy: null,
  };

  it("K1", () => {
    expect(
      computeSubscriptionClock(
        {
          ...base,
          signedOn: "2026-11-02",
          receipts: [
            { id: "a", receivedOn: "2026-11-02", amountCents: $(100_000) },
          ],
        },
        addBusinessDaysDouble,
      ),
    ).toEqual({
      clockStart: "2026-11-02",
      acceptanceDeadline: "2026-11-17",
      effectiveDecisionDeadline: "2026-11-17",
      refundDueBy: "2026-11-24",
    });
  });

  it("K2", () => {
    expect(
      computeSubscriptionClock(
        {
          ...base,
          signedOn: "2026-11-18",
          receipts: [
            { id: "b", receivedOn: "2026-11-20", amountCents: $(80_000) },
            { id: "a", receivedOn: "2026-11-17", amountCents: $(20_000) },
          ],
        },
        addBusinessDaysDouble,
      ),
    ).toEqual({
      clockStart: "2026-11-20",
      acceptanceDeadline: "2026-12-07",
      effectiveDecisionDeadline: "2026-11-30",
      refundDueBy: "2026-12-14",
    });
  });

  it("K3: no signature date", () => {
    expect(
      computeSubscriptionClock(
        {
          ...base,
          signedOn: null,
          receipts: [
            { id: "a", receivedOn: "2026-11-02", amountCents: $(100_000) },
          ],
        },
        addBusinessDaysDouble,
      ),
    ).toEqual(allNull);
  });

  it("K4: threshold not reached", () => {
    expect(
      computeSubscriptionClock(
        {
          ...base,
          signedOn: "2026-11-02",
          receipts: [
            { id: "a", receivedOn: "2026-11-02", amountCents: $(99_999.99) },
          ],
        },
        addBusinessDaysDouble,
      ),
    ).toEqual(allNull);
  });
});

describe("deriveReceiptKind", () => {
  it("classifies receipts", () => {
    expect(
      deriveReceiptKind({
        status: "PENDING",
        acceptedOn: null,
        receivedOn: "2026-11-14",
      }),
    ).toBe("INITIAL");
    expect(
      deriveReceiptKind({
        status: "ACCEPTED",
        acceptedOn: "2026-11-14",
        receivedOn: "2026-11-14",
      }),
    ).toBe("INITIAL");
    expect(
      deriveReceiptKind({
        status: "ACCEPTED",
        acceptedOn: "2026-11-14",
        receivedOn: "2026-11-15",
      }),
    ).toBe("BALANCE");
    expect(() =>
      deriveReceiptKind({
        status: "REJECTED",
        acceptedOn: "2026-11-14",
        receivedOn: "2026-11-15",
      }),
    ).toThrow(expect.objectContaining({ code: "NOT_OPEN" }));
  });
});

describe("prefReturnStartDate", () => {
  const start = (
    kind: "INITIAL" | "BALANCE",
    receivedOn: string,
    dueDate: string | null,
    terms: Partial<OfferingTerms> = {},
  ) =>
    prefReturnStartDate({
      kind,
      receivedOn,
      dueDate,
      terms: { ...TERMS, ...terms },
    });

  it("follows Sections 4.9 and 5.6(b)", () => {
    expect(start("INITIAL", "2026-11-10", null)).toBe("2026-11-10");
    expect(start("BALANCE", "2026-12-15", null)).toBe("2027-03-31");
    expect(start("BALANCE", "2027-01-18", "2027-01-20")).toBe("2027-01-20");
    expect(start("BALANCE", "2027-02-02", "2027-01-20")).toBe("2027-02-02");
    expect(
      start("BALANCE", "2026-12-15", null, {
        balanceReturnStartRule: "RECEIPT_DATE",
      }),
    ).toBe("2026-12-15");
    expect(start("INITIAL", "2026-11-10", null, { prefReturnBps: 0 })).toBe(
      null,
    );
    expect(
      start("BALANCE", "2026-12-15", null, { balanceOutsideDate: null }),
    ).toBe(undefined);
  });
});

describe("validateCashReceipt", () => {
  const base = {
    status: "ACCEPTED" as const,
    acceptedCents: $(250_000),
    cashAppliedCents: $(100_000),
    receivedOn: "2026-11-20",
    today: "2026-11-20",
  };
  it("accepts the exact Balance", () => {
    expect(validateCashReceipt({ ...base, amountCents: $(150_000) })).toEqual(
      [],
    );
  });
  it("rejects one cent too much", () => {
    expect(
      validateCashReceipt({ ...base, amountCents: $(150_000.01) }),
    ).toEqual([
      {
        code: "OVERPAYMENT",
        message: "Only $150,000.00 of the Balance is outstanding.",
      },
    ]);
  });
  it("has no upper limit while pending", () => {
    expect(
      validateCashReceipt({
        ...base,
        status: "PENDING",
        acceptedCents: 0n,
        cashAppliedCents: 0n,
        amountCents: $(500_000),
      }),
    ).toEqual([]);
  });
});
