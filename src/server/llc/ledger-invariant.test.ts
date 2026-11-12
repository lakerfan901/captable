/**
 * H1 / M1 / G1: the ledger invariant (`ledgerInvariantErrors`) over sequences
 * of accept, reduce, reject, receipt, void and refund, driven through the
 * same pure rules the services in commitments.ts use. The database-bound
 * version of these sequences is src/server/llc/__integration__/ledger.integration.ts.
 */
import { describe, expect, it } from "vitest";
import {
  type CommitmentStatus,
  decisionStatus,
  defaultKeepCents,
  deriveReceiptKind,
  heldOnOrBefore,
  planAcceptance,
  type ReceiptKind,
  type RuleError,
  validateAcceptance,
  validateCashReceipt,
} from "../../lib/admission/commitment-rules";
import { unitsForAmount } from "../../lib/llc/units";
import {
  forfeitureUnits,
  ledgerInvariantErrors,
  planVoid,
  refundDueFromReceipts,
  sumCashApplied,
  sumUnits,
  validateSpecialReceipt,
} from "./receipt-rules";

const $ = (dollars: number) => BigInt(Math.round(dollars * 100));
const PRICE = $(1_000);

type Row = {
  id: string;
  kind: ReceiptKind;
  receivedOn: string;
  amountCents: bigint;
  appliedCents: bigint;
  unitsIssued: string;
  voided: boolean;
};

/** In-memory commitment driven like the services drive the database. */
class Ledger {
  status: CommitmentStatus = "PENDING";
  acceptedCents = 0n;
  acceptedOn: string | null = null;
  refundDueCents = 0n;
  refundPaidCents = 0n;
  receipts: Row[] = [];
  private seq = 0;

  constructor(readonly committedCents: bigint) {}

  live() {
    return this.receipts.filter((r) => !r.voided);
  }

  private fail(errors: RuleError[]) {
    if (errors.length > 0)
      throw new Error(errors.map((e) => e.message).join(" "));
  }

  receive(receivedOn: string, cents: bigint): string {
    this.fail(
      validateCashReceipt({
        status: this.status,
        acceptedCents: this.acceptedCents,
        cashAppliedCents: sumCashApplied(this.live()),
        amountCents: cents,
        receivedOn,
        today: "2026-11-30",
      }),
    );
    const kind = deriveReceiptKind({
      status: this.status,
      acceptedOn: this.acceptedOn,
      receivedOn,
    });
    const applied = this.status === "PENDING" ? 0n : cents;
    const id = `r${++this.seq}`;
    this.receipts.push({
      id,
      kind,
      receivedOn,
      amountCents: cents,
      appliedCents: applied,
      unitsIssued: unitsForAmount(applied, PRICE, true),
      voided: false,
    });
    return id;
  }

  forfeit(cents: bigint): string {
    const capital = this.live().reduce((s, r) => s + r.appliedCents, 0n);
    this.fail(
      validateSpecialReceipt({
        kind: "FORFEITURE",
        status: this.status,
        isReplacement: false,
        amountCents: 0n,
        appliedCents: -cents,
        acceptedCents: this.acceptedCents,
        cashAppliedCents: sumCashApplied(this.live()),
        receivedOn: "2026-11-20",
        today: "2026-11-30",
        memberCapitalCents: capital,
      }),
    );
    const id = `r${++this.seq}`;
    this.receipts.push({
      id,
      kind: "FORFEITURE",
      receivedOn: "2026-11-20",
      amountCents: 0n,
      appliedCents: -cents,
      unitsIssued: forfeitureUnits(-cents, PRICE, true),
      voided: false,
    });
    return id;
  }

  accept(
    acceptedOn: string,
    acceptedCents = this.committedCents,
    keep?: bigint,
  ) {
    const held = heldOnOrBefore(this.live(), acceptedOn);
    const keepCents =
      keep ??
      defaultKeepCents({
        heldCents: held,
        acceptedCents,
        committedCents: this.committedCents,
      });
    this.fail(
      validateAcceptance({
        terms: {
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
        },
        committedCents: this.committedCents,
        acceptedCents,
        acceptedOn,
        signedOn: null,
        today: "2026-11-30",
        heldCents: held,
        keepCents,
        otherAcceptedCents: 0n,
        minimumWaived: true,
        isReplacement: false,
        skipClosingDateCheck: false,
      }),
    );
    const plan = planAcceptance({
      receipts: this.live(),
      acceptedOn,
      acceptedCents,
      keepCents,
    });
    for (const row of plan.rows) {
      const r = this.receipts.find((x) => x.id === row.id);
      if (!r) continue;
      r.kind = row.kind;
      r.appliedCents = row.appliedCents;
      r.unitsIssued = unitsForAmount(row.appliedCents, PRICE, true);
    }
    this.status = decisionStatus(acceptedCents, this.committedCents);
    this.acceptedCents = acceptedCents;
    this.acceptedOn = acceptedOn;
    this.refundDueCents = plan.refundCents;
  }

  reject(on: string) {
    this.status = "REJECTED";
    this.acceptedOn = on;
    this.refundDueCents = this.live().reduce((s, r) => s + r.amountCents, 0n);
  }

  reduce(by: bigint) {
    const unpaid = this.acceptedCents - sumCashApplied(this.live());
    if (by <= 0n || by > unpaid) throw new Error("reduction out of range");
    this.acceptedCents -= by;
  }

  refund(paid: bigint) {
    if (paid <= 0n || paid > this.refundDueCents - this.refundPaidCents) {
      throw new Error("refund out of range");
    }
    this.refundPaidCents += paid;
  }

  void(id: string) {
    const receipt = this.receipts.find((r) => r.id === id && !r.voided);
    if (!receipt) throw new Error("no such receipt");
    const remaining = this.live().filter((r) => r.id !== id);
    const plan = planVoid({
      status: this.status,
      receipt,
      refundPaidCents: this.refundPaidCents,
      remaining,
      memberCapitalAfterCents: remaining.reduce(
        (s, r) => s + r.appliedCents,
        0n,
      ),
      memberUnitsAfter: sumUnits(remaining.map((r) => r.unitsIssued)),
    });
    this.fail(plan.errors);
    receipt.voided = true;
    if (plan.refundDueCents !== null) this.refundDueCents = plan.refundDueCents;
  }

  invariant(): string[] {
    return ledgerInvariantErrors(this, this.live());
  }
}

/** Runs each step, asserting the invariant after every one (refused steps included). */
function run(ledger: Ledger, steps: [string, () => unknown][]) {
  const refused: string[] = [];
  for (const [label, step] of steps) {
    try {
      step();
    } catch {
      refused.push(label);
    }
    expect(ledger.invariant(), `after ${label}`).toEqual([]);
  }
  return refused;
}

describe("ledger invariant across mutation sequences", () => {
  it("H1: the review scenario (reduce, split receipt, void, re-record) keeps cash = applied + refund", () => {
    const l = new Ledger($(200_000));
    let r1 = "";
    const refused = run(l, [
      ["receive", () => (r1 = l.receive("2026-11-03", $(80_000)))],
      ["accept reduced", () => l.accept("2026-11-05", $(100_000))],
      ["void split receipt", () => l.void(r1)],
      // The original stays, so a second $80k would overpay the $60k Balance.
      ["re-record", () => l.receive("2026-11-03", $(80_000))],
    ]);
    expect(refused).toEqual(["void split receipt", "re-record"]);
    expect(l.refundDueCents).toBe($(40_000));
    expect(sumCashApplied(l.live())).toBe($(40_000));
  });

  it("H1: before the fix, voiding the split receipt and re-recording broke the invariant", () => {
    // The pre-fix void left refundDueCents at $40k with nothing received.
    expect(
      ledgerInvariantErrors(
        {
          status: "REDUCED",
          acceptedCents: $(100_000),
          refundDueCents: $(40_000),
          refundPaidCents: 0n,
        },
        [
          {
            kind: "INITIAL",
            amountCents: $(80_000),
            appliedCents: $(80_000),
            unitsIssued: "80.000000",
          },
        ],
      ),
    ).toEqual(["received 8000000 ≠ applied 8000000 + refund due 4000000"]);
  });

  it("H1: a voided duplicate on a rejected commitment reduces the refund due", () => {
    const l = new Ledger($(100_000));
    let r1 = "";
    let r2 = "";
    const refused = run(l, [
      ["r1", () => (r1 = l.receive("2026-11-03", $(40_000)))],
      ["r2", () => (r2 = l.receive("2026-11-03", $(40_000)))],
      ["reject", () => l.reject("2026-11-05")],
      ["void r2", () => l.void(r2)],
      ["refund", () => l.refund($(40_000))],
      ["void r1 after refund", () => l.void(r1)],
    ]);
    expect(refused).toEqual(["void r1 after refund"]);
    expect(l.refundDueCents).toBe($(40_000));
  });

  it("H1: an unapplied duplicate on a reduced commitment can be voided", () => {
    const l = new Ledger($(200_000));
    let r2 = "";
    run(l, [
      ["r1", () => l.receive("2026-11-03", $(80_000))],
      ["r2", () => (r2 = l.receive("2026-11-03", $(80_000)))],
      ["accept reduced", () => l.accept("2026-11-05", $(100_000))],
      ["void r2", () => l.void(r2)],
    ]);
    expect(l.refundDueCents).toBe(0n);
  });

  it("accept in full, balance, void, re-record, reduce, overpay, refund", () => {
    const l = new Ledger($(250_000));
    let bal = "";
    const refused = run(l, [
      ["held", () => l.receive("2026-11-03", $(120_000))],
      [
        "late held after acceptance date",
        () => l.receive("2026-11-09", $(10_000)),
      ],
      ["accept", () => l.accept("2026-11-05")],
      ["balance", () => (bal = l.receive("2026-11-10", $(50_000)))],
      ["void balance", () => l.void(bal)],
      ["re-record balance", () => l.receive("2026-11-10", $(50_000))],
      ["reduce", () => l.reduce($(30_000))],
      ["overpay", () => l.receive("2026-11-11", $(60_000.01))],
      ["pay off", () => l.receive("2026-11-11", $(40_000))],
      ["refund nothing", () => l.refund(1n)],
    ]);
    expect(refused).toEqual(["overpay", "refund nothing"]);
    expect(sumCashApplied(l.live())).toBe(l.acceptedCents);
  });

  it("excess Initial Installment refunded, refund paid, split receipt cannot be voided", () => {
    const l = new Ledger($(100_000));
    let r = "";
    const refused = run(l, [
      ["held", () => (r = l.receive("2026-11-03", $(120_000)))],
      ["accept", () => l.accept("2026-11-05")],
      ["refund", () => l.refund($(20_000))],
      ["void", () => l.void(r)],
      ["second refund", () => l.refund(1n)],
    ]);
    expect(refused).toEqual(["void", "second refund"]);
  });

  it("M1: a void that would leave negative capital is refused; the forfeiture itself can be voided", () => {
    const l = new Ledger($(100_000));
    let cash = "";
    let forfeiture = "";
    const refused = run(l, [
      ["held", () => (cash = l.receive("2026-11-03", $(40_000)))],
      ["accept", () => l.accept("2026-11-05")],
      ["forfeit", () => (forfeiture = l.forfeit($(20_000)))],
      ["void cash", () => l.void(cash)],
      ["void forfeiture", () => l.void(forfeiture)],
      ["void cash now", () => l.void(cash)],
    ]);
    expect(refused).toEqual(["void cash"]);
  });

  it("refunds follow the remaining receipts", () => {
    expect(
      refundDueFromReceipts([
        {
          kind: "INITIAL",
          amountCents: $(80_000),
          appliedCents: $(40_000),
          unitsIssued: "40.000000",
        },
        {
          kind: "BALANCE",
          amountCents: $(10_000),
          appliedCents: $(10_000),
          unitsIssued: "10.000000",
        },
        {
          kind: "CREDIT",
          amountCents: 0n,
          appliedCents: $(5_000),
          unitsIssued: "5.000000",
        },
      ]),
    ).toBe($(40_000));
  });
});

describe("planVoid messages", () => {
  const row = (
    amount: number,
    applied: number,
    kind: ReceiptKind = "INITIAL",
  ) => ({
    kind,
    amountCents: $(amount),
    appliedCents: $(applied),
    unitsIssued: unitsForAmount($(applied), PRICE, true),
  });

  it("names the split and the refund action", () => {
    const { errors } = planVoid({
      status: "REDUCED",
      receipt: row(80_000, 40_000),
      refundPaidCents: 0n,
      remaining: [],
      memberCapitalAfterCents: 0n,
      memberUnitsAfter: "0.000000",
    });
    expect(errors.map((e) => e.message)).toEqual([
      "This receipt was split when the commitment was accepted ($40,000.00 applied as capital, $40,000.00 to be refunded), so it cannot be voided: the ledger cannot undo part of an acceptance. Record the refund with Record refund when it is paid; any other correction of this receipt needs an administrator to correct the database.",
    ]);
  });

  it("leaves a pending commitment's refund alone", () => {
    expect(
      planVoid({
        status: "PENDING",
        receipt: row(40_000, 0),
        refundPaidCents: 0n,
        remaining: [row(40_000, 0)],
        memberCapitalAfterCents: 0n,
        memberUnitsAfter: "0.000000",
      }),
    ).toEqual({ errors: [], refundDueCents: null });
  });

  it("refuses when the refund already paid exceeds what would remain due", () => {
    const { errors } = planVoid({
      status: "REJECTED",
      receipt: row(40_000, 0),
      refundPaidCents: $(40_000),
      remaining: [],
      memberCapitalAfterCents: 0n,
      memberUnitsAfter: "0.000000",
    });
    expect(errors[0]?.message).toBe(
      "$40,000.00 has already been refunded on this commitment; voiding this receipt would leave only $0.00 to refund, so it cannot be voided.",
    );
  });
});

describe("G1: special receipts cannot be dated in the future", () => {
  const base = {
    status: "ACCEPTED" as const,
    isReplacement: false,
    amountCents: 0n,
    acceptedCents: $(100_000),
    cashAppliedCents: $(40_000),
    receivedOn: "2026-11-13",
    today: "2026-11-12",
    memberCapitalCents: $(40_000),
  };
  it("refuses a future credit and forfeiture", () => {
    expect(
      validateSpecialReceipt({
        ...base,
        kind: "CREDIT",
        appliedCents: $(1_000),
      }).map((e) => e.code),
    ).toEqual(["DATE_ORDER"]);
    expect(
      validateSpecialReceipt({
        ...base,
        kind: "FORFEITURE",
        appliedCents: -$(1_000),
      }).map((e) => e.code),
    ).toEqual(["DATE_ORDER"]);
  });
  it("accepts them dated today", () => {
    expect(
      validateSpecialReceipt({
        ...base,
        receivedOn: "2026-11-12",
        kind: "CREDIT",
        appliedCents: $(1_000),
      }),
    ).toEqual([]);
  });
});
