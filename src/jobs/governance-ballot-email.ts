import { render } from "react-email";
import { z } from "zod";
import BallotInviteEmail, {
  ballotEmailSubject,
} from "@/emails/BallotInviteEmail";
import { Audit } from "@/server/audit";
import { db } from "@/server/db";
import { hasEvent, recordEventOnce } from "@/server/governance/events";
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

// One ballot invite or reminder per job (03-governance.md G9, A7).
// Delivery is at-least-once: the dedupe event is written after the send, so a
// crash between sending and writing the marker can cause one duplicate email;
// a missing email is not possible without a failed job in the queue.

const JOB_NAME = "governance.ballot-email";

const config = defineWorkerConfig({
  name: JOB_NAME,
  schema: z.object({
    ballotId: z.string().min(1),
    kind: z.enum(["INVITE", "REMINDER"]),
    // Manual sends use numbers; automatic reminders use "auto-7" / "auto-2".
    seq: z.union([z.number().int(), z.string().max(20)]),
  }),
});

export type BallotEmailJobData = z.infer<typeof config.schema>;

export const ballotEmailJob = defineJob(config);

/** Emits one job per item; call AFTER the transaction that created the ballots commits. */
export async function emitBallotEmails(items: BallotEmailJobData[]) {
  if (items.length === 0) return;
  await ballotEmailJob.bulkEmit(
    items.map((data) => ({
      data,
      singletonKey: `ballot-email-${data.ballotId}-${data.kind}-${data.seq}`,
    })),
  );
}

export const ballotEmailWorker = defineWorker(config, async (job) => {
  const { ballotId, kind, seq } = job.data;

  const ballot = await db.resolutionBallot.findUnique({
    where: { id: ballotId },
    include: { resolution: true },
  });
  if (!ballot) return;
  const { resolution } = ballot;
  if (resolution.status !== "SENT") return;
  if (ballot.submittedAt !== null || ballot.tokenRevokedAt !== null) return;

  const dedupeKey = `ballot-email:${ballotId}:${kind}:${seq}:v${ballot.tokenVersion}`;
  if (await hasEvent(db, resolution.id, dedupeKey)) return;

  const company = await loadLlcCompany(db, resolution.companyId);
  const zone = governanceZone(company.timezone);
  const token = await signBallotToken(ballot);
  const link = ballotUrl(token);
  const closesAt = formatDateTime(resolution.closesAt, zone);

  const html = await render(
    BallotInviteEmail({
      kind,
      companyName: company.name,
      recipientName: ballot.name,
      title: resolution.title,
      referenceCode: resolution.referenceCode ?? "",
      recordDate: formatDateOnly(resolution.recordDate),
      units: formatUnits(ballot.preferredUnits.toFixed(6)),
      closesAt,
      isTermExtension: resolution.type === "TERM_EXTENSION",
      link,
    }),
  );

  const { emailLogId } = await sendMail(
    {
      to: ballot.email,
      subject: ballotEmailSubject({
        kind,
        title: resolution.title,
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
  );

  await db.$transaction(async (tx) => {
    const inserted = await recordEventOnce(tx, {
      resolutionId: resolution.id,
      companyId: company.id,
      ballotId,
      type: kind === "INVITE" ? "INVITE_EMAILED" : "REMINDER_EMAILED",
      actorType: "system",
      actorId: null,
      summary: `${kind === "INVITE" ? "Invitation" : "Reminder"} emailed to ${ballot.name}`,
      dedupeKey,
    });
    if (!inserted) return;

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
          resolution.referenceCode ?? resolution.title
        } emailed to ${ballot.name}`,
      },
      tx,
    );
  });
});
