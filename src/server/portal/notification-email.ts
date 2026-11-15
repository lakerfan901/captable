import "server-only";

import { z } from "zod";
import { logger } from "@/lib/logger";
import {
  type DOCUMENTS_SHARED_KIND,
  documentsSharedSubject,
  notificationRecipients,
  notificationSingletonKey,
} from "@/lib/portal/notification-core";
import { defineJob, defineWorkerConfig } from "@/lib/queue";
import type { PrismaTransactionalClient } from "@/server/db";

// The `portal.notification-email` job: its name, payload, the queueing
// inside the share transaction and the emit after commit
// (04-investor-portal.md 5.6, 5.8, 9.2 item 8; package P10). The worker
// that renders and sends is `src/jobs/portal-notification-email.ts`.
//
// One `PortalNotification` row per (portal user, kind, share action): the
// unique index `[portalUserId, kind, batchKey]` makes a second insert for the
// same person and action impossible, and the row's `claimedAt` is the
// worker's at-most-once claim.
//
// The payload carries ids only: the notification row and, per holder the
// person may be told about, the public ids of the documents that holder
// gained in this action (bounded by the share input: at most 50 documents).
// The worker re-reads everything (access ACTIVE, password set, documents
// still visible) before it sends. No name, address, link or token is queued.

const id = z.string().min(1).max(64);

export const portalNotificationEmailConfig = defineWorkerConfig({
  name: "portal.notification-email",
  policy: "stately",
  schema: z
    .object({
      notificationId: id,
      holders: z
        .array(
          z
            .object({
              stakeholderId: id,
              documentPublicIds: z.array(id).min(1).max(50),
            })
            .strict(),
        )
        .min(1)
        .max(500),
    })
    .strict(),
});

export type PortalNotificationEmailData = z.infer<
  typeof portalNotificationEmailConfig.schema
>;

/** The queue handle. Integration scripts replace `emit` to capture jobs. */
export const portalNotificationEmailJob = defineJob(
  portalNotificationEmailConfig,
);

/**
 * Inside the share transaction: one `PortalNotification` row per portal
 * user with an ACTIVE, password-set access to a holder that gained a
 * document (`gained`: holder id → document public ids it gained). Returns
 * the job payloads to emit after commit (one per row created). People
 * without a password (invitation not completed), with only DISABLED access,
 * or with access only to holders that gained nothing get no row.
 */
export async function queuePortalNotifications(
  tx: PrismaTransactionalClient,
  input: {
    companyId: string;
    kind: typeof DOCUMENTS_SHARED_KIND;
    batchKey: string;
    gained: ReadonlyMap<string, readonly string[]>;
  },
): Promise<PortalNotificationEmailData[]> {
  if (input.gained.size === 0) return [];
  const accesses = await tx.portalAccess.findMany({
    where: {
      companyId: input.companyId,
      stakeholderId: { in: [...input.gained.keys()] },
      status: "ACTIVE",
      portalUser: { passwordHash: { not: null } },
    },
    select: { portalUserId: true, stakeholderId: true, status: true },
  });
  const recipients = notificationRecipients(
    accesses.map((a) => ({ ...a, passwordSet: true })),
    input.gained.keys(),
  );
  if (recipients.size === 0) return [];
  const company = await tx.company.findUnique({
    where: { id: input.companyId },
    select: { name: true },
  });
  const subjectLine = documentsSharedSubject(company?.name ?? null);
  const rows = await tx.portalNotification.createManyAndReturn({
    data: [...recipients.keys()].map((portalUserId) => ({
      companyId: input.companyId,
      portalUserId,
      kind: input.kind,
      batchKey: input.batchKey,
      subjectLine,
    })),
    skipDuplicates: true,
    select: { id: true, portalUserId: true },
  });
  return rows.map((row) => ({
    notificationId: row.id,
    holders: (recipients.get(row.portalUserId) ?? []).map((stakeholderId) => ({
      stakeholderId,
      documentPublicIds: [...(input.gained.get(stakeholderId) ?? [])],
    })),
  }));
}

const log = logger.child({ module: "portal-notification-email" });

/**
 * Queues the notification jobs. Call AFTER the share transaction has
 * committed. Never throws: a failed enqueue is logged (notification id
 * only) and swallowed, so a committed share is never reported as failed;
 * that person then gets no email for this action (the documents are in the
 * portal regardless).
 */
export async function emitPortalNotifications(
  payloads: readonly PortalNotificationEmailData[],
): Promise<void> {
  for (const data of payloads) {
    try {
      await portalNotificationEmailJob.emit(data, {
        singletonKey: notificationSingletonKey(data.notificationId),
      });
    } catch (error) {
      log.error(
        {
          notificationId: data.notificationId,
          err: error instanceof Error ? error.message : String(error),
        },
        "[Portal] could not queue a notification email",
      );
    }
  }
}
