import type { BooksRecordCategoryEnum } from "@prisma/client";
import { z } from "zod";
import { generatePublicId } from "@/common/id";
import { todayInZone } from "@/lib/governance/dates";
import type { MemberReportType } from "@/lib/governance/report-figures";
import { TAG } from "@/lib/tags";
import { renderReportPdf } from "@/pdf-templates/governance/report-pdf";
import { Audit } from "@/server/audit";
import { db } from "@/server/db";
import { fileGeneratedPdf } from "@/server/governance/filing";
import { guardedWrite } from "@/server/governance/guarded";
import { loadLlcCompany } from "@/server/governance/guards";
import {
  lockReport,
  readFrozenContent,
} from "@/trpc/routers/member-report-router/procedures/shared";
import { defineJob, defineWorker, defineWorkerConfig } from "../lib/queue";
import { formatDateTime, governanceZone } from "./governance-resolution-notice";

// `governance.report-file` (03-governance.md G13): files the PDF of a SENT
// member report in Documents (books and records, Section 8.1).
//
// Exactly one PDF per report, whatever the number of concurrent or repeated
// runs: lock the report row, re-check `filedDocumentId`, render, upload, then
// create the Bucket/Document rows and set `filedDocumentId` in ONE
// transaction (the `fileExecutedPdf` pattern of the resolution finalize job).
// A second run waits for the lock and then sees the document; a crash before
// commit leaves at most an orphaned object with no rows. The write of
// `filedDocumentId` is a guarded single-row update (never `updateMany`, see
// server/governance/guarded.ts).
//
// Categories: QUARTERLY / ANNUAL → FINANCIAL_STATEMENTS (fiscal year);
// TAX_K1 → TAX_RETURNS (fiscal year); NOTICE → OTHER_STATUTORY (year of
// `sentAt` in the company time zone). ANNUAL also files each shared balance
// sheet / income statement attachment as its own Document, unless the bucket
// already has a Document of the company. K-1 files are never turned into
// Documents and the PDF never names a private file.
//
// Recovery: `send` emits this job after commit; the resolution sweep re-emits
// it for SENT reports still without a filed document a few minutes later.

const JOB_NAME = "governance.report-file";

const config = defineWorkerConfig({
  name: JOB_NAME,
  policy: "stately",
  schema: z.object({ reportId: z.string().min(1).max(64) }),
});

export const reportFileJob = defineJob(config);

/** Call AFTER the transaction that sent the report commits. */
export function emitReportFile(reportId: string) {
  // No timestamp in the key: that would defeat de-duplication.
  return reportFileJob.emit(
    { reportId },
    { singletonKey: `report-file-${reportId}` },
  );
}

const TYPE_LABEL: Record<MemberReportType, string> = {
  QUARTERLY: "Quarterly report",
  ANNUAL: "Annual financial statements",
  TAX_K1: "Schedule K-1 delivery",
  NOTICE: "Notice to Members",
};

function categoryOf(
  type: MemberReportType,
  fiscalYear: number | null,
  sentYear: number,
): { recordCategory: BooksRecordCategoryEnum; recordYear: number | null } {
  switch (type) {
    case "QUARTERLY":
    case "ANNUAL":
      return { recordCategory: "FINANCIAL_STATEMENTS", recordYear: fiscalYear };
    case "TAX_K1":
      return { recordCategory: "TAX_RETURNS", recordYear: fiscalYear };
    default:
      return { recordCategory: "OTHER_STATUTORY", recordYear: sentYear };
  }
}

/** Lock, re-check, render, upload and record the report PDF atomically. */
export async function fileReportPdf(reportId: string): Promise<void> {
  await db.$transaction(
    async (tx) => {
      await lockReport(tx, reportId);
      const report = await tx.memberReport.findUnique({
        where: { id: reportId },
      });
      if (report?.status !== "SENT" || report.filedDocumentId !== null) {
        return;
      }
      const frozen = readFrozenContent(report.frozenContent);
      if (frozen === null || report.frozenHash === null) {
        throw new Error(
          `Member report ${reportId} has no readable frozen content`,
        );
      }
      const company = await loadLlcCompany(tx, report.companyId);
      const zone = governanceZone(company.timezone);
      const type = report.type as MemberReportType;
      const sentAt = report.sentAt ?? new Date();
      const sentYear = Number(todayInZone(sentAt, zone).slice(0, 4));

      // Shared files only (no holder): private K-1 files are never listed.
      const attachments = await tx.memberReportAttachment.findMany({
        where: { reportId, companyId: company.id },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: { name: true, kind: true, bucketId: true, stakeholderId: true },
      });
      const shared = attachments.filter((a) => a.stakeholderId === null);

      const buffer = await renderReportPdf({
        companyName: company.name,
        title: frozen.title,
        typeLabel: TYPE_LABEL[type] ?? type,
        type,
        periodStart: report.periodStart
          ? report.periodStart.toISOString().slice(0, 10)
          : null,
        periodEnd: report.periodEnd
          ? report.periodEnd.toISOString().slice(0, 10)
          : null,
        fiscalQuarter: report.fiscalQuarter,
        fiscalYear: report.fiscalYear,
        sent: formatDateTime(sentAt, zone),
        figures:
          type === "QUARTERLY" || type === "ANNUAL" ? frozen.figures : null,
        doc: frozen.doc,
        sharedAttachmentNames: shared.map((a) => a.name),
        frozenHash: report.frozenHash,
      });

      const category = categoryOf(type, report.fiscalYear, sentYear);
      const { documentIds } = await fileGeneratedPdf(
        {
          company: { id: company.id, publicId: company.publicId },
          buffer,
          fileName: `${frozen.title}.pdf`,
          keyPrefix: "member-reports",
          tag: TAG.MEMBER_REPORT,
          categories: [category],
          jobName: JOB_NAME,
        },
        tx,
      );
      const filedDocumentId = documentIds[0];
      if (filedDocumentId === undefined) {
        throw new Error(`No document filed for member report ${reportId}`);
      }

      // ANNUAL: the uploaded statements become books-and-records Documents.
      const statementDocumentIds: string[] = [];
      if (type === "ANNUAL") {
        const statements = shared.filter(
          (a) => a.kind === "BALANCE_SHEET" || a.kind === "INCOME_STATEMENT",
        );
        const seen = new Set<string>();
        for (const a of statements) {
          if (seen.has(a.bucketId)) continue;
          seen.add(a.bucketId);
          const existing = await tx.document.findFirst({
            where: { bucketId: a.bucketId, companyId: company.id },
            select: { id: true },
          });
          if (existing) continue;
          const document = await tx.document.create({
            data: {
              companyId: company.id,
              publicId: generatePublicId(),
              name: a.name,
              bucketId: a.bucketId,
              recordCategory: "FINANCIAL_STATEMENTS",
              recordYear: report.fiscalYear,
            },
            select: { id: true },
          });
          statementDocumentIds.push(document.id);
          await Audit.create(
            {
              action: "document.created",
              companyId: company.id,
              actor: { type: "system", id: null },
              context: { requestIp: "system", userAgent: `job:${JOB_NAME}` },
              target: [{ type: "document", id: document.id }],
              summary: `Filed "${a.name}" (FINANCIAL_STATEMENTS${
                report.fiscalYear === null ? "" : ` ${report.fiscalYear}`
              }) from the annual financial statements`,
            },
            tx,
          );
        }
      }

      // Under the lock the column was re-checked above; the guard is a
      // backstop that rolls the new rows back rather than keep two.
      const set = await guardedWrite(() =>
        tx.memberReport.update({
          where: { id: reportId, status: "SENT", filedDocumentId: null },
          data: { filedDocumentId },
          select: { id: true },
        }),
      );
      if (!set) {
        throw new Error(
          `Member report ${reportId} got a filed document concurrently`,
        );
      }

      await Audit.create(
        {
          action: "memberReport.filed",
          companyId: company.id,
          actor: { type: "system", id: null },
          context: { requestIp: "system", userAgent: `job:${JOB_NAME}` },
          target: [
            { type: "memberReport", id: reportId },
            ...[filedDocumentId, ...statementDocumentIds].map((id) => ({
              type: "document" as const,
              id,
            })),
          ],
          summary: `"${frozen.title}" filed with the books and records (${category.recordCategory}${
            category.recordYear === null ? "" : ` ${category.recordYear}`
          })`,
        },
        tx,
      );
    },
    // Rendering and uploading happen inside: well above the 5s default.
    { maxWait: 30_000, timeout: 120_000 },
  );
}

export const reportFileWorker = defineWorker(config, async (job) => {
  const { reportId } = job.data;
  const first = await db.memberReport.findUnique({
    where: { id: reportId },
    select: { status: true, filedDocumentId: true },
  });
  if (first?.status !== "SENT" || first.filedDocumentId !== null) return;
  await fileReportPdf(reportId);
});
