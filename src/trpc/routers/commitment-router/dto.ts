/**
 * Wire shapes of the commitments and receipts ledger (F6). Pure and
 * relative-import only so it can be unit tested: cents become `number`,
 * units 6-dp strings, calendar dates `YYYY-MM-DD`. The per-commitment
 * figures use the same pure rule functions as the services.
 */
import type {
  AccreditationBasisEnum,
  CapitalReceiptKindEnum,
  CommitmentStatusEnum,
} from "@prisma/client";
import {
  defaultKeepCents,
  outstandingBalanceCents,
  requiredInitialInstallmentCents,
} from "../../../lib/admission/commitment-rules";
import { centsToNumber } from "../../../lib/money";
import { sumCashApplied, sumUnits } from "../../../server/llc/receipt-rules";
import { dateToWire, unitsToWire } from "../../../server/llc/serialize";

export type ReceiptDTO = {
  id: string;
  commitmentId: string;
  stakeholderId: string;
  kind: CapitalReceiptKindEnum;
  receivedOn: string;
  amountCents: number;
  appliedCents: number;
  unitsIssued: string;
  appliedOn: string | null;
  prefReturnStartDate: string | null;
  reference: string | null;
  note: string | null;
  voided: boolean;
  voidReason: string | null;
  createdAt: string;
};

export type CommitmentDTO = {
  id: string;
  stakeholderId: string;
  stakeholderName: string;
  unitClassId: string;
  status: CommitmentStatusEnum;
  committedCents: number;
  acceptedCents: number;
  heldCents: number;
  cashAppliedCents: number;
  capitalCents: number;
  units: string;
  outstandingBalanceCents: number;
  signedOn: string | null;
  acceptedOn: string | null;
  investmentSummaryDate: string | null;
  accreditationBasis: AccreditationBasisEnum | null;
  minimumWaived: boolean;
  minimumWaiverNote: string | null;
  isReplacement: boolean;
  acceptanceDeadline: string | null;
  effectiveDecisionDeadline: string | null;
  decisionOverdue: boolean;
  refundDueCents: number;
  refundDueBy: string | null;
  refundPaidCents: number;
  refundOutstandingCents: number;
  rejectionReason: string | null;
  notes: string | null;
  packetPublicId: string | null;
  requiredInitialCents: number;
  defaultKeepCents: number;
  receipts: ReceiptDTO[];
};

/** The receipt columns the DTO reads (a Prisma `CapitalReceipt` fits). */
export type ReceiptRow = {
  id: string;
  commitmentId: string;
  stakeholderId: string;
  kind: CapitalReceiptKindEnum;
  receivedOn: Date;
  amountCents: bigint;
  appliedCents: bigint;
  unitsIssued: { toFixed(n: number): string };
  appliedOn: Date | null;
  prefReturnStartDate: Date | null;
  reference: string | null;
  note: string | null;
  voidedAt: Date | null;
  voidReason: string | null;
  createdAt: Date;
};

/** The commitment columns and relations the DTO reads. */
export type CommitmentRow = {
  id: string;
  stakeholderId: string;
  unitClassId: string;
  status: CommitmentStatusEnum;
  committedCents: bigint;
  acceptedCents: bigint;
  signedOn: Date | null;
  acceptedOn: Date | null;
  investmentSummaryDate: Date | null;
  accreditationBasis: AccreditationBasisEnum | null;
  minimumWaived: boolean;
  minimumWaiverNote: string | null;
  isReplacement: boolean;
  acceptanceDeadline: Date | null;
  refundDueCents: bigint;
  refundDueBy: Date | null;
  refundPaidCents: bigint;
  rejectionReason: string | null;
  notes: string | null;
  stakeholder: { name: string };
  unitClass: { initialInstallmentBps: number; finalClosingDate: Date | null };
  packet: { publicId: string } | null;
  /** All receipts, voided ones included (they are listed, not counted). */
  receipts: ReceiptRow[];
};

function byReceivedOnThenCreated(a: ReceiptRow, b: ReceiptRow): number {
  const d = a.receivedOn.getTime() - b.receivedOn.getTime();
  if (d !== 0) return d;
  const c = a.createdAt.getTime() - b.createdAt.getTime();
  if (c !== 0) return c;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function toReceiptDTO(r: ReceiptRow): ReceiptDTO {
  return {
    id: r.id,
    commitmentId: r.commitmentId,
    stakeholderId: r.stakeholderId,
    kind: r.kind,
    receivedOn: r.receivedOn.toISOString().slice(0, 10),
    amountCents: centsToNumber(r.amountCents),
    appliedCents: centsToNumber(r.appliedCents),
    unitsIssued: unitsToWire(r.unitsIssued),
    appliedOn: dateToWire(r.appliedOn),
    prefReturnStartDate: dateToWire(r.prefReturnStartDate),
    reference: r.reference,
    note: r.note,
    voided: r.voidedAt !== null,
    voidReason: r.voidReason,
    createdAt: r.createdAt.toISOString(),
  };
}

/** `today` is the company's calendar date (`todayInTimeZone`). */
export function toCommitmentDTO(
  c: CommitmentRow,
  today: string,
): CommitmentDTO {
  const live = c.receipts.filter((r) => r.voidedAt === null);
  const received = live.reduce((sum, r) => sum + r.amountCents, 0n);
  const held = c.status === "PENDING" ? received : 0n;
  const cashApplied = sumCashApplied(live);
  const capital = live.reduce((sum, r) => sum + r.appliedCents, 0n);
  const units = sumUnits(live.map((r) => unitsToWire(r.unitsIssued)));

  const acceptanceDeadline = dateToWire(c.acceptanceDeadline);
  const finalClosingDate = dateToWire(c.unitClass.finalClosingDate);
  const effectiveDecisionDeadline =
    acceptanceDeadline === null
      ? null
      : finalClosingDate !== null && finalClosingDate < acceptanceDeadline
        ? finalClosingDate
        : acceptanceDeadline;
  const refundOutstanding = c.refundDueCents - c.refundPaidCents;

  return {
    id: c.id,
    stakeholderId: c.stakeholderId,
    stakeholderName: c.stakeholder.name,
    unitClassId: c.unitClassId,
    status: c.status,
    committedCents: centsToNumber(c.committedCents),
    acceptedCents: centsToNumber(c.acceptedCents),
    heldCents: centsToNumber(held),
    cashAppliedCents: centsToNumber(cashApplied),
    capitalCents: centsToNumber(capital),
    units,
    outstandingBalanceCents: centsToNumber(
      outstandingBalanceCents(c.acceptedCents, cashApplied),
    ),
    signedOn: dateToWire(c.signedOn),
    acceptedOn: dateToWire(c.acceptedOn),
    investmentSummaryDate: dateToWire(c.investmentSummaryDate),
    accreditationBasis: c.accreditationBasis,
    minimumWaived: c.minimumWaived,
    minimumWaiverNote: c.minimumWaiverNote,
    isReplacement: c.isReplacement,
    acceptanceDeadline,
    effectiveDecisionDeadline,
    decisionOverdue:
      c.status === "PENDING" &&
      effectiveDecisionDeadline !== null &&
      today > effectiveDecisionDeadline,
    refundDueCents: centsToNumber(c.refundDueCents),
    refundDueBy: dateToWire(c.refundDueBy),
    refundPaidCents: centsToNumber(c.refundPaidCents),
    refundOutstandingCents: centsToNumber(
      refundOutstanding > 0n ? refundOutstanding : 0n,
    ),
    rejectionReason: c.rejectionReason,
    notes: c.notes,
    packetPublicId: c.packet?.publicId ?? null,
    requiredInitialCents: centsToNumber(
      requiredInitialInstallmentCents(
        c.committedCents,
        c.unitClass.initialInstallmentBps,
      ),
    ),
    defaultKeepCents: centsToNumber(
      c.committedCents > 0n
        ? defaultKeepCents({
            heldCents: held,
            acceptedCents: c.committedCents,
            committedCents: c.committedCents,
          })
        : 0n,
    ),
    receipts: [...c.receipts].sort(byReceivedOnThenCreated).map(toReceiptDTO),
  };
}
