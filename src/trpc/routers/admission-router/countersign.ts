import { TRPCError } from "@trpc/server";
import { formatCents } from "@/lib/money";
import type {
  PrismaTransactionalClient,
  TPrismaOrTransaction,
} from "@/server/db";
import { guardedUpdate } from "@/server/guarded-write";
import { MANAGER_ROLE } from "@/server/llc/admission";
import { sumUnits } from "@/server/llc/receipt-rules";
import { trimUnits, unitsToWire } from "@/server/llc/serialize";

// The Manager's countersignature of an Exhibit B packet (01-foundation.md
// F13, B23): the ledger figures printed on it, and the Manager recipient row
// a signing link names.

export const LEDGER_CHANGED_SINCE_PREPARE =
  "The ledger changed since this document was prepared. Go back to the subscription and prepare the countersignature again.";

export const MANAGER_ALREADY_SIGNED =
  "The Manager has already countersigned; the signer can no longer be changed.";

/** Contribution received and units issued on the commitment, from the ledger. */
export async function ledgerFigures(
  db: TPrismaOrTransaction,
  companyId: string,
  commitmentId: string,
): Promise<{ receivedCents: bigint; units: string }> {
  const receipts = await db.capitalReceipt.findMany({
    where: { companyId, commitmentId, voidedAt: null },
    select: { appliedCents: true, unitsIssued: true },
  });
  return {
    receivedCents: receipts.reduce((sum, r) => sum + r.appliedCents, 0n),
    units: sumUnits(receipts.map((r) => unitsToWire(r.unitsIssued))),
  };
}

/** What `prepareCountersign` writes on the two ledger lines. */
export function ledgerLineValues(figures: {
  receivedCents: bigint;
  units: string;
}): { contribution_received: string; units_issued: string } {
  return {
    contribution_received: formatCents(figures.receivedCents),
    units_issued: trimUnits(figures.units),
  };
}

/**
 * Called by `template.sign` for the Manager of a SUBSCRIPTION packet, under
 * the company / unit-class locks and the template lock: the figures on the
 * Manager's ledger lines must still be what the ledger says, else CONFLICT
 * (the Manager prepares the countersignature again).
 */
export async function assertCountersignFiguresCurrent(
  tx: PrismaTransactionalClient,
  input: {
    companyId: string;
    commitmentId: string | null;
    managerRecipientId: string;
    fields: {
      recipientId: string;
      semanticKey: string | null;
      prefilledValue: string | null;
    }[];
  },
): Promise<void> {
  const changed = () =>
    new TRPCError({ code: "CONFLICT", message: LEDGER_CHANGED_SINCE_PREPARE });
  if (input.commitmentId === null) throw changed();
  const commitment = await tx.commitment.findFirst({
    where: { id: input.commitmentId, companyId: input.companyId },
    select: { status: true },
  });
  if (commitment?.status !== "ACCEPTED" && commitment?.status !== "REDUCED") {
    throw changed();
  }
  const expected = ledgerLineValues(
    await ledgerFigures(tx, input.companyId, input.commitmentId),
  );
  for (const key of ["contribution_received", "units_issued"] as const) {
    const lines = input.fields.filter(
      (f) =>
        f.recipientId === input.managerRecipientId && f.semanticKey === key,
    );
    if (
      lines.length === 0 ||
      lines.some((f) => f.prefilledValue !== expected[key])
    ) {
      throw changed();
    }
  }
}

/**
 * Replaces the packet's Manager recipient row with a new one (new id) and
 * moves the Manager's fields onto it, so a signing link naming the old row
 * can never match again. Used on reassignment and on every
 * `prepareCountersign` (which makes each prepare's link the only live one).
 * Role and signing order are kept; the old row is deleted (Prisma's
 * emulated SetNull detaches its e-sign audit rows). Must run under the
 * template lock. Refuses when the Manager has already signed.
 */
export async function replaceManagerRecipient(
  tx: PrismaTransactionalClient,
  input: {
    templateId: string;
    old: { id: string; signingOrder: number | null };
    next: {
      memberId: string;
      name: string;
      email: string;
      status: "PENDING" | "SENT";
    };
  },
): Promise<{ id: string }> {
  const created = await tx.esignRecipient.create({
    data: {
      templateId: input.templateId,
      role: MANAGER_ROLE,
      signingOrder: input.old.signingOrder ?? 2,
      memberId: input.next.memberId,
      name: input.next.name,
      email: input.next.email,
      status: input.next.status,
    },
    select: { id: true },
  });
  // Under the template lock nothing else writes these fields; the move must
  // happen before the delete, which would cascade to them.
  await tx.templateField.updateMany({
    where: { templateId: input.templateId, recipientId: input.old.id },
    data: { recipientId: created.id },
  });
  const removed = await guardedUpdate(() =>
    tx.esignRecipient.delete({
      where: {
        id: input.old.id,
        templateId: input.templateId,
        status: { in: ["PENDING", "SENT"] },
      },
      select: { id: true },
    }),
  );
  if (removed === null) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: MANAGER_ALREADY_SIGNED,
    });
  }
  return created;
}
