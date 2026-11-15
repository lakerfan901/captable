import { render } from "react-email";
import PortalNotificationEmail from "@/emails/PortalNotificationEmail";
import { env } from "@/env";
import { logger } from "@/lib/logger";
import {
  DOCUMENTS_SHARED_KIND,
  documentsSignInUrl,
  logStakeholderId,
} from "@/lib/portal/notification-core";
import { db } from "@/server/db";
import { currentMailDelivery } from "@/server/mail-delivery";
import { sendMail } from "@/server/mailer";
import {
  type PortalNotificationEmailData,
  portalNotificationEmailConfig,
} from "@/server/portal/notification-email";
import { listVisibleDocuments } from "@/server/portal/visibility-documents";
import { defineWorker } from "../lib/queue";

// `portal.notification-email` (04-investor-portal.md 5.8; package P10): the
// "new documents" email of one share action to one person. Payload and
// queueing: src/server/portal/notification-email.ts.
//
// Order of one run:
// 1. Production mail guard (`currentMailDelivery("MEMBER_EMAIL")`): blocked
//    → nothing is read, claimed or sent.
// 2. Load and re-check, all live: the notification row (already claimed →
//    nothing to do), the person (password still set), their ACTIVE accesses
//    to the payload's holders in the row's company, and per such holder the
//    payload documents it can still open (`listVisibleDocuments`: grant,
//    P14 tie, file). Holders left with none are dropped; none left → nothing
//    is sent and the row stays unclaimed.
// 3. Render (company name, those holders' names and counts, sign-in link).
// 4. CLAIM: one guarded UPDATE in its own committed statement,
//    `claimedAt = $now WHERE id = $id AND claimedAt IS NULL`. Postgres
//    re-checks the WHERE at write time, so of any number of concurrent or
//    repeated runs exactly one affects the row; the others return without
//    sending. (Not `updateMany`: Prisma 7.10 does not re-check its `where`.)
// 5. SEND through `sendMail` (EmailLog kind `portal.documents-shared`, with
//    `companyId` and an explicit `stakeholderId`, so no address is ever
//    matched to a holder, P1).
// 6. A failed send RELEASES the claim (guarded by the claim time and
//    `sentAt IS NULL`) and rethrows, so pg-boss retries (the governance
//    report email does the same).
// 7. Best effort: `sentAt`, `emailLogId`. Nothing after the send throws.
//
// At most once per (share action, person): a crash between the claim and
// the send, or between the send and step 7, leaves the row claimed, so no
// later run sends again (that email is then lost, never doubled). The one
// way to get a second copy is an SMTP error reported to `sendMail` for a
// message the server had in fact accepted; the release then lets the retry
// send it again.

const log = logger.child({ module: "portal-notification-email" });

export type PortalNotificationOutcome =
  | "SENT"
  | "MAIL_BLOCKED"
  | "NOT_FOUND"
  | "ALREADY_CLAIMED"
  | "NO_PASSWORD"
  | "NOTHING_TO_SEND";

export interface PortalNotificationDeps {
  send: typeof sendMail;
  now: () => Date;
}

const defaultDeps: PortalNotificationDeps = {
  send: sendMail,
  now: () => new Date(),
};

/**
 * Builds and sends one notification email. Returns what happened (for the
 * integration script); the worker discards it. Throws only when the send
 * itself fails (after releasing the claim; pg-boss retries).
 */
export async function deliverPortalNotification(
  data: PortalNotificationEmailData,
  deps: PortalNotificationDeps = defaultDeps,
): Promise<PortalNotificationOutcome> {
  const ref = { notificationId: data.notificationId };

  // 1. Guard.
  if (currentMailDelivery("MEMBER_EMAIL").blockedReason !== null) {
    log.warn(ref, "[Portal] notification not sent: mail is not deliverable");
    return "MAIL_BLOCKED";
  }

  // 2. Load and re-check.
  const row = await db.portalNotification.findUnique({
    where: { id: data.notificationId },
    select: {
      id: true,
      companyId: true,
      portalUserId: true,
      kind: true,
      subjectLine: true,
      claimedAt: true,
    },
  });
  if (row === null || row.kind !== DOCUMENTS_SHARED_KIND) return "NOT_FOUND";
  if (row.claimedAt !== null) return "ALREADY_CLAIMED";
  const user = await db.portalUser.findFirst({
    where: { id: row.portalUserId, passwordHash: { not: null } },
    select: { email: true },
  });
  if (user === null) {
    log.info(
      { ...ref, outcome: "NO_PASSWORD" },
      "[Portal] notification skipped",
    );
    return "NO_PASSWORD";
  }
  const wanted = new Map(
    data.holders.map((h) => [h.stakeholderId, new Set(h.documentPublicIds)]),
  );
  const accesses = await db.portalAccess.findMany({
    where: {
      portalUserId: row.portalUserId,
      companyId: row.companyId,
      stakeholderId: { in: [...wanted.keys()] },
      status: "ACTIVE",
    },
    select: { publicId: true, stakeholderId: true },
    orderBy: { stakeholderId: "asc" },
  });
  const holderRows = await db.stakeholder.findMany({
    where: {
      companyId: row.companyId,
      id: { in: accesses.map((a) => a.stakeholderId) },
    },
    select: { id: true, name: true },
  });
  const nameOf = new Map(holderRows.map((h) => [h.id, h.name]));
  const told: {
    stakeholderId: string;
    accessPublicId: string;
    name: string;
    documentCount: number;
  }[] = [];
  for (const a of accesses) {
    const name = nameOf.get(a.stakeholderId);
    const docs = wanted.get(a.stakeholderId);
    if (name === undefined || docs === undefined) continue;
    const visible = await listVisibleDocuments(db, {
      companyId: row.companyId,
      stakeholderId: a.stakeholderId,
    });
    const documentCount = visible.filter((v) =>
      docs.has(v.document.publicId),
    ).length;
    if (documentCount === 0) continue;
    told.push({
      stakeholderId: a.stakeholderId,
      accessPublicId: a.publicId,
      name,
      documentCount,
    });
  }
  if (told.length === 0) {
    log.info(
      { ...ref, outcome: "NOTHING_TO_SEND" },
      "[Portal] notification skipped",
    );
    return "NOTHING_TO_SEND";
  }
  told.sort(
    (a, b) =>
      a.name.localeCompare(b.name, "en") ||
      (a.stakeholderId < b.stakeholderId ? -1 : 1),
  );

  // 3. Render.
  const company = await db.company.findUnique({
    where: { id: row.companyId },
    select: { name: true },
  });
  const companyName = company?.name ?? null;
  const html = await render(
    PortalNotificationEmail({
      companyName,
      holders: told.map((t) => ({
        name: t.name,
        documentCount: t.documentCount,
      })),
      signInUrl: documentsSignInUrl(
        env.NEXT_PUBLIC_BASE_URL,
        told.map((t) => t.accessPublicId),
      ),
    }),
  );

  // 4. Claim (own statement, committed at once).
  const claimedAt = deps.now();
  const claimed = await db.$executeRaw`
    UPDATE "PortalNotification"
    SET "claimedAt" = ${claimedAt}
    WHERE "id" = ${row.id} AND "claimedAt" IS NULL`;
  if (claimed !== 1) return "ALREADY_CLAIMED";

  // 5. Send; 6. release on failure.
  let emailLogId: string | null = null;
  try {
    ({ emailLogId } = await deps.send(
      {
        to: user.email,
        subject: row.subjectLine,
        html,
        ...(companyName ? { headers: { "X-From-Name": companyName } } : {}),
      },
      {
        kind: DOCUMENTS_SHARED_KIND,
        companyId: row.companyId,
        stakeholderId: logStakeholderId(told.map((t) => t.stakeholderId)),
        relatedType: "portalNotification",
        relatedId: row.id,
      },
    ));
  } catch (error) {
    await db.$executeRaw`
      UPDATE "PortalNotification"
      SET "claimedAt" = NULL
      WHERE "id" = ${row.id}
        AND "claimedAt" = ${claimedAt}
        AND "sentAt" IS NULL`;
    throw error;
  }

  // 7. Record (the claim stays whatever happens here).
  try {
    await db.$executeRaw`
      UPDATE "PortalNotification"
      SET "sentAt" = ${deps.now()}, "emailLogId" = ${emailLogId}
      WHERE "id" = ${row.id}`;
  } catch (error) {
    log.error(
      { ...ref, err: error instanceof Error ? error.message : String(error) },
      "[Portal] notification sent but not recorded",
    );
  }
  return "SENT";
}

export const portalNotificationEmailWorker = defineWorker(
  portalNotificationEmailConfig,
  async (job) => {
    await deliverPortalNotification(job.data);
  },
);
