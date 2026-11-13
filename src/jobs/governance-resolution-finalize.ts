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
import { recordEvent, recordEventOnce } from "@/server/governance/events";
import { fileGeneratedPdf } from "@/server/governance/filing";
import { loadLlcCompany } from "@/server/governance/guards";
import { listManagerUsers } from "@/server/governance/recipients";
import { buildResolutionPdfData } from "@/server/governance/resolution-pdf-data";
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
// Manager users. Idempotent; safe to run any number of times. Delivery is
// at-least-once: a crash between sending and writing a marker can cause one
// duplicate email; a missing email is not possible without a failed job in
// the queue.

const JOB_NAME = "governance.resolution-finalize";

const config = defineWorkerConfig({
  name: JOB_NAME,
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

export const resolutionFinalizeWorker = defineWorker(config, async (job) => {
  const { resolutionId } = job.data;

  const resolution = await db.resolution.findUnique({
    where: { id: resolutionId },
  });
  if (!resolution || !isClosedStatus(resolution.status)) return;
  const status = resolution.status;
  const company = await loadLlcCompany(db, resolution.companyId);
  const zone = governanceZone(company.timezone);
  const referenceLabel = resolution.referenceCode ?? resolution.title;

  // 1. File the executed PDF.
  if (status === "EFFECTIVE" && resolution.executedDocumentId === null) {
    const data = await buildResolutionPdfData(db, resolutionId);
    const buffer = await renderResolutionPdf(data);
    const year = dayjs(resolution.effectiveAt ?? new Date())
      .tz(zone)
      .year();
    const alsoFileUnder = behaviour(
      resolution.type as ResolutionType,
    ).alsoFileUnder;
    const { documentIds } = await fileGeneratedPdf({
      company: { id: company.id, publicId: company.publicId },
      buffer,
      fileName: `${resolution.referenceCode ?? ""} ${resolution.title}.pdf`,
      keyPrefix: "resolutions",
      tag: TAG.RESOLUTION,
      categories: [
        { recordCategory: "CONSENTS_AND_MINUTES", recordYear: year },
        ...(alsoFileUnder
          ? [{ recordCategory: alsoFileUnder, recordYear: year }]
          : []),
      ],
      jobName: JOB_NAME,
    });

    // If two runs race, the loser's upload is an orphan object; acceptable.
    await db.$transaction(async (tx) => {
      const { count } = await tx.resolution.updateMany({
        where: { id: resolutionId, executedDocumentId: null },
        data: { executedDocumentId: documentIds[0] },
      });
      if (count !== 1) return;
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
    });
  }

  // 2. Member notices, one job per recipient.
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
      where: { resolutionId, invitedAt: { not: null } },
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

  // 3. Manager users (marker first: at most one notification round).
  const firstRun = await recordEventOnce(db, {
    resolutionId,
    companyId: company.id,
    type: "MANAGER_NOTIFIED",
    actorType: "system",
    actorId: null,
    summary: "Manager users notified of the result",
    dedupeKey: "manager-notified",
  });
  if (firstRun) {
    const managers = await listManagerUsers(db, company.id);
    const sentence = resultSentence({
      status,
      effectiveAt: formatDateTime(resolution.effectiveAt, zone),
      closedAt: formatDateTime(resolution.closedAt, zone),
    });
    const tallyLines = await resultTallyLines(resolutionId);
    const link = `${env.NEXT_PUBLIC_BASE_URL}/${company.publicId}/resolutions/${resolution.publicId}`;
    for (const manager of managers) {
      const html = await render(
        ResolutionNoticeEmail({
          variant: "MANAGER",
          companyName: company.name,
          recipientName: manager.name,
          title: resolution.title,
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
          subject: `Resolution ${RESULT_LABEL[status].toLowerCase()}: ${resolution.title}`,
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
    }
  }

  // 4.
  await db.resolution.updateMany({
    where: { id: resolutionId, resultNotifiedAt: null },
    data: { resultNotifiedAt: new Date() },
  });
});
