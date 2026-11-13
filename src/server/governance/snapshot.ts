import "server-only";
import type { RecordSnapshot, RecordSnapshotPurposeEnum } from "@prisma/client";
import { utcDateToYmd, type Ymd, ymdToUtcDate } from "@/lib/governance/dates";
import {
  buildSnapshotEntries,
  type SnapshotEntryDraft,
} from "@/lib/governance/resolution-core";
import type {
  PrismaTransactionalClient,
  TPrismaOrTransaction,
} from "@/server/db";
import { lockCompanyLedgerAndUnitClasses } from "@/server/llc/economics/scope";
import {
  loadUnitPositionsWithWarnings,
  type UndeclaredOverdueWarning,
} from "./positions";

// Frozen register of holders (03-governance.md G6, C3.1). RecordSnapshot and
// RecordSnapshotEntry are INSERT ONLY: this module has no update or delete.

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface SnapshotDraft {
  recordDate: Ymd;
  entries: SnapshotEntryDraft[];
  preferredIssued: string;
  preferredOutstanding: string;
  disinterestedOutstanding: string;
  warnings: UndeclaredOverdueWarning[];
}

/**
 * Builds (does NOT store) the register as of `recordDate`: units as of that
 * date (inclusive), Member status / insider flag as they stand now. Used by
 * `resolution.preview` (G7) and by `takeRecordSnapshot`.
 */
export async function buildSnapshotDraft(
  tx: TPrismaOrTransaction,
  companyId: string,
  recordDate: Ymd,
): Promise<SnapshotDraft> {
  if (
    !YMD_RE.test(recordDate) ||
    utcDateToYmd(ymdToUtcDate(recordDate)) !== recordDate
  ) {
    throw new Error(`Invalid record date "${recordDate}"`);
  }
  const stakeholders = await tx.stakeholder.findMany({
    where: { companyId },
    select: {
      id: true,
      name: true,
      email: true,
      noticeEmail: true,
      memberStatus: true,
      isInsider: true,
    },
  });
  const { positions, warnings } = await loadUnitPositionsWithWarnings(
    tx,
    companyId,
    recordDate,
  );
  const built = buildSnapshotEntries(stakeholders, positions);
  return { recordDate, ...built, warnings };
}

/**
 * Freezes the register (C3.1: insert only). Must run inside the caller's
 * transaction.
 *
 * Member status and units are two reads (`buildSnapshotDraft`); an admission
 * (FOUNDATION `decideCommitment` / `issueCommonUnits`: units and
 * PROSPECT → MEMBER in one transaction, under the unit-class row lock)
 * committing between them would freeze a holder with units but the status
 * read before (a register whose issued and voting units disagree). So the
 * company ledger lock and the unit-class locks are taken first
 * (`lockCompanyLedgerAndUnitClasses`, the economics order); every admission
 * then waits for this transaction. The caller should already hold them,
 * taken before any other lock (resolution.send does); taking them again in
 * the same transaction is a no-op.
 */
export async function takeRecordSnapshot(
  tx: PrismaTransactionalClient,
  input: {
    companyId: string;
    recordDate: Ymd;
    purpose: RecordSnapshotPurposeEnum;
    takenById: string | null;
  },
): Promise<{
  snapshot: RecordSnapshot;
  entries: SnapshotEntryDraft[];
  warnings: UndeclaredOverdueWarning[];
}> {
  await lockCompanyLedgerAndUnitClasses(tx, input.companyId);
  const draft = await buildSnapshotDraft(tx, input.companyId, input.recordDate);
  const snapshot = await tx.recordSnapshot.create({
    data: {
      companyId: input.companyId,
      purpose: input.purpose,
      recordDate: ymdToUtcDate(input.recordDate),
      takenById: input.takenById,
      preferredIssued: draft.preferredIssued,
      preferredOutstanding: draft.preferredOutstanding,
      disinterestedOutstanding: draft.disinterestedOutstanding,
    },
  });
  if (draft.entries.length > 0) {
    await tx.recordSnapshotEntry.createMany({
      data: draft.entries.map((e) => ({
        snapshotId: snapshot.id,
        companyId: input.companyId,
        stakeholderId: e.stakeholderId,
        name: e.name,
        email: e.email,
        memberStatus: e.memberStatus,
        isMember: e.isMember,
        isInsider: e.isInsider,
        isSuspended: e.isSuspended,
        preferredUnits: e.preferredUnits,
        commonUnits: e.commonUnits,
      })),
    });
  }
  return { snapshot, entries: draft.entries, warnings: draft.warnings };
}
