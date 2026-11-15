import "server-only";

import { fromDateOnly, toDateOnly } from "@/lib/date-only";
import type { IsoDate } from "@/lib/llc/dates";
import {
  cutAtPublishedThrough,
  type MonthKey,
  monthOf,
  publishedThrough,
} from "@/lib/llc/financial-periods";
import {
  canonicalJson,
  type FundMonth,
  FundMonthJsonSchema,
  fundMonthFromJson,
  type HolderMonth,
  holderMonthFromJson,
} from "@/lib/llc/financial-series";
import {
  type ReportHolder,
  visibleReportWhere,
} from "@/lib/portal/report-visibility-core";
import type { TPrismaOrTransaction } from "@/server/db";
import { sha256Hex } from "@/server/governance/hash";

// Reading the financial snapshots (04-investor-portal.md P33–P36, 5.9;
// package P13a). The dashboard reads only these rows (P34): never the live
// ledger. This module imports nothing from `@/server/llc/economics`, so the
// portal procedures (P13b `portal.financials.get`) may import it (S26); the
// writes are in `./financial-snapshot-write`.
//
// "Current" rows are the rows with `supersededAt` null: exactly one fund row
// per month and at most one row per holder and month (the writers take the
// company ledger lock, `lockCompanyLedger`, before writing).

type Tx = TPrismaOrTransaction;

/** The company's latest month with a current fund snapshot, or null. */
export async function latestSnapshotMonth(
  tx: Tx,
  companyId: string,
): Promise<MonthKey | null> {
  const row = await tx.financialSnapshot.findFirst({
    where: { companyId, supersededAt: null },
    orderBy: { month: "desc" },
    select: { month: true },
  });
  return row ? toDateOnly(row.month) : null;
}

/** The company's earliest month with a current fund snapshot, or null. */
export async function firstSnapshotMonth(
  tx: Tx,
  companyId: string,
): Promise<MonthKey | null> {
  const row = await tx.financialSnapshot.findFirst({
    where: { companyId, supersededAt: null },
    orderBy: { month: "asc" },
    select: { month: true },
  });
  return row ? toDateOnly(row.month) : null;
}

/** `month <= the month of through`; null through: nothing. */
function throughWhere(through: IsoDate) {
  return { lte: fromDateOnly(monthOf(through)) };
}

/**
 * The current fund records of the company for the months whose last day is
 * on or before `through` (P33), oldest first. The stored hash is checked: a
 * row whose data no longer matches it is an error, never shown.
 */
export async function readFundMonths(
  tx: Tx,
  companyId: string,
  opts: { through: IsoDate | null },
): Promise<FundMonth[]> {
  if (opts.through === null) return [];
  const rows = await tx.financialSnapshot.findMany({
    where: {
      companyId,
      supersededAt: null,
      month: throughWhere(opts.through),
    },
    orderBy: { month: "asc" },
    select: { id: true, month: true, data: true, dataHash: true },
  });
  const months = rows.map((r) => {
    const json = FundMonthJsonSchema.parse(r.data);
    if (sha256Hex(canonicalJson(json)) !== r.dataHash) {
      throw new Error(`Financial snapshot ${r.id} does not match its hash`);
    }
    const m = fundMonthFromJson(json);
    if (m.month !== toDateOnly(r.month)) {
      throw new Error(
        `Financial snapshot ${r.id} is stored under another month`,
      );
    }
    return m;
  });
  return cutAtPublishedThrough(months, opts.through);
}

/**
 * One holder's current records for the months whose last day is on or
 * before `through`, oldest first (P36: read by this holder's id only). A
 * month without a row had no position and no movement for the holder.
 */
export async function readHolderMonths(
  tx: Tx,
  holder: ReportHolder,
  opts: { through: IsoDate | null },
): Promise<HolderMonth[]> {
  if (opts.through === null) return [];
  const rows = await tx.holderFinancialSnapshot.findMany({
    where: {
      companyId: holder.companyId,
      stakeholderId: holder.stakeholderId,
      supersededAt: null,
      month: throughWhere(opts.through),
    },
    orderBy: { month: "asc" },
    select: { id: true, month: true, data: true },
  });
  const months = rows.map((r) => {
    const m = holderMonthFromJson(r.data);
    if (
      m.holderId !== holder.stakeholderId ||
      m.month !== toDateOnly(r.month)
    ) {
      throw new Error(`Holder snapshot ${r.id} does not match its row`);
    }
    return m;
  });
  return cutAtPublishedThrough(months, opts.through);
}

export interface Restatement {
  month: MonthKey;
  /** when the current version was written */
  at: Date;
  version: number;
}

/** P35: the months up to `through` whose current fund row is a restatement (version > 1). */
export async function readRestatements(
  tx: Tx,
  companyId: string,
  opts: { through: IsoDate | null },
): Promise<Restatement[]> {
  if (opts.through === null) return [];
  const rows = await tx.financialSnapshot.findMany({
    where: {
      companyId,
      supersededAt: null,
      version: { gt: 1 },
      month: throughWhere(opts.through),
    },
    orderBy: { month: "asc" },
    select: { month: true, frozenAt: true, version: true },
  });
  return cutAtPublishedThrough(
    rows.map((r) => ({
      month: toDateOnly(r.month),
      at: r.frozenAt,
      version: r.version,
    })),
    opts.through,
  );
}

/**
 * P33: the holder's published-through date, the latest period end among the
 * quarterly and annual reports visible to the holder now (P11, through
 * `visibleReportWhere`). Null when there is none. Recomputed on every call:
 * unpublishing a report or removing the holder from it moves it back.
 */
export async function publishedThroughFor(
  tx: Tx,
  holder: ReportHolder,
): Promise<IsoDate | null> {
  const reports = await tx.memberReport.findMany({
    where: {
      ...visibleReportWhere(holder),
      type: { in: ["QUARTERLY", "ANNUAL"] },
    },
    select: { type: true, periodEnd: true },
  });
  return publishedThrough(
    reports.map((r) => ({
      type: r.type,
      periodEnd: r.periodEnd === null ? null : toDateOnly(r.periodEnd),
    })),
  );
}
