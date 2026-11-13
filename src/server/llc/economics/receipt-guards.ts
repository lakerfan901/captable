import "server-only";

import { formatDateOnly, fromDateOnly, toDateOnly } from "@/lib/date-only";
import type { IsoDate } from "@/lib/llc/dates";
import type { PrismaTransactionalClient } from "@/server/db";
import { guardedUpdate } from "@/server/guarded-write";
import { ruleViolation } from "./scope";

/*
 * ECONOMICS guards called from inside FOUNDATION's receipt services
 * (`src/server/llc/commitments.ts`). This file must never import
 * `commitments.ts` (import cycle) nor `call-notices.ts` (which imports
 * `commitments.ts`), and must not take `lockCompanyLedger`: the guards run
 * inside FOUNDATION's unit-class row lock, and economics flows take the
 * advisory lock first and the unit-class lock second, so taking the advisory
 * lock here would invert that order and can deadlock.
 */

type Tx = PrismaTransactionalClient;

/**
 * Same rule as `assertLedgerDateOpen` (term.ts), re-implemented here: rejects
 * a receipt applied before the payment date of a FINALIZED, non-reversal
 * distribution (the same day is allowed: E15 records offset receipts on the
 * payment date).
 */
export async function assertLedgerDateOpenForReceipt(
  tx: Tx,
  companyId: string,
  appliedOn: IsoDate,
): Promise<void> {
  const later = await tx.distribution.findFirst({
    where: {
      companyId,
      status: "FINALIZED",
      isReversal: false,
      paymentDate: { gt: fromDateOnly(appliedOn) },
    },
    orderBy: { paymentDate: "desc" },
    select: { number: true, paymentDate: true },
  });
  if (later) {
    ruleViolation(
      `Distribution ${later.number === null ? "" : `No. ${later.number} `}was paid on ${formatDateOnly(toDateOnly(later.paymentDate))}, after ${formatDateOnly(appliedOn)}. Reverse it before recording anything dated earlier.`,
    );
  }
}

/**
 * Runs before FOUNDATION voids a receipt. Refuses when a finalized
 * distribution was paid on or after the receipt took effect, or when the
 * receipt belongs to a default (funding, credit, forfeiture or a payment
 * that has not been reversed). Otherwise writes a negating
 * `CallNoticeAllocation` for every allocation of the receipt that is still
 * in force and re-opens the affected lines and notices.
 */
export async function beforeVoidReceipt(
  tx: Tx,
  companyId: string,
  receiptId: string,
  actorMemberId: string | null,
): Promise<void> {
  const receipt = await tx.capitalReceipt.findFirst({
    where: { id: receiptId, companyId },
    select: { id: true, appliedOn: true },
  });
  if (!receipt) return; // FOUNDATION has already loaded it under the lock.

  // (a) A held receipt (appliedOn null) never reached a distribution.
  if (receipt.appliedOn !== null) {
    const later = await tx.distribution.findFirst({
      where: {
        companyId,
        status: "FINALIZED",
        isReversal: false,
        paymentDate: { gte: receipt.appliedOn },
      },
      orderBy: { paymentDate: "desc" },
      select: { number: true, paymentDate: true },
    });
    if (later) {
      ruleViolation(
        `Reverse distribution No. ${later.number ?? ""} first: it was paid on ${formatDateOnly(toDateOnly(later.paymentDate))}, on or after ${formatDateOnly(toDateOnly(receipt.appliedOn))}, when this receipt took effect.`,
      );
    }
  }

  // (b) Receipts that belong to the default workflow are corrected there.
  const funding = await tx.memberDefaultFunding.findFirst({
    where: { companyId, capitalReceiptId: receiptId },
    select: { id: true },
  });
  const credit = await tx.memberDefaultCredit.findFirst({
    where: { companyId, capitalReceiptId: receiptId },
    select: { id: true },
  });
  const forfeiture = await tx.memberDefault.findFirst({
    where: { companyId, forfeitureReceiptId: receiptId },
    select: { id: true },
  });
  const payments = await tx.memberDefaultPayment.findMany({
    where: { companyId, capitalReceiptId: receiptId, reversesPaymentId: null },
    select: { id: true },
  });
  let openPayment = false;
  if (payments.length > 0) {
    const reversals = await tx.memberDefaultPayment.findMany({
      where: {
        companyId,
        reversesPaymentId: { in: payments.map((p) => p.id) },
      },
      select: { reversesPaymentId: true },
    });
    const reversed = new Set(reversals.map((r) => r.reversesPaymentId));
    openPayment = payments.some((p) => !reversed.has(p.id));
  }
  if (funding || credit || forfeiture || openPayment) {
    ruleViolation(
      "This receipt belongs to a default; it cannot be voided here (Section 4.9).",
    );
  }

  // Negate every allocation still in force (allocations are immutable).
  const rows = await tx.callNoticeAllocation.findMany({
    where: { companyId, capitalReceiptId: receiptId },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  const alreadyReversed = new Set(
    rows
      .map((r) => r.reversesAllocationId)
      .filter((id): id is string => id !== null),
  );
  const inForce = rows.filter(
    (r) =>
      r.reversesAllocationId === null &&
      r.amountCents > 0n &&
      !alreadyReversed.has(r.id),
  );
  if (inForce.length === 0) return;

  for (const row of inForce) {
    await tx.callNoticeAllocation.create({
      data: {
        companyId,
        callNoticeLineId: row.callNoticeLineId,
        capitalReceiptId: row.capitalReceiptId,
        amountCents: -row.amountCents,
        receivedOn: row.receivedOn,
        prefReturnStartOn: row.prefReturnStartOn,
        source: row.source,
        reversesAllocationId: row.id,
        createdById: actorMemberId ?? row.createdById,
      },
    });
  }

  // Re-open PAID lines and SETTLED notices. One guarded `update` per row, not
  // `updateMany`: the call-notice writers hold the company advisory lock, not
  // the unit-class lock held here, and `updateMany` drops its status filter
  // from the UPDATE (guarded-write.ts). A row whose status changed meanwhile
  // is left as it is.
  const lineIds = [...new Set(inForce.map((r) => r.callNoticeLineId))];
  const paidLines = await tx.callNoticeLine.findMany({
    where: { companyId, id: { in: lineIds }, status: "PAID" },
    select: { id: true },
  });
  for (const { id } of paidLines) {
    await guardedUpdate(() =>
      tx.callNoticeLine.update({
        where: { id, companyId, status: "PAID" },
        data: { status: "SENT", paidInFullOn: null },
        select: { id: true },
      }),
    );
  }
  const lines = await tx.callNoticeLine.findMany({
    where: { companyId, id: { in: lineIds } },
    select: { callNoticeId: true },
  });
  const settled = await tx.callNotice.findMany({
    where: {
      companyId,
      id: { in: [...new Set(lines.map((l) => l.callNoticeId))] },
      status: "SETTLED",
    },
    select: { id: true },
  });
  for (const { id } of settled) {
    await guardedUpdate(() =>
      tx.callNotice.update({
        where: { id, companyId, status: "SETTLED" },
        data: { status: "SENT" },
        select: { id: true },
      }),
    );
  }
}
