import dayjs from "dayjs";
import timezone from "dayjs/plugin/timezone";
import utc from "dayjs/plugin/utc";
import { render } from "react-email";
import { z } from "zod";
import ResolutionNoticeEmail, {
  RESULT_LABEL,
  resultSentence,
} from "@/emails/ResolutionNoticeEmail";
import { env } from "@/env";
import { behaviour, type ResolutionType } from "@/lib/governance/presets";
import { TAG } from "@/lib/tags";
import { renderResolutionPdf } from "@/pdf-templates/governance/resolution-pdf";
import { Audit } from "@/server/audit";
import { db } from "@/server/db";
import { recordEvent, sendOnce } from "@/server/governance/events";
import { fileGeneratedPdf } from "@/server/governance/filing";
import { frozenTitle } from "@/server/governance/frozen";
import { guardedWrite } from "@/server/governance/guarded";
import { loadLlcCompany } from "@/server/governance/guards";
import { listManagerUsers } from "@/server/governance/recipients";
import { buildResolutionPdfData } from "@/server/governance/resolution-pdf-data";
import { lockResolution } from "@/server/governance/tally";
import { sendMail } from "@/server/mailer";
import { defineJob, defineWorker, defineWorkerConfig } from "../lib/queue";
import {
  emitResolutionNotices,
  formatDateTime,
  governanceZone,
  isClosedStatus,
  type ResolutionNoticeJobData,
  resultTallyLines,
} from "./governance-resolution-notice";

dayjs.extend(utc);
dayjs.extend(timezone);

// Finalizes a closed resolution (03-governance.md G9): files the executed PDF
// (EFFECTIVE only), fans out one notice job per recipient and notifies the
// Manager users. Idempotent; safe to run any number of times, concurrently.
//
// - The PDF is filed under the resolution's row lock: lock, re-check
//   `executedDocumentId`, render, upload, create the Bucket/Document rows and
//   set `executedDocumentId` in ONE transaction. A second run waits for the
//   lock and then sees the document; a crash before commit leaves at most an
//   orphaned object with no rows, never a second Document.
// - Emails are at most once per key (claim before send, `sendOnce`): one
//   notice job per Member (the notice job claims its key), one claim per
//   Manager user. A failed Manager email releases its claim and fails the
//   job, so the pg-boss retry (or the sweep) notifies only those not yet
//   notified.
// - `resultNotifiedAt` is set once every step succeeded; until then the sweep
//   re-emits this job (H2).

const JOB_NAME = "governance.resolution-finalize";

const config = defineWorkerConfig({
  name: JOB_NAME,
  policy: "stately",
  schema: z.object({ resolutionId: z.string().min(1) }),
});

export const resolutionFinalizeJob = defineJob(config);

/** Call AFTER the transaction that closed the resolution commits. */
export function emitResolutionFinalize(resolutionId: string) {
  // No timestamp in the key: that would defeat de-duplication.
  return resolutionFinalizeJob.emit(
    { resolutionId },
    { singletonKey: `resolution-finalize-${resolutionId}` },
  );
}

/** Lock, re-check, render, upload and record the executed PDF atomically. */
async function fileExecutedPdf(resolutionId: string) {
  await db.$transaction(
    async (tx) => {
      await lockResolution(tx, resolutionId);
      const resolution = await tx.resolution.findUnique({
        where: { id: resolutionId },
      });
      if (
        resolution?.status !== "EFFECTIVE" ||
        resolution.executedDocumentId !== null
      ) {
        return;
      }
      const company = await loadLlcCompany(tx, resolution.companyId);
      const zone = governanceZone(company.timezone);
      const title = frozenTitle(resolution);
      const referenceLabel = resolution.referenceCode ?? title;

      const data = await buildResolutionPdfData(tx, resolutionId);
      const buffer = await renderResolutionPdf(data);
      const year = dayjs(resolution.effectiveAt ?? new Date())
        .tz(zone)
        .year();
      const alsoFileUnder = behaviour(
        resolution.type as ResolutionType,
      ).alsoFileUnder;
      const { documentIds } = await fileGeneratedPdf(
        {
          company: { id: company.id, publicId: company.publicId },
          buffer,
          fileName: `${resolution.referenceCode ?? ""} ${title}.pdf`,
          keyPrefix: "resolutions",
          tag: TAG.RESOLUTION,
          categories: [
            { recordCategory: "CONSENTS_AND_MINUTES", recordYear: year },
            ...(alsoFileUnder
              ? [{ recordCategory: alsoFileUnder, recordYear: year }]
              : []),
          ],
          jobName: JOB_NAME,
        },
        tx,
      );

      // Under the lock the column was re-checked above; the guard is a
      // backstop that rolls the new rows back rather than keep two.
      const set = await guardedWrite(() =>
        tx.resolution.update({
          where: { id: resolutionId, executedDocumentId: null },
          data: { executedDocumentId: documentIds[0] },
          select: { id: true },
        }),
      );
      if (!set) {
        throw new Error(
          `Resolution ${resolutionId} got an executed document concurrently`,
        );
      }
      await recordEvent(tx, {
        resolutionId,
        companyId: company.id,
        type: "PDF_FILED",
        actorType: "system",
        actorId: null,
        summary: "Executed PDF filed in Documents",
      });
      await Audit.create(
        {
          action: "resolution.filed",
          companyId: company.id,
          actor: { type: "system", id: null },
          context: { requestIp: "system", userAgent: `job:${JOB_NAME}` },
          target: [
            { type: "resolution", id: resolutionId },
            ...documentIds.map((id) => ({ type: "document" as const, id })),
          ],
          summary: `Executed ${referenceLabel} filed with the books and records`,
        },
        tx,
      );
    },
    // Rendering and uploading happen inside: well above the 5s default.
    { maxWait: 30_000, timeout: 120_000 },
  );
}

export const resolutionFinalizeWorker = defineWorker(config, async (job) => {
  const { resolutionId } = job.data;

  const first = await db.resolution.findUnique({
    where: { id: resolutionId },
    select: { status: true, executedDocumentId: true },
  });
  if (!first || !isClosedStatus(first.status)) return;

  // 1. File the executed PDF.
  if (first.status === "EFFECTIVE" && first.executedDocumentId === null) {
    await fileExecutedPdf(resolutionId);
  }

  const resolution = await db.resolution.findUnique({
    where: { id: resolutionId },
  });
  if (!resolution || !isClosedStatus(resolution.status)) return;
  const status = resolution.status;
  const company = await loadLlcCompany(db, resolution.companyId);
  const zone = governanceZone(company.timezone);
  const title = frozenTitle(resolution);

  // 2. Member notices, one job per recipient: every Member of the frozen
  //    register when EFFECTIVE; otherwise every ballot holder, whether or not
  //    its invite went out (L2).
  let stakeholderIds: string[];
  if (status === "EFFECTIVE") {
    const entries = resolution.snapshotId
      ? await db.recordSnapshotEntry.findMany({
          where: { snapshotId: resolution.snapshotId, isMember: true },
          select: { stakeholderId: true },
        })
      : [];
    stakeholderIds = entries.map((e) => e.stakeholderId);
  } else {
    const ballots = await db.resolutionBallot.findMany({
      where: { resolutionId },
      select: { stakeholderId: true },
    });
    stakeholderIds = ballots.map((b) => b.stakeholderId);
  }
  const kind: ResolutionNoticeJobData["kind"] =
    resolution.type === "PURCHASE_ORDER" ? "PO_COPY" : "RESULT";
  await emitResolutionNotices(
    stakeholderIds.map((stakeholderId) => ({
      resolutionId,
      stakeholderId,
      kind,
      seq: 0,
    })),
  );

  // 3. Manager users: one claim per Manager (L3). A failed send releases
  //    its claim; the others are still sent, then the job fails and is
  //    retried for the ones left.
  const managers = await listManagerUsers(db, company.id);
  const failures: unknown[] = [];
  if (managers.length > 0) {
    const sentence = resultSentence({
      status,
      effectiveAt: formatDateTime(resolution.effectiveAt, zone),
      closedAt: formatDateTime(resolution.closedAt, zone),
    });
    const tallyLines = await resultTallyLines(resolutionId);
    const link = `${env.NEXT_PUBLIC_BASE_URL}/${company.publicId}/resolutions/${resolution.publicId}`;
    for (const manager of managers) {
      try {
        await sendOnce(
          {
            resolutionId,
            companyId: company.id,
            type: "MANAGER_NOTIFIED",
            actorType: "system",
            actorId: null,
            summary: `Manager user ${manager.name ?? manager.email} notified of the result`,
            dedupeKey: `manager-notified:${manager.memberId}`,
          },
          async () => {
            const html = await render(
              ResolutionNoticeEmail({
                variant: "MANAGER",
                companyName: company.name,
                recipientName: manager.name,
                title,
                referenceCode: resolution.referenceCode ?? "—",
                sentence,
                withdrawnReason:
                  status === "WITHDRAWN" ? resolution.withdrawnReason : null,
                tallyLines,
                link,
              }),
            );
            await sendMail(
              {
                to: manager.email,
                subject: `Resolution ${RESULT_LABEL[status].toLowerCase()}: ${title}`,
                html,
                headers: { "X-From-Name": company.name },
              },
              {
                kind: "resolution.manager",
                companyId: company.id,
                relatedType: "resolution",
                relatedId: resolutionId,
              },
            );
          },
        );
      } catch (error) {
        failures.push(error);
      }
    }
  }
  if (failures.length > 0) throw failures[0];

  // 4. Done: the sweep stops re-emitting this job.
  //    One guarded statement (Postgres re-checks the WHERE at write time);
  //    raw so a concurrent run that already set it is not logged as an error.
  if (resolution.resultNotifiedAt === null) {
    const now = new Date();
    await db.$executeRaw`
      UPDATE "Resolution" SET "resultNotifiedAt" = ${now}, "updatedAt" = ${now}
      WHERE "id" = ${resolutionId} AND "resultNotifiedAt" IS NULL`;
  }
});
