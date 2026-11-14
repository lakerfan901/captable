import "server-only";
import { fromDateOnly, toDateOnly } from "@/lib/date-only";
import {
  fiscalYearBounds,
  holderIdsFromSnapshots,
  holdingCheckDates,
  type K1Coverage,
  k1Coverage,
} from "@/lib/governance/k1-coverage";
import type {
  PrismaTransactionalClient,
  TPrismaOrTransaction,
} from "@/server/db";
import { getMemberPositions } from "@/server/llc/positions";
import { guardedWrite } from "./guarded";

// K-1 delivery coverage of a fiscal year (03-governance.md R25 "Schedule K-1
// to each Member", R22a Financial-Interest-only holders). The rule and its
// pure parts are in src/lib/governance/k1-coverage.ts.
//
// "Delivered" = the K-1 email was accepted by the mail server: a recipient
// row of a SENT TAX_K1 report of the year with `sentAt` set (stamped by the
// `governance.report-email` job). A recipient whose email is only queued
// does not count, so the deadlines close from that job, once the last
// holder's email has gone out.
//
// Read only, except `completeK1DeadlinesIfCovered`, which a caller runs
// inside its own transaction AFTER taking ECONOMICS' company ledger lock and
// the unit-class locks (`lockCompanyLedgerAndUnitClasses`; then, in the
// report procedures, the report lock), so concurrent completions of the same
// company are serialised and each sees the others' writes.

export const K1_RULE_KEYS = ["K1_TARGET", "K1_FINAL"] as const;

export function k1DedupeKeys(fiscalYear: number): string[] {
  return K1_RULE_KEYS.map((k) => `${k}:${fiscalYear}`);
}

/** The holders that need a K-1 for `fiscalYear` and which of them already have one. */
export async function loadK1Coverage(
  tx: TPrismaOrTransaction,
  companyId: string,
  fiscalYear: number,
): Promise<K1Coverage> {
  const { start, end } = fiscalYearBounds(fiscalYear);
  const from = fromDateOnly(start);
  const to = fromDateOnly(end);
  const [receipts, transfers] = await Promise.all([
    tx.capitalReceipt.findMany({
      where: {
        companyId,
        OR: [
          { receivedOn: { gte: from, lte: to } },
          { appliedOn: { gte: from, lte: to } },
        ],
      },
      select: { receivedOn: true, appliedOn: true },
    }),
    tx.unitTransfer.findMany({
      where: {
        companyId,
        status: "COMPLETED",
        effectiveOn: { gte: from, lte: to },
      },
      select: { effectiveOn: true },
    }),
  ]);
  const ledgerDates: string[] = [];
  for (const r of receipts) {
    ledgerDates.push(toDateOnly(r.receivedOn));
    if (r.appliedOn) ledgerDates.push(toDateOnly(r.appliedOn));
  }
  for (const t of transfers) {
    if (t.effectiveOn) ledgerDates.push(toDateOnly(t.effectiveOn));
  }
  const snapshots = [];
  for (const asOf of holdingCheckDates(fiscalYear, ledgerDates)) {
    snapshots.push(await getMemberPositions(tx, companyId, { asOf }));
  }
  const ids = [...holderIdsFromSnapshots(snapshots)];
  const holders =
    ids.length === 0
      ? []
      : await tx.stakeholder.findMany({
          where: {
            id: { in: ids },
            companyId,
            memberStatus: { not: "PROSPECT" },
          },
          select: { id: true, name: true },
        });
  const recipients = await tx.memberReportRecipient.findMany({
    where: {
      companyId,
      report: { companyId, type: "TAX_K1", status: "SENT", fiscalYear },
    },
    select: { stakeholderId: true, sentAt: true },
  });
  return k1Coverage(
    fiscalYear,
    holders.map((h) => ({ stakeholderId: h.id, name: h.name })),
    new Set(
      recipients.flatMap((r) => (r.sentAt !== null ? [r.stakeholderId] : [])),
    ),
    new Set(recipients.map((r) => r.stakeholderId)),
  );
}

/**
 * Marks the OPEN `K1_TARGET:{fy}` / `K1_FINAL:{fy}` rows DONE (satisfied by
 * `reportId`) when, and only when, the year's coverage is complete. One
 * guarded single-row update each. Returns the coverage and the keys closed.
 */
export async function completeK1DeadlinesIfCovered(
  tx: PrismaTransactionalClient,
  input: {
    companyId: string;
    fiscalYear: number;
    reportId: string;
    memberId: string | null;
    now: Date;
  },
): Promise<{ coverage: K1Coverage; done: string[] }> {
  const coverage = await loadK1Coverage(tx, input.companyId, input.fiscalYear);
  const done: string[] = [];
  if (!coverage.complete) return { coverage, done };
  const open = await tx.complianceDeadline.findMany({
    where: {
      companyId: input.companyId,
      status: "OPEN",
      dedupeKey: { in: k1DedupeKeys(input.fiscalYear) },
    },
    select: { id: true, dedupeKey: true },
  });
  for (const row of open) {
    const closed = await guardedWrite(() =>
      tx.complianceDeadline.update({
        where: { id: row.id, companyId: input.companyId, status: "OPEN" },
        data: {
          status: "DONE",
          satisfiedByType: "MEMBER_REPORT",
          satisfiedById: input.reportId,
          completedAt: input.now,
          completedById: input.memberId,
        },
        select: { id: true },
      }),
    );
    if (closed) done.push(row.dedupeKey);
  }
  return { coverage, done };
}
