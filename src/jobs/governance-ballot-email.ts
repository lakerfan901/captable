import { render } from "react-email";
import { z } from "zod";
import BallotInviteEmail, {
  BallotAddressChangedEmail,
  ballotAddressChangedSubject,
  ballotEmailSubject,
} from "@/emails/BallotInviteEmail";
import { Audit } from "@/server/audit";
import { db } from "@/server/db";
import { sendOnce } from "@/server/governance/events";
import { frozenTitle } from "@/server/governance/frozen";
import { loadLlcCompany } from "@/server/governance/guards";
import { ballotUrl, signBallotToken } from "@/server/governance/tokens";
import { sendMail } from "@/server/mailer";
import { defineJob, defineWorker, defineWorkerConfig } from "../lib/queue";
import {
  formatDateOnly,
  formatDateTime,
  formatUnits,
  governanceZone,
  longDate,
} from "./governance-resolution-notice";

// One ballot invite or reminder per job (03-governance.md G9, A7), and the
// "your ballot link was re-issued to another address" notice (H1).
//
// Delivery is AT MOST ONCE per dedupe key: the job claims its key (inserts
// the INVITE_EMAILED / REMINDER_EMAILED event in its own committed statement)
// BEFORE sending, and only the claimant sends (`sendOnce`). A failed send
// releases the claim so the pg-boss retry can send. A crash between claim and
// send leaves no email: `resolution.remind` re-queues an invite that was
// claimed but never confirmed (`invitedAt` still null) under a fresh key.
// The key carries the link version the job loaded, so a stale job's claim or
// its release never touches the newer link's key; after claiming, the job
// re-reads the ballot and, if the link changed meanwhile, releases its claim
// and sends nothing (`sendOnce` `stillCurrent`).
// The queue's `stately` policy additionally drops a duplicate emit while the
// first job is still waiting.

const JOB_NAME = "governance.ballot-email";

const config = defineWorkerConfig({
  name: JOB_NAME,
  policy: "stately",
  schema: z.object({
    ballotId: z.string().min(1),
    kind: z.enum(["INVITE", "REMINDER", "ADDRESS_CHANGED"]),
    // Manual sends use numbers; automatic reminders use "auto-7" / "auto-2";
    // invites re-queued by `remind` use "r<n>"; ADDRESS_CHANGED uses the new
    // token version.
    seq: z.union([z.number().int(), z.string().max(20)]),
    // ADDRESS_CHANGED only: the address the link was moved away from.
    previousEmail: z.string().trim().min(1).max(320).optional(),
  }),
});

export type BallotEmailJobData = z.infer<typeof config.schema>;

export const ballotEmailJob = defineJob(config);

export function ballotEmailSingletonKey(data: BallotEmailJobData): string {
  return `ballot-email-${data.ballotId}-${data.kind}-${data.seq}`;
}

/** Emits one job per item; call AFTER the transaction that created the ballots commits. */
export async function emitBallotEmails(items: BallotEmailJobData[]) {
  if (items.length === 0) return;
  await ballotEmailJob.bulkEmit(
    items.map((data) => ({
      data,
      singletonKey: ballotEmailSingletonKey(data),
    })),
  );
}

/** The dedupe key (and claim) of one invite / reminder of one link version. */
export function ballotEmailDedupeKey(
  ballotId: string,
  kind: "INVITE" | "REMINDER",
  seq: number | string,
  tokenVersion: number,
): string {
  return `ballot-email:${ballotId}:${kind}:${seq}:v${tokenVersion}`;
}

export const ballotEmailWorker = defineWorker(config, async (job) => {
  const { ballotId, kind, seq } = job.data;
  if (kind === "ADDRESS_CHANGED") {
    await sendAddressChangedNotices(ballotId, seq, job.data.previousEmail);
    return;
  }

  const ballot = await db.resolutionBallot.findUnique({
    where: { id: ballotId },
    include: { resolution: true },
  });
  if (!ballot) return;
  const { resolution } = ballot;
  if (resolution.status !== "SENT") return;
  if (ballot.submittedAt !== null || ballot.tokenRevokedAt !== null) return;

  const dedupeKey = ballotEmailDedupeKey(
    ballotId,
    kind,
    seq,
    ballot.tokenVersion,
  );
  const company = await loadLlcCompany(db, resolution.companyId);
  const zone = governanceZone(company.timezone);
  const title = frozenTitle(resolution);
  const token = await signBallotToken(ballot);
  const link = ballotUrl(token);
  const closesAt = formatDateTime(resolution.closesAt, zone);

  let emailLogId: string | null = null;
  const outcome = await sendOnce(
    {
      resolutionId: resolution.id,
      companyId: company.id,
      ballotId,
      type: kind === "INVITE" ? "INVITE_EMAILED" : "REMINDER_EMAILED",
      actorType: "system",
      actorId: null,
      summary: `${kind === "INVITE" ? "Invitation" : "Reminder"} emailed to ${ballot.name}`,
      dedupeKey,
    },
    async () => {
      const html = await render(
        BallotInviteEmail({
          kind,
          companyName: company.name,
          recipientName: ballot.name,
          title,
          referenceCode: resolution.referenceCode ?? "",
          recordDate: formatDateOnly(resolution.recordDate),
          units: formatUnits(ballot.preferredUnits.toFixed(6)),
          closesAt,
          isTermExtension: resolution.type === "TERM_EXTENSION",
          link,
        }),
      );
      ({ emailLogId } = await sendMail(
        {
          to: ballot.email,
          subject: ballotEmailSubject({
            kind,
            title,
            companyName: company.name,
            closesAtDate: longDate(resolution.closesAt, zone),
          }),
          html,
          headers: { "X-From-Name": company.name },
        },
        {
          kind: "resolution.ballot",
          companyId: company.id,
          stakeholderId: ballot.stakeholderId,
          relatedType: "resolution",
          relatedId: resolution.id,
        },
      ));
    },
    // After the claim: the link this job signed must still be the current
    // one (replaceLink / revokeLink / a vote may have happened since the
    // ballot was loaded). The newer link's job has its own key and sends.
    async () => {
      const now = await db.resolutionBallot.findUnique({
        where: { id: ballotId },
        select: {
          tokenVersion: true,
          tokenRevokedAt: true,
          submittedAt: true,
          email: true,
          resolution: { select: { status: true } },
        },
      });
      return (
        now !== null &&
        now.tokenVersion === ballot.tokenVersion &&
        now.tokenRevokedAt === null &&
        now.submittedAt === null &&
        now.email === ballot.email &&
        now.resolution.status === "SENT"
      );
    },
  );
  if (outcome === "SKIPPED") return;

  // The email left: record it on the ballot (never throws the send again,
  // whatever happens here: the claim stays).
  await db.$transaction(async (tx) => {
    const now = new Date();
    if (kind === "INVITE") {
      await tx.resolutionBallot.update({
        where: { id: ballotId },
        data: {
          invitedAt: ballot.invitedAt ?? now,
          inviteEmailLogId: emailLogId,
        },
      });
    } else {
      await tx.resolutionBallot.update({
        where: { id: ballotId },
        data: { lastReminderAt: now, reminderCount: { increment: 1 } },
      });
    }

    await Audit.create(
      {
        action: kind === "INVITE" ? "ballot.issued" : "ballot.reminded",
        companyId: company.id,
        actor: { type: "system", id: null },
        context: { requestIp: "system", userAgent: `job:${JOB_NAME}` },
        target: [
          { type: "resolution", id: resolution.id },
          { type: "ballot", id: ballotId },
        ],
        summary: `${kind === "INVITE" ? "Ballot invitation" : "Ballot reminder"} for ${
          resolution.referenceCode ?? title
        } emailed to ${ballot.name}`,
      },
      tx,
    );
  });
});

/**
 * H1: the ballot link was re-issued to a different address. Tells the
 * previous address and the Member's notice email on file (both, once each,
 * never the new address), with no link. Sent whatever the resolution's state
 * is now: it is a security notice about a change that already happened.
 */
async function sendAddressChangedNotices(
  ballotId: string,
  seq: number | string,
  previousEmail: string | undefined,
) {
  const ballot = await db.resolutionBallot.findUnique({
    where: { id: ballotId },
    include: {
      resolution: true,
    },
  });
  if (!ballot) return;
  const { resolution } = ballot;
  const stakeholder = await db.stakeholder.findFirst({
    where: { id: ballot.stakeholderId, companyId: ballot.companyId },
    select: { email: true, noticeEmail: true },
  });
  const current = ballot.email.trim().toLowerCase();
  const recipients = new Map<string, string>();
  for (const raw of [
    previousEmail,
    stakeholder?.noticeEmail ?? stakeholder?.email,
  ]) {
    const address = raw?.trim();
    if (!address) continue;
    const key = address.toLowerCase();
    if (key === current || recipients.has(key)) continue;
    recipients.set(key, address);
  }
  if (recipients.size === 0) return;

  const company = await loadLlcCompany(db, resolution.companyId);
  const title = frozenTitle(resolution);
  const referenceCode = resolution.referenceCode ?? "—";
  const html = await render(
    BallotAddressChangedEmail({
      companyName: company.name,
      recipientName: ballot.name,
      title,
      referenceCode,
    }),
  );

  const failures: unknown[] = [];
  for (const [key, address] of recipients) {
    try {
      await sendOnce(
        {
          resolutionId: resolution.id,
          companyId: company.id,
          ballotId,
          type: "ADDRESS_CHANGE_NOTICE_EMAILED",
          actorType: "system",
          actorId: null,
          summary: `Notice that the ballot link of ${ballot.name} was re-issued to a different address emailed to ${address}`,
          dedupeKey: `ballot-email:${ballotId}:ADDRESS_CHANGED:${seq}:${key}`,
        },
        async () => {
          await sendMail(
            {
              to: address,
              subject: ballotAddressChangedSubject({
                title,
                companyName: company.name,
              }),
              html,
              headers: { "X-From-Name": company.name },
            },
            {
              kind: "resolution.ballot-address-changed",
              companyId: company.id,
              stakeholderId: ballot.stakeholderId,
              relatedType: "resolution",
              relatedId: resolution.id,
            },
          );
        },
      );
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    // The claims of the failed sends were released; pg-boss retries and the
    // addresses already notified are skipped.
    throw failures[0];
  }
}
