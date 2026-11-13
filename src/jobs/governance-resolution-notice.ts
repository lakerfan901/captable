import dayjs from "dayjs";
import timezone from "dayjs/plugin/timezone";
import utc from "dayjs/plugin/utc";
import { render } from "react-email";
import { z } from "zod";
import ResolutionNoticeEmail, {
  type ClosedResolutionStatus,
  RESULT_LABEL,
  resultSentence,
} from "@/emails/ResolutionNoticeEmail";
import { GOVERNANCE_TIME_ZONE } from "@/lib/governance/dates";
import { parseParams } from "@/lib/governance/presets";
import { isKeyInCompanyNamespace } from "@/lib/upload-authorization";
import { Audit } from "@/server/audit";
import { db } from "@/server/db";
import { getFileFromS3 } from "@/server/file-uploads";
import { hasEvent, recordEvent, sendOnce } from "@/server/governance/events";
import { frozenParams, frozenTitle } from "@/server/governance/frozen";
import { guardedWrite } from "@/server/governance/guarded";
import { loadLlcCompany } from "@/server/governance/guards";
import { buildResolutionPdfData } from "@/server/governance/resolution-pdf-data";
import { lockResolution } from "@/server/governance/tally";
import { sendMail } from "@/server/mailer";
import { defineJob, defineWorker, defineWorkerConfig } from "../lib/queue";

dayjs.extend(utc);
dayjs.extend(timezone);

// One result notice or purchase-order copy per Member per job
// (03-governance.md G9, B3 R21).
//
// Delivery is AT MOST ONCE per dedupe key (M1): the RESULT_EMAILED /
// COPY_EMAILED event is inserted (claimed) in its own committed statement
// BEFORE the send and only the claimant sends (`sendOnce`); a failed send
// releases the claim so the retry can send. A crash between claim and send
// leaves no email; `resolution.resendNotice` re-sends under a fresh key.
//
// The recipient address is the ballot's CURRENT email when the Member has a
// ballot (it may have been replaced after send, M2), else the frozen register
// entry's. The notice never carries a ballot link: it is only sent for a
// closed resolution. Title, params and text come from the frozen content.

const JOB_NAME = "governance.resolution-notice";
const DASH = "—";

// ---------------------------------------------------------------------------
// Formatting shared by the governance email jobs

export function governanceZone(companyZone: string | null | undefined) {
  return companyZone || GOVERNANCE_TIME_ZONE;
}

export function formatDateTime(value: Date | null, zone: string): string {
  if (value === null) return DASH;
  return dayjs(value).tz(zone).format("MMMM D, YYYY h:mm A z");
}

export function longDate(value: Date | null, zone: string): string {
  if (value === null) return DASH;
  return dayjs(value).tz(zone).format("MMMM D, YYYY");
}

/** `@db.Date` columns are stored at UTC midnight: format without a zone shift. */
export function formatDateOnly(value: Date | null): string {
  if (value === null) return DASH;
  return dayjs.utc(value).format("MMMM D, YYYY");
}

/** "1050.000000" -> "1,050"; "900.500000" -> "900.5". */
export function formatUnits(units: string): string {
  const [whole = "0", frac = ""] = units.split(".");
  const trimmed = frac.replace(/0+$/, "");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return trimmed ? `${grouped}.${trimmed}` : grouped;
}

/** `{basis label}: {for} of {denominator} units in favour ({percent}%); required: {wording}.` */
export async function resultTallyLines(resolutionId: string) {
  const data = await buildResolutionPdfData(db, resolutionId);
  return data.tallies.map(
    (t) =>
      `${t.basisLabel}: ${t.forUnits} of ${t.outstanding} units in favour (${t.forPercent}%); required: ${t.requiredWording}.`,
  );
}

export function isClosedStatus(
  status: string,
): status is ClosedResolutionStatus {
  return (
    status === "EFFECTIVE" ||
    status === "FAILED" ||
    status === "EXPIRED" ||
    status === "WITHDRAWN"
  );
}

// ---------------------------------------------------------------------------

const config = defineWorkerConfig({
  name: JOB_NAME,
  policy: "stately",
  schema: z.object({
    resolutionId: z.string().min(1),
    stakeholderId: z.string().min(1),
    kind: z.enum(["RESULT", "PO_COPY"]),
    seq: z.number().int().min(0),
  }),
});

export type ResolutionNoticeJobData = z.infer<typeof config.schema>;

export const resolutionNoticeJob = defineJob(config);

export function noticeSingletonKey(data: ResolutionNoticeJobData): string {
  return `resolution-notice-${data.resolutionId}-${data.stakeholderId}-${data.kind}-${data.seq}`;
}

export function noticeDedupeKey(
  kind: ResolutionNoticeJobData["kind"],
  stakeholderId: string,
  seq: number,
): string {
  return `notice:${kind}:${stakeholderId}:${seq}`;
}

/** Emits one job per item; call AFTER any transaction commits. */
export async function emitResolutionNotices(items: ResolutionNoticeJobData[]) {
  if (items.length === 0) return;
  await resolutionNoticeJob.bulkEmit(
    items.map((data) => ({ data, singletonKey: noticeSingletonKey(data) })),
  );
}

async function loadExecutedPdf(
  documentId: string,
  company: { id: string; publicId: string },
) {
  const document = await db.document.findFirst({
    where: { id: documentId, companyId: company.id },
    select: { bucket: { select: { name: true, key: true } } },
  });
  if (!document) {
    throw new Error(`Executed document ${documentId} not found`);
  }
  if (!isKeyInCompanyNamespace(document.bucket.key, company)) {
    throw new Error(`Executed document ${documentId} is outside the company`);
  }
  const bytes = await getFileFromS3(document.bucket.key);
  return {
    filename: document.bucket.name,
    content: Buffer.from(bytes),
    contentType: "application/pdf",
  };
}

export const resolutionNoticeWorker = defineWorker(config, async (job) => {
  const { resolutionId, stakeholderId, kind, seq } = job.data;
  const dedupeKey = noticeDedupeKey(kind, stakeholderId, seq);
  // Fast path only (skips loading the PDF); the claim below is the guarantee.
  if (await hasEvent(db, resolutionId, dedupeKey)) return;

  const resolution = await db.resolution.findUnique({
    where: { id: resolutionId },
    include: { requirements: { orderBy: { position: "asc" } } },
  });
  if (!resolution || !isClosedStatus(resolution.status)) return;
  const status = resolution.status;
  if (kind === "PO_COPY" && status !== "EFFECTIVE") return;

  const company = await loadLlcCompany(db, resolution.companyId);
  const zone = governanceZone(company.timezone);

  const entry = resolution.snapshotId
    ? await db.recordSnapshotEntry.findUnique({
        where: {
          snapshotId_stakeholderId: {
            snapshotId: resolution.snapshotId,
            stakeholderId,
          },
        },
        select: { name: true, email: true },
      })
    : null;
  const ballot = await db.resolutionBallot.findUnique({
    where: { resolutionId_stakeholderId: { resolutionId, stakeholderId } },
  });
  // M2: a ballot's email may have been replaced after send; its current
  // address wins over the frozen register's.
  const recipient = ballot ? { name: ballot.name, email: ballot.email } : entry;
  if (!recipient) {
    throw new Error(
      `Stakeholder ${stakeholderId} is not a recipient of resolution ${resolutionId}`,
    );
  }

  if (status === "EFFECTIVE" && resolution.executedDocumentId === null) {
    // The finalize job files the PDF before emitting notices; retry until it is there.
    throw new Error(`Resolution ${resolutionId} has no executed PDF yet`);
  }
  const attachments = resolution.executedDocumentId
    ? [await loadExecutedPdf(resolution.executedDocumentId, company)]
    : [];

  const referenceCode = resolution.referenceCode ?? DASH;
  const title = frozenTitle(resolution);
  const effectiveAt = formatDateTime(resolution.effectiveAt, zone);
  let subject: string;
  let html: string;

  if (kind === "PO_COPY") {
    // Vendor, equipment and price as frozen (and signed) at send.
    const params = parseParams("PURCHASE_ORDER", frozenParams(resolution));
    const manager = resolution.requirements.find(
      (r) => r.kind === "MANAGER_APPROVAL" && r.approvedAt !== null,
    );
    subject = `Manager resolution ${referenceCode}: purchase order — ${params.vendor}`;
    html = await render(
      ResolutionNoticeEmail({
        variant: "PO_COPY",
        companyName: company.name,
        recipientName: recipient.name,
        title,
        referenceCode,
        vendor: params.vendor,
        equipment: params.equipment,
        currency: params.currency,
        price: formatUnits(String(params.price)),
        effectiveAt,
        approverName: manager?.approverName ?? "",
        approverCapacity: manager?.approverCapacity ?? "",
      }),
    );
  } else {
    subject = `Result: ${title} — ${RESULT_LABEL[status]}`;
    html = await render(
      ResolutionNoticeEmail({
        variant: "RESULT",
        status,
        companyName: company.name,
        recipientName: recipient.name,
        title,
        referenceCode,
        sentence: resultSentence({
          status,
          effectiveAt,
          closedAt: formatDateTime(resolution.closedAt, zone),
        }),
        withdrawnReason:
          status === "WITHDRAWN" ? resolution.withdrawnReason : null,
        tallyLines: await resultTallyLines(resolutionId),
        // Closed resolution: never a ballot link (M2).
        link: null,
      }),
    );
  }

  const outcome = await sendOnce(
    {
      resolutionId,
      companyId: company.id,
      ballotId: ballot?.id ?? null,
      type: kind === "PO_COPY" ? "COPY_EMAILED" : "RESULT_EMAILED",
      actorType: "system",
      actorId: null,
      summary: `${kind === "PO_COPY" ? "Copy" : "Result notice"} emailed to ${recipient.name}`,
      dedupeKey,
    },
    async () => {
      await sendMail(
        {
          to: recipient.email,
          subject,
          html,
          headers: { "X-From-Name": company.name },
          attachments,
        },
        {
          kind: kind === "PO_COPY" ? "resolution.copy" : "resolution.result",
          companyId: company.id,
          stakeholderId,
          relatedType: "resolution",
          relatedId: resolutionId,
        },
      );
    },
  );
  if (outcome === "SKIPPED") return;

  if (kind === "PO_COPY") {
    await markCopyDelivered(resolutionId, company.id, referenceCode);
  }
});

/**
 * R16: once every Member of the frozen register has a COPY_EMAILED event AND
 * a SENT `resolution.copy` email log. The event alone is not enough: it is
 * the claim written before the send, and another Member's send may still be
 * in flight (or fail and release its claim).
 */
async function markCopyDelivered(
  resolutionId: string,
  companyId: string,
  referenceCode: string,
) {
  await db.$transaction(async (tx) => {
    await lockResolution(tx, resolutionId);
    const resolution = await tx.resolution.findUnique({
      where: { id: resolutionId },
      select: { copyDeliveredAt: true, snapshotId: true },
    });
    if (!resolution || resolution.copyDeliveredAt !== null) return;
    if (!resolution.snapshotId) return;

    const members = await tx.recordSnapshotEntry.findMany({
      where: { snapshotId: resolution.snapshotId, isMember: true },
      select: { stakeholderId: true },
    });
    const emailed = await tx.resolutionEvent.findMany({
      where: { resolutionId, type: "COPY_EMAILED" },
      select: { dedupeKey: true },
    });
    const emailedIds = new Set(
      emailed.map((e) => e.dedupeKey?.split(":")[2]).filter(Boolean),
    );
    const logs = await tx.emailLog.findMany({
      where: {
        companyId,
        relatedType: "resolution",
        relatedId: resolutionId,
        kind: "resolution.copy",
        status: "SENT",
      },
      select: { stakeholderId: true },
    });
    const sentIds = new Set(logs.map((l) => l.stakeholderId));
    if (
      !members.every(
        (m) => emailedIds.has(m.stakeholderId) && sentIds.has(m.stakeholderId),
      )
    ) {
      return;
    }

    const now = new Date();
    // Under the row lock and re-checked above; guarded as a backstop.
    const marked = await guardedWrite(() =>
      tx.resolution.update({
        where: { id: resolutionId, copyDeliveredAt: null },
        data: { copyDeliveredAt: now },
        select: { id: true },
      }),
    );
    if (!marked) return;
    await recordEvent(tx, {
      resolutionId,
      companyId,
      type: "COPY_DELIVERED",
      actorType: "system",
      actorId: null,
      summary: "Copy delivered to every Member (Section 6.16(i)(B))",
    });
    await Audit.create(
      {
        action: "resolution.copy-delivered",
        companyId,
        actor: { type: "system", id: null },
        context: { requestIp: "system", userAgent: `job:${JOB_NAME}` },
        target: [{ type: "resolution", id: resolutionId }],
        summary: `Copy of ${referenceCode} delivered to every Member`,
      },
      tx,
    );
    // `(companyId, dedupeKey)` is unique: one guarded single-row write.
    await guardedWrite(() =>
      tx.complianceDeadline.update({
        where: {
          companyId_dedupeKey: {
            companyId,
            dedupeKey: `PO_RESOLUTION_COPY:${resolutionId}`,
          },
          status: "OPEN",
        },
        data: {
          status: "DONE",
          satisfiedByType: "RESOLUTION",
          satisfiedById: resolutionId,
          completedAt: now,
        },
        select: { id: true },
      }),
    );
  });
}
