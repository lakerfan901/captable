import "server-only";

import type { PortalEventEnum } from "@/prisma/enums";
import type { TPrismaOrTransaction } from "@/server/db";

// The portal access log (04-investor-portal.md P31, `PortalAccessLog`).
// One row per sign-in, sign-out, lock, password set, report view, file open
// and export. Sign-in, sign-out, lock and password events belong to no single
// company (`companyId` null); events about a report or a document carry the
// holder resolved by `investorProcedure` (P10).
//
// Never put a token, a password or a storage URL in any column here.

/** Request facts a log row records. `requestIp` and `userAgent` come from the tRPC context or the route handler. */
export interface PortalLogContext {
  portalUser: { id: string };
  requestIp: string;
  userAgent: string;
  /** Present for events about one holder's data (set by `investorProcedure`). */
  holder?: { accessId: string; stakeholderId: string; companyId: string };
}

export interface PortalLogEntry {
  event: PortalEventEnum;
  targetType?: "memberReport" | "memberReportAttachment" | "document";
  targetId?: string;
  /** The name at the time, so the log still reads after a delete. */
  targetName?: string;
}

const MAX_IP = 64;
const MAX_USER_AGENT = 512;
const MAX_TARGET_NAME = 300;

/** Bounds a client-supplied header value before it is stored. */
function bound(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

/** Writes one `PortalAccessLog` row and returns its id (the event id of the account emails). */
export async function writePortalLog(
  db: TPrismaOrTransaction,
  ctx: PortalLogContext,
  entry: PortalLogEntry,
): Promise<{ id: string }> {
  const row = await db.portalAccessLog.create({
    data: {
      companyId: ctx.holder?.companyId ?? null,
      portalUserId: ctx.portalUser.id,
      portalAccessId: ctx.holder?.accessId ?? null,
      stakeholderId: ctx.holder?.stakeholderId ?? null,
      event: entry.event,
      targetType: entry.targetType ?? null,
      targetId: entry.targetId ?? null,
      targetName:
        entry.targetName === undefined
          ? null
          : bound(entry.targetName, MAX_TARGET_NAME),
      ip: bound(ctx.requestIp, MAX_IP),
      userAgent: bound(ctx.userAgent, MAX_USER_AGENT),
    },
    select: { id: true },
  });
  return row;
}
