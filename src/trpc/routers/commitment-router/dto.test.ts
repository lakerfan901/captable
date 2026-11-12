import { describe, expect, it } from "vitest";
import { type CommitmentRow, type ReceiptRow, toCommitmentDTO } from "./dto";

const d = (s: string) => new Date(`${s}T00:00:00.000Z`);
const units = (s: string) => ({ toFixed: () => s });

function receipt(over: Partial<ReceiptRow>): ReceiptRow {
  return {
    id: "r1",
    commitmentId: "c1",
    stakeholderId: "s1",
    kind: "INITIAL",
    receivedOn: d("2026-11-12"),
    amountCents: 0n,
    appliedCents: 0n,
    unitsIssued: units("0.000000"),
    appliedOn: null,
    prefReturnStartDate: null,
    reference: null,
    note: null,
    voidedAt: null,
    voidReason: null,
    createdAt: new Date("2026-11-12T10:00:00.000Z"),
    ...over,
  };
}

function commitment(over: Partial<CommitmentRow>): CommitmentRow {
  return {
    id: "c1",
    stakeholderId: "s1",
    unitClassId: "u1",
    status: "PENDING",
    committedCents: 25_000_000n,
    acceptedCents: 0n,
    signedOn: d("2026-11-12"),
    acceptedOn: null,
    investmentSummaryDate: null,
    accreditationBasis: null,
    minimumWaived: false,
    minimumWaiverNote: null,
    isReplacement: false,
    acceptanceDeadline: d("2026-11-27"),
    refundDueCents: 0n,
    refundDueBy: null,
    refundPaidCents: 0n,
    rejectionReason: null,
    notes: null,
    stakeholder: { name: "Jane Doe" },
    unitClass: {
      initialInstallmentBps: 4000,
      finalClosingDate: d("2026-11-30"),
    },
    packet: null,
    receipts: [],
    ...over,
  };
}

describe("toCommitmentDTO (F6 worked example)", () => {
  it("pending with $100,000 held", () => {
    const dto = toCommitmentDTO(
      commitment({
        receipts: [receipt({ amountCents: 10_000_000n })],
      }),
      "2026-11-12",
    );
    expect(dto.heldCents).toBe(10_000_000);
    expect(dto.cashAppliedCents).toBe(0);
    expect(dto.units).toBe("0.000000");
    expect(dto.acceptanceDeadline).toBe("2026-11-27");
    expect(dto.effectiveDecisionDeadline).toBe("2026-11-27");
    expect(dto.decisionOverdue).toBe(false);
    expect(dto.requiredInitialCents).toBe(10_000_000);
    expect(dto.defaultKeepCents).toBe(10_000_000);
    expect(dto.receipts[0]?.receivedOn).toBe("2026-11-12");
  });

  it("deadline capped at the Final Closing Date and overdue after it", () => {
    const dto = toCommitmentDTO(
      commitment({ acceptanceDeadline: d("2026-12-07") }),
      "2026-12-01",
    );
    expect(dto.effectiveDecisionDeadline).toBe("2026-11-30");
    expect(dto.decisionOverdue).toBe(true);
  });

  it("accepted in full, then Balance received; voided rows listed, not counted", () => {
    const dto = toCommitmentDTO(
      commitment({
        status: "ACCEPTED",
        acceptedCents: 25_000_000n,
        acceptedOn: d("2026-11-13"),
        receipts: [
          receipt({
            amountCents: 10_000_000n,
            appliedCents: 10_000_000n,
            unitsIssued: units("100.000000"),
            appliedOn: d("2026-11-13"),
            prefReturnStartDate: d("2026-11-12"),
          }),
          receipt({
            id: "r2",
            kind: "BALANCE",
            receivedOn: d("2026-12-15"),
            amountCents: 15_000_000n,
            appliedCents: 15_000_000n,
            unitsIssued: units("150.000000"),
            appliedOn: d("2026-12-15"),
            prefReturnStartDate: d("2027-03-31"),
          }),
          receipt({
            id: "r3",
            kind: "BALANCE",
            receivedOn: d("2026-12-16"),
            amountCents: 100n,
            appliedCents: 100n,
            unitsIssued: units("0.100000"),
            voidedAt: new Date(),
            voidReason: "Entered twice",
          }),
        ],
      }),
      "2026-12-20",
    );
    expect(dto.heldCents).toBe(0);
    expect(dto.cashAppliedCents).toBe(25_000_000);
    expect(dto.capitalCents).toBe(25_000_000);
    expect(dto.units).toBe("250.000000");
    expect(dto.outstandingBalanceCents).toBe(0);
    expect(dto.decisionOverdue).toBe(false);
    expect(dto.receipts.map((r) => r.id)).toEqual(["r1", "r2", "r3"]);
    expect(dto.receipts[1]?.prefReturnStartDate).toBe("2027-03-31");
    expect(dto.receipts[2]?.voided).toBe(true);
  });

  it("refund outstanding and Common issuance (0 cents) do not divide by zero", () => {
    const dto = toCommitmentDTO(
      commitment({
        status: "ACCEPTED",
        committedCents: 0n,
        refundDueCents: 2_000_000n,
        refundPaidCents: 500_000n,
      }),
      "2026-11-20",
    );
    expect(dto.refundOutstandingCents).toBe(1_500_000);
    expect(dto.defaultKeepCents).toBe(0);
    expect(dto.requiredInitialCents).toBe(0);
  });
});
