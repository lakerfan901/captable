import "server-only";

import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { utcDateToYmd } from "@/lib/governance/dates";
import { isInlineContentType } from "@/lib/inline-content-type";
import {
  compareReleasedDesc,
  isPortalExportable,
  type ReportHolder,
  visibleReportWhere,
} from "@/lib/portal/report-visibility-core";
import type { TPrismaOrTransaction } from "@/server/db";
import { readFrozenContent } from "@/trpc/routers/member-report-router/procedures/shared";
import { visibleAttachmentWhere } from "@/trpc/routers/member-report-view-router/access";

// Which member reports a portal holder sees (04-investor-portal.md P11, P12;
// package P5a). The only place the report rule is applied to queries: the
// portal report procedures, P7's export, P9's `holderView` and P13's
// published-through date all go through `visibleReportWhere`.
//
// The holder is always `ctx.holder` of `investorProcedure` (resolved from the
// access row, P10) or, on the team side, a holder already resolved within the
// caller's company. It is a structural type so this module does not import
// the portal procedure base (G5).
//
// A report is looked up together with the rule in one query, so an unknown
// id, a report of another company, a draft, a report sent before the portal,
// an unpublished report and a report without this holder as recipient are
// the same message-less NOT_FOUND (S3).

export type { ReportHolder };
export { visibleReportWhere };

/** A report public id as the portal receives it (never an internal id). */
export const ZPortalReportId = z.string().trim().min(1).max(64);

/** An attachment id of a visible report (as `portal.reports.get` lists it). */
export const ZPortalAttachmentId = z.string().trim().min(1).max(64);

export function reportNotFound(): never {
  throw new TRPCError({ code: "NOT_FOUND" });
}

/** One row of `portal.reports.list` (5.4). Built field by field (G4). */
export interface ReportListItem {
  /** The report's public id. */
  id: string;
  title: string;
  type: string;
  noticeKind: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  releasedAt: Date | null;
  /** The report carries at least one file private to this holder (e.g. a K-1). */
  hasOwnFiles: boolean;
  exportable: boolean;
}

/**
 * The reports visible to the holder, newest release first. The title is the
 * frozen title (never the live draft). A released report whose frozen
 * content cannot be read is left out rather than shown from live columns.
 */
export async function listVisibleReports(
  db: TPrismaOrTransaction,
  holder: ReportHolder,
): Promise<ReportListItem[]> {
  const rows = await db.memberReport.findMany({
    where: visibleReportWhere(holder),
    select: {
      id: true,
      publicId: true,
      type: true,
      noticeKind: true,
      periodStart: true,
      periodEnd: true,
      sentAt: true,
      frozenContent: true,
    },
  });
  if (rows.length === 0) return [];
  const own = await db.memberReportAttachment.findMany({
    where: {
      reportId: { in: rows.map((r) => r.id) },
      companyId: holder.companyId,
      stakeholderId: holder.stakeholderId,
    },
    select: { reportId: true },
  });
  const withOwnFiles = new Set(own.map((a) => a.reportId));

  const items: ReportListItem[] = [];
  for (const row of rows) {
    const frozen = readFrozenContent(row.frozenContent);
    if (frozen === null) continue;
    items.push({
      id: row.publicId,
      title: frozen.title,
      type: row.type,
      noticeKind: row.noticeKind,
      periodStart: row.periodStart ? utcDateToYmd(row.periodStart) : null,
      periodEnd: row.periodEnd ? utcDateToYmd(row.periodEnd) : null,
      releasedAt: row.sentAt,
      hasOwnFiles: withOwnFiles.has(row.id),
      // The same test as `portal.reports.exportXlsx`.
      exportable: isPortalExportable(row.type) && frozen.figures !== null,
    });
  }
  return items.sort(compareReleasedDesc);
}

/** The columns the report procedures read from a visible report. */
const visibleReportSelect = {
  id: true,
  publicId: true,
  companyId: true,
  type: true,
  status: true,
  title: true,
  noticeKind: true,
  fiscalYear: true,
  fiscalQuarter: true,
  periodStart: true,
  periodEnd: true,
  sentAt: true,
  updatedAt: true,
  figures: true,
  frozenContent: true,
} as const;

/**
 * One report visible to the holder, by its public id, or NOT_FOUND. The
 * report and the rule are one query (no second lookup that could tell the
 * cases apart).
 */
export async function findVisibleReport(
  db: TPrismaOrTransaction,
  holder: ReportHolder,
  reportPublicId: string,
) {
  const row = await db.memberReport.findFirst({
    where: { publicId: reportPublicId, ...visibleReportWhere(holder) },
    select: visibleReportSelect,
  });
  if (row === null) return reportNotFound();
  return row;
}

/** Whether a report of this public id is visible to the holder (no content read). */
export async function isReportVisible(
  db: TPrismaOrTransaction,
  holder: ReportHolder,
  reportPublicId: string,
): Promise<boolean> {
  const count = await db.memberReport.count({
    where: { publicId: reportPublicId, ...visibleReportWhere(holder) },
  });
  return count > 0;
}

/** One attachment as the portal lists it (G4: no bucket id, no key). */
export interface PortalReportAttachment {
  id: string;
  name: string;
  kind: string;
  /** Private to this holder (a K-1); otherwise shared with every recipient. */
  private: boolean;
  /** Opens in a browser tab (PDF, image); otherwise downloads. */
  inline: boolean;
}

/**
 * The attachments of a visible report that this holder may see (P12):
 * shared files and files private to this holder; on a TAX_K1 report only
 * this holder's own files, whoever else is a recipient.
 */
export async function listVisibleAttachments(
  db: TPrismaOrTransaction,
  holder: ReportHolder,
  report: { id: string; type: string },
): Promise<PortalReportAttachment[]> {
  const attachments = await db.memberReportAttachment.findMany({
    where: {
      reportId: report.id,
      companyId: holder.companyId,
      ...visibleAttachmentWhere(holder.stakeholderId, report.type),
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: {
      id: true,
      name: true,
      kind: true,
      stakeholderId: true,
      bucketId: true,
    },
  });
  if (attachments.length === 0) return [];
  const buckets = await db.bucket.findMany({
    where: { id: { in: attachments.map((a) => a.bucketId) } },
    select: { id: true, mimeType: true },
  });
  const inline = new Set(
    buckets.filter((b) => isInlineContentType(b.mimeType)).map((b) => b.id),
  );
  return attachments.map((a) => ({
    id: a.id,
    name: a.name,
    kind: a.kind,
    private: a.stakeholderId !== null,
    inline: inline.has(a.bucketId),
  }));
}

/**
 * One attachment of a visible report that this holder may open, with its
 * bucket, or NOT_FOUND. The same rule as `listVisibleAttachments`, applied
 * again to the single id (S4: holder B's K-1 id is NOT_FOUND for holder A).
 */
export async function findVisibleAttachment(
  db: TPrismaOrTransaction,
  holder: ReportHolder,
  report: { id: string; type: string },
  attachmentId: string,
) {
  const attachment = await db.memberReportAttachment.findFirst({
    where: {
      id: attachmentId,
      reportId: report.id,
      companyId: holder.companyId,
      ...visibleAttachmentWhere(holder.stakeholderId, report.type),
    },
    select: { id: true, name: true, bucketId: true },
  });
  if (attachment === null) return reportNotFound();
  const bucket = await db.bucket.findUnique({
    where: { id: attachment.bucketId },
    select: { key: true, mimeType: true, name: true },
  });
  if (bucket === null) return reportNotFound();
  return { attachment, bucket };
}
