import { render } from "react-email";
import { z } from "zod";
import MemberReportEmail, {
  MemberReportAddressChangedEmail,
  type MemberReportEmailType,
  memberReportAddressChangedSubject,
  memberReportEmailSubject,
} from "@/emails/MemberReportEmail";
import { Audit } from "@/server/audit";
import { db } from "@/server/db";
import { loadLlcCompany } from "@/server/governance/guards";
import { sha256Hex } from "@/server/governance/hash";
import { completeK1DeadlinesIfCovered } from "@/server/governance/k1-coverage";
import { reportUrl, signReportToken } from "@/server/governance/tokens";
import { lockCompanyLedgerAndUnitClasses } from "@/server/llc/economics/scope";
import { sendMail } from "@/server/mailer";
import { readFrozenContent } from "@/trpc/routers/member-report-router/procedures/shared";
import { defineJob, defineWorker, defineWorkerConfig } from "../lib/queue";
import { governanceZone, longDate } from "./governance-resolution-notice";

// `governance.report-email` (03-governance.md G12): one member-report email
// per job.
//
// DELIVERY — data `{ recipientId, seq }`. AT MOST ONE email per
// (recipient, seq), whatever the number of concurrent or repeated runs, and
// a queued request is never lost to an older job's failure:
// 1. CLAIM: one guarded UPDATE in its own committed statement (outside any
//    transaction) sets `sendCount` to `seq + 1` while `sendCount <= seq`,
//    the link version is the one loaded (and signed below) and the link is
//    not revoked. Postgres re-checks that WHERE at write time, so of two
//    concurrent runs of one seq exactly one matches; every other run (and
//    every re-run after success, `sendCount > seq`) returns without sending.
//    `<=`, not `=`: a request queued at seq S (by `resend` or `replaceLink`,
//    which read `sendCount` while an older job's claim was in flight) stays
//    claimable even after that older job's failed send released the counter
//    below S. The version guard stops a job that loaded the row before
//    `replaceLink` from mailing the dead link (or the old address).
// 2. SEND with the token signed from the loaded row.
// 3. A failed send RELEASES the claim (`sendCount` back to `seq`, guarded by
//    `sendCount = seq + 1` AND the link version it claimed with) and
//    rethrows, so pg-boss retries and the retry can claim again. A STALE job
//    (the link was replaced after its claim) never releases: `replaceLink`
//    read `sendCount = seq + 1` and queued the new link under that seq; the
//    stale retry then finds `sendCount > seq` and sends nothing, and the
//    new-link job claims with the new version and sends whatever the stale
//    job did. (A stale job between its claim and SMTP can still deliver the
//    old link once; that link opens the REPLACED page only.)
// A crash between claim and send leaves no email (at most once);
// `memberReport.resend` is the recovery path: it always emits with
// `seq = sendCount`, which is claimable again. `sentAt` is set the first
// time, `emailLogId` every time.
// The queue's `stately` policy also drops a duplicate emit while the first
// job with the same singletonKey is still waiting (see lib/queue.ts).
//
// ADDRESS_CHANGED — data `{ recipientId, seq: tokenVersion, address,
// requestedAt }`: `replaceLink` moved the link to a different address; ONE
// address (the previous one, or the holder's notice email on file) is told,
// with no link. Never sent to the recipient's current address. There is no
// claim column for it (MemberReport has no event table): it is AT LEAST
// ONCE, de-duplicated best-effort against the email log.

const JOB_NAME = "governance.report-email";
export const REPORT_DELIVERY_KIND = "memberReport.delivery";
export const REPORT_ADDRESS_CHANGED_KIND = "memberReport.address-changed";

const config = defineWorkerConfig({
  name: JOB_NAME,
  policy: "stately",
  schema: z.object({
    recipientId: z.string().min(1).max(64),
    /** DELIVERY: the `sendCount` to claim. ADDRESS_CHANGED: the new token version. */
    seq: z.number().int().min(0),
    kind: z.enum(["DELIVERY", "ADDRESS_CHANGED"]).optional(),
    /** ADDRESS_CHANGED only: the one address to notify. */
    address: z.string().trim().min(1).max(320).optional(),
    /** ADDRESS_CHANGED only: ISO time of the change (de-duplication window). */
    requestedAt: z.string().max(40).optional(),
  }),
});

export type ReportEmailJobData = z.infer<typeof config.schema>;

export const reportEmailJob = defineJob(config);

export function reportEmailSingletonKey(data: ReportEmailJobData): string {
  if (data.kind === "ADDRESS_CHANGED") {
    const who = sha256Hex((data.address ?? "").toLowerCase()).slice(0, 16);
    return `report-email-${data.recipientId}-addr-${data.seq}-${who}`;
  }
  return `report-email-${data.recipientId}-${data.seq}`;
}

/** Emits one job per item; call AFTER the transaction that wrote the recipients commits. */
export async function emitReportEmails(items: ReportEmailJobData[]) {
  if (items.length === 0) return;
  await reportEmailJob.bulkEmit(
    items.map((data) => ({
      data,
      singletonKey: reportEmailSingletonKey(data),
    })),
  );
}

async function loadRecipient(recipientId: string) {
  const recipient = await db.memberReportRecipient.findUnique({
    where: { id: recipientId },
    include: {
      report: {
        select: {
          id: true,
          companyId: true,
          status: true,
          type: true,
          title: true,
          fiscalYear: true,
          fiscalQuarter: true,
          frozenContent: true,
        },
      },
    },
  });
  if (!recipient) return null;
  // Defence in depth: the recipient and its report belong to one company.
  if (recipient.companyId !== recipient.report.companyId) return null;
  return recipient;
}

export const reportEmailWorker = defineWorker(config, async (job) => {
  if (job.data.kind === "ADDRESS_CHANGED") {
    await sendAddressChangedNotice(job.data);
    return;
  }
  const { recipientId, seq } = job.data;

  const recipient = await loadRecipient(recipientId);
  if (!recipient) return;
  const { report } = recipient;
  if (report.status !== "SENT") return;
  if (recipient.tokenRevokedAt !== null) return;
  // Already sent for this seq (or superseded by a later one): nothing to do,
  // except finishing a K-1 completion that failed after the email (a retry).
  if (recipient.sendCount > seq) {
    if (
      report.type === "TAX_K1" &&
      report.fiscalYear !== null &&
      recipient.sentAt !== null
    ) {
      await completeK1AfterDelivery(
        report.companyId,
        report.id,
        report.fiscalYear,
      );
    }
    return;
  }

  const company = await loadLlcCompany(db, report.companyId);
  const zone = governanceZone(company.timezone);
  const title = readFrozenContent(report.frozenContent)?.title ?? report.title;
  const token = await signReportToken(recipient);
  const link = reportUrl(token);
  const html = await render(
    MemberReportEmail({
      type: report.type as MemberReportEmailType,
      companyName: company.name,
      recipientName: recipient.name,
      title,
      period: `Q${report.fiscalQuarter ?? ""} ${report.fiscalYear ?? ""}`,
      fiscalYear: String(report.fiscalYear ?? ""),
      validUntil: longDate(recipient.tokenExpiresAt, zone),
      link,
    }),
  );

  // 1. Claim (own statement, committed at once).
  const claimed = await db.$executeRaw`
    UPDATE "MemberReportRecipient"
    SET "sendCount" = ${seq + 1}, "updatedAt" = now()
    WHERE "id" = ${recipient.id}
      AND "sendCount" <= ${seq}
      AND "tokenVersion" = ${recipient.tokenVersion}
      AND "tokenRevokedAt" IS NULL`;
  if (claimed !== 1) return;

  // 2. Send; 3. release on failure.
  let emailLogId: string | null = null;
  try {
    ({ emailLogId } = await sendMail(
      {
        to: recipient.email,
        subject: memberReportEmailSubject({ companyName: company.name, title }),
        html,
        headers: { "X-From-Name": company.name },
      },
      {
        kind: REPORT_DELIVERY_KIND,
        companyId: company.id,
        stakeholderId: recipient.stakeholderId,
        relatedType: "memberReport",
        relatedId: report.id,
      },
    ));
  } catch (error) {
    // Released only while the link is still the version this job claimed
    // with. After `replaceLink` (new version) the counter it read and the
    // new-link job emitted with are already `seq + 1`: putting it back to
    // `seq` would make that job skip, and the new link would never be sent.
    await db.$executeRaw`
      UPDATE "MemberReportRecipient"
      SET "sendCount" = ${seq}, "updatedAt" = now()
      WHERE "id" = ${recipient.id}
        AND "sendCount" = ${seq + 1}
        AND "tokenVersion" = ${recipient.tokenVersion}`;
    throw error;
  }

  // The email left: record it (the claim stays whatever happens here).
  const now = new Date();
  await db.$executeRaw`
    UPDATE "MemberReportRecipient"
    SET "sentAt" = COALESCE("sentAt", ${now}),
        "emailLogId" = COALESCE(${emailLogId}, "emailLogId"),
        "updatedAt" = ${now}
    WHERE "id" = ${recipient.id}`;

  // R25: a K-1 delivered; when every holder of Units during the fiscal year
  // has now received its K-1, the year's K-1 deadlines are done.
  if (report.type === "TAX_K1" && report.fiscalYear !== null) {
    await completeK1AfterDelivery(
      report.companyId,
      report.id,
      report.fiscalYear,
    );
  }
});

/**
 * Closes the year's K-1 deadlines when covered (lock order: ledger, then the
 * unit classes). A failure here is retried with the job; the email itself is
 * already recorded and is not sent again (the claim stays).
 */
async function completeK1AfterDelivery(
  companyId: string,
  reportId: string,
  fiscalYear: number,
) {
  await db.$transaction(
    async (tx) => {
      await lockCompanyLedgerAndUnitClasses(tx, companyId);
      const { done } = await completeK1DeadlinesIfCovered(tx, {
        companyId,
        fiscalYear,
        reportId,
        memberId: null,
        now: new Date(),
      });
      if (done.length > 0) {
        await Audit.create(
          {
            action: "compliance.completed",
            companyId,
            actor: { type: "system", id: null },
            context: { requestIp: "system", userAgent: `job:${JOB_NAME}` },
            target: [{ type: "memberReport", id: reportId }],
            summary: `Every holder of Units during ${fiscalYear} has received its Schedule K-1; deadlines done: ${done.join(", ")}`,
          },
          tx,
        );
      }
    },
    { maxWait: 10_000, timeout: 30_000 },
  );
}

async function sendAddressChangedNotice(data: ReportEmailJobData) {
  const address = data.address?.trim();
  if (!address) return;
  const recipient = await loadRecipient(data.recipientId);
  if (!recipient) return;
  const { report } = recipient;
  // Never to the address the link now goes to.
  if (address.toLowerCase() === recipient.email.trim().toLowerCase()) return;

  const company = await loadLlcCompany(db, report.companyId);
  const since = data.requestedAt ? new Date(data.requestedAt) : null;
  const already = await db.emailLog.findFirst({
    where: {
      companyId: company.id,
      relatedType: "memberReport",
      relatedId: report.id,
      stakeholderId: recipient.stakeholderId,
      kind: REPORT_ADDRESS_CHANGED_KIND,
      status: "SENT",
      toAddress: { equals: address, mode: "insensitive" },
      ...(since !== null && !Number.isNaN(since.getTime())
        ? { createdAt: { gte: since } }
        : {}),
    },
    select: { id: true },
  });
  if (already) return;

  const title = readFrozenContent(report.frozenContent)?.title ?? report.title;
  const html = await render(
    MemberReportAddressChangedEmail({
      companyName: company.name,
      recipientName: recipient.name,
      title,
    }),
  );
  await sendMail(
    {
      to: address,
      subject: memberReportAddressChangedSubject({
        companyName: company.name,
        title,
      }),
      html,
      headers: { "X-From-Name": company.name },
    },
    {
      kind: REPORT_ADDRESS_CHANGED_KIND,
      companyId: company.id,
      stakeholderId: recipient.stakeholderId,
      relatedType: "memberReport",
      relatedId: report.id,
    },
  );
}
