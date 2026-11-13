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

/** Where a receipt comes from (`CapitalReceipt.sourceType` / `sourceId`). */
export interface ReceiptSource {
  sourceType?: string | null;
  sourceId?: string | null;
}

/**
 * The distribution that created an offset receipt (E15 finalize, step 4),
 * when `source` names one of this company's distributions paid on
 * `appliedOn`; the receipt then sorts immediately after it in the ledger
 * (ledger.logic.ts `assignSeq`). The string is not trusted on its own: the
 * row must exist in the company with that payment date. Recording requires
 * it to be FINALIZED (finalize writes its offsets after the status change);
 * voiding accepts any status, because a reversal marks the distribution
 * REVERSED before it voids the offset receipts.
 */
async function offsetSourceDistribution(
  tx: Tx,
  companyId: string,
  appliedOn: Date,
  source: ReceiptSource,
  requireFinalized: boolean,
): Promise<{ id: string; number: number } | null> {
  if (source.sourceType !== "distribution" || !source.sourceId) return null;
  const row = await tx.distribution.findFirst({
    where: {
      id: source.sourceId,
      companyId,
      isReversal: false,
      paymentDate: appliedOn,
      ...(requireFinalized ? { status: "FINALIZED" as const } : {}),
    },
    select: { id: true, number: true },
  });
  return row && row.number !== null ? { id: row.id, number: row.number } : null;
}

/**
 * A FINALIZED, non-reversal distribution whose computation the receipt would
 * be part of: paid after `appliedOn`, or paid on `appliedOn` and ordered
 * after the receipt. On one date the ledger orders every ordinary entry
 * (receipt, forfeiture, transfer) before the distributions, and each
 * distribution's own offset receipts right after it, so an ordinary receipt
 * sorts before every same-day distribution and an offset receipt only before
 * the same-day distributions numbered after its own.
 */
function distributionDependingOn(
  tx: Tx,
  companyId: string,
  appliedOn: Date,
  own: { number: number } | null,
) {
  return tx.distribution.findFirst({
    where: {
      companyId,
      status: "FINALIZED",
      isReversal: false,
      OR: [
        { paymentDate: { gt: appliedOn } },
        {
          paymentDate: appliedOn,
          ...(own ? { number: { gt: own.number } } : {}),
        },
      ],
    },
    orderBy: [{ paymentDate: "desc" }, { number: "desc" }],
    select: { number: true, paymentDate: true },
  });
}

async function memberName(
  tx: Tx,
  companyId: string,
  stakeholderId: string,
): Promise<string> {
  const s = await tx.stakeholder.findFirst({
    where: { id: stakeholderId, companyId },
    select: { name: true },
  });
  return s?.name ?? "a member";
}

/** The receipt (or capital lot) a dated change belongs to. */
export interface ReceiptRef {
  stakeholderId: string;
  unitClassId: string;
}

/**
 * Why a change to the ledger effective on `on` (a receipt applied, voided,
 * or a lot's Preferred Return start moved) would alter figures that were
 * already frozen, other than by a finalized distribution; null when nothing
 * stands in the way:
 * - the books are closed through `on` or later (a member report or a
 *   distribution closed them, `closeBooksThrough`), unless the change is a
 *   distribution's own offset receipt (`ownOffset`): it is part of the
 *   distribution that closes them;
 * - Preferred class only: a confirmed forfeiture of the same holder effective
 *   on or after `on` (its capital deduction, extinguished return and units
 *   were computed from that holder's position on the Forfeiture Date). A
 *   distribution's own offset receipt sorts after every ordinary entry of its
 *   date, so for it only a later Forfeiture Date counts;
 * - Preferred class only, when units change (`unitsChange`): a confirmed
 *   credit whose due date is on or after `on` (its clause (B) shares were
 *   allocated on the Preferred Units held on that due date).
 */
export async function frozenFiguresBlocker(
  tx: Tx,
  companyId: string,
  on: IsoDate,
  opts: { ownOffset: boolean; ref?: ReceiptRef; unitsChange: boolean },
): Promise<string | null> {
  if (!opts.ownOffset) {
    const term = await tx.llcTerm.findUnique({
      where: { companyId },
      select: { booksClosedThrough: true },
    });
    const closed =
      term?.booksClosedThrough != null
        ? toDateOnly(term.booksClosedThrough)
        : null;
    if (closed !== null && on <= closed) {
      return `Books are closed through ${formatDateOnly(closed)}, so nothing can be recorded effective ${formatDateOnly(on)}. Reopen them on the Term clock settings page first.`;
    }
  }
  if (!opts.ref) return null;
  const unitClass = await tx.unitClass.findFirst({
    where: { id: opts.ref.unitClassId, companyId },
    select: { kind: true },
  });
  if (unitClass?.kind !== "PREFERRED") return null;
  const date = fromDateOnly(on);
  const forfeiture = await tx.memberDefault.findFirst({
    where: {
      companyId,
      stakeholderId: opts.ref.stakeholderId,
      status: { not: "VOIDED" },
      forfeitureConfirmedAt: { not: null },
      forfeitedOn: opts.ownOffset ? { gt: date } : { gte: date },
    },
    orderBy: { forfeitedOn: "desc" },
    select: { forfeitedOn: true, stakeholderId: true },
  });
  if (forfeiture?.forfeitedOn) {
    return `The forfeiture of ${await memberName(tx, companyId, forfeiture.stakeholderId)}'s default was confirmed effective ${formatDateOnly(toDateOnly(forfeiture.forfeitedOn))}, computed on that member's position on that date; an entry effective ${formatDateOnly(on)} would change it (Section 4.9(iv)). Date it after ${formatDateOnly(toDateOnly(forfeiture.forfeitedOn))}.`;
  }
  if (!opts.unitsChange) return null;
  const credit = await tx.memberDefault.findFirst({
    where: {
      companyId,
      status: { not: "VOIDED" },
      creditConfirmedAt: { not: null },
      dueOn: { gte: date },
    },
    orderBy: { dueOn: "desc" },
    select: { dueOn: true, stakeholderId: true },
  });
  if (credit) {
    return `The Section 4.9(iv) credit of ${await memberName(tx, companyId, credit.stakeholderId)}'s default was allocated on the Preferred Units held on its due date ${formatDateOnly(toDateOnly(credit.dueOn))}; an entry effective ${formatDateOnly(on)} would change them. Date it after ${formatDateOnly(toDateOnly(credit.dueOn))}.`;
  }
  return null;
}

/**
 * Why a receipt applied on `appliedOn` cannot be recorded, or null:
 * a FINALIZED, non-reversal distribution paid on or after that date (same
 * rule as `assertLedgerDateOpen`, term.ts: the receipt would sort before that
 * distribution and silently change the positions it was computed on; the
 * only receipts allowed on a payment date are the offset receipts the
 * distribution itself writes while it is being finalized, `sourceType:
 * "distribution"`, `sourceId` = its id), then `frozenFiguresBlocker`.
 */
export async function receiptDateBlocker(
  tx: Tx,
  companyId: string,
  appliedOn: IsoDate,
  source: ReceiptSource = {},
  ref?: ReceiptRef,
  opts: { unitsChange?: boolean } = {},
): Promise<string | null> {
  const on = fromDateOnly(appliedOn);
  const own = await offsetSourceDistribution(tx, companyId, on, source, true);
  const later = await distributionDependingOn(tx, companyId, on, own);
  if (later) {
    const paidOn = toDateOnly(later.paymentDate);
    const no = later.number === null ? "" : `No. ${later.number} `;
    return paidOn === appliedOn
      ? `Distribution ${no}was paid on ${formatDateOnly(paidOn)}, the date this receipt takes effect; it would change the positions that distribution was computed on. Reverse it first, or record the receipt dated after ${formatDateOnly(paidOn)}.`
      : `Distribution ${no}was paid on ${formatDateOnly(paidOn)}, after ${formatDateOnly(appliedOn)}. Reverse it before recording anything dated on or before its payment date.`;
  }
  return frozenFiguresBlocker(tx, companyId, appliedOn, {
    ownOffset: own !== null,
    ref,
    unitsChange: opts.unitsChange ?? true,
  });
}

/**
 * Rejects a receipt (or Common issuance, or acceptance applying held money)
 * effective on `appliedOn` when `receiptDateBlocker` names a reason.
 */
export async function assertLedgerDateOpenForReceipt(
  tx: Tx,
  companyId: string,
  appliedOn: IsoDate,
  source: ReceiptSource = {},
  ref?: ReceiptRef,
  opts: { unitsChange?: boolean } = {},
): Promise<void> {
  const blocked = await receiptDateBlocker(
    tx,
    companyId,
    appliedOn,
    source,
    ref,
    opts,
  );
  if (blocked !== null) ruleViolation(blocked);
}

/**
 * Runs before FOUNDATION voids a receipt. Refuses when a finalized
 * distribution was computed on positions that include the receipt (paid
 * after it took effect, or paid that day and ordered after it), or when the
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
    select: {
      id: true,
      appliedOn: true,
      sourceType: true,
      sourceId: true,
      stakeholderId: true,
      unitClassId: true,
    },
  });
  if (!receipt) return; // FOUNDATION has already loaded it under the lock.

  // (a) Refuse while a finalized distribution was computed on positions that
  // include this receipt (paid after it took effect, or paid that day and
  // ordered after it). A distribution paid the same day but ordered before
  // the receipt did not depend on it: in particular, reversing the latest of
  // two same-day distributions voids its own offset receipts, which sort
  // after the earlier one. A held receipt (appliedOn null) never reached a
  // distribution.
  if (receipt.appliedOn !== null) {
    const own = await offsetSourceDistribution(
      tx,
      companyId,
      receipt.appliedOn,
      receipt,
      false,
    );
    const later = await distributionDependingOn(
      tx,
      companyId,
      receipt.appliedOn,
      own,
    );
    if (later) {
      ruleViolation(
        `Reverse distribution No. ${later.number ?? ""} first: it was paid on ${formatDateOnly(toDateOnly(later.paymentDate))} and computed on positions that include this receipt (effective ${formatDateOnly(toDateOnly(receipt.appliedOn))}).`,
      );
    }
    // Closed books, and a confirmed forfeiture or credit computed on
    // positions that include this receipt.
    const frozen = await frozenFiguresBlocker(
      tx,
      companyId,
      toDateOnly(receipt.appliedOn),
      {
        ownOffset: own !== null,
        ref: {
          stakeholderId: receipt.stakeholderId,
          unitClassId: receipt.unitClassId,
        },
        unitsChange: true,
      },
    );
    if (frozen !== null) ruleViolation(frozen);
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
