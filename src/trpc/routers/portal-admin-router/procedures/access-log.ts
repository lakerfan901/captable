// portalAdmin.accessLog (04-investor-portal.md 5.6, P31; package P6).
//
// The portal access log of this company, newest first, 50 rows per page,
// with holder name and portal user email.
//
// Which rows:
// - every row with this `companyId` (report views, file opens, exports);
// - account events that belong to no company (sign-in, sign-out, lock,
//   password set: `companyId` null) of portal users who hold, or held, an
//   access to a holder of this company (B11: the Activity tab shows the
//   sign-in). With `stakeholderId`, only users with an access to that
//   holder. Account events are left out when a target filter is given.
//   Such a row says only that the person signed in to the portal; what
//   they then opened in another company is never shown.
//
// Filters are company-scoped: a `stakeholderId` or `targetId` of another
// company simply matches nothing. `targetId` is the id the portal stored:
// `Document.id` for `document` rows (P6), the report's and attachment's ids
// for the report rows (P5). Paging is keyset on `(createdAt, id)` with an
// opaque `nextCursor`.

import type { Prisma } from "@prisma/client";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import {
  ACCESS_LOG_PAGE,
  ACCOUNT_EVENTS,
  decodeLogCursor,
  encodeLogCursor,
} from "@/lib/portal/document-share-core";
import type { PortalEventEnum } from "@/prisma/enums";
import { withLlcAccessControl } from "@/trpc/api/trpc";

export const ZAccessLogInput = z.object({
  stakeholderId: z.string().min(1).max(64).optional(),
  targetType: z
    .enum(["memberReport", "memberReportAttachment", "document"])
    .optional(),
  targetId: z.string().min(1).max(64).optional(),
  cursor: z.string().min(1).max(100).optional(),
});

export const accessLogProcedure = withLlcAccessControl
  .meta({ policies: { portal: { allow: ["read"] } } })
  .input(ZAccessLogInput)
  .query(async ({ ctx, input }) => {
    const companyId = ctx.membership.companyId;
    const db = ctx.db;

    const cursor =
      input.cursor === undefined ? null : decodeLogCursor(input.cursor);
    if (input.cursor !== undefined && cursor === null) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid cursor." });
    }

    const companyRows: Prisma.PortalAccessLogWhereInput = {
      companyId,
      ...(input.stakeholderId !== undefined && {
        stakeholderId: input.stakeholderId,
      }),
      ...(input.targetType !== undefined && { targetType: input.targetType }),
      ...(input.targetId !== undefined && { targetId: input.targetId }),
    };
    const branches: Prisma.PortalAccessLogWhereInput[] = [companyRows];
    if (input.targetType === undefined && input.targetId === undefined) {
      const accesses = await db.portalAccess.findMany({
        where: {
          companyId,
          ...(input.stakeholderId !== undefined && {
            stakeholderId: input.stakeholderId,
          }),
        },
        select: { portalUserId: true },
      });
      const userIds = [...new Set(accesses.map((a) => a.portalUserId))];
      if (userIds.length > 0) {
        branches.push({
          companyId: null,
          portalUserId: { in: userIds },
          event: { in: ACCOUNT_EVENTS as PortalEventEnum[] },
        });
      }
    }

    const rows = await db.portalAccessLog.findMany({
      where: {
        OR: branches,
        ...(cursor !== null && {
          AND: [
            {
              OR: [
                { createdAt: { lt: cursor.createdAt } },
                { createdAt: cursor.createdAt, id: { lt: cursor.id } },
              ],
            },
          ],
        }),
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: ACCESS_LOG_PAGE + 1,
      select: {
        id: true,
        createdAt: true,
        companyId: true,
        event: true,
        portalUserId: true,
        stakeholderId: true,
        targetType: true,
        targetId: true,
        targetName: true,
        ip: true,
        userAgent: true,
      },
    });
    const page = rows.slice(0, ACCESS_LOG_PAGE);
    const last = page[page.length - 1];
    const nextCursor =
      rows.length > ACCESS_LOG_PAGE && last !== undefined
        ? encodeLogCursor(last)
        : null;

    const holderIds = [
      ...new Set(
        page.flatMap((r) => (r.stakeholderId ? [r.stakeholderId] : [])),
      ),
    ];
    const userIds = [...new Set(page.map((r) => r.portalUserId))];
    const [holders, users] = await Promise.all([
      db.stakeholder.findMany({
        where: { companyId, id: { in: holderIds } },
        select: { id: true, name: true },
      }),
      db.portalUser.findMany({
        where: { id: { in: userIds } },
        select: { id: true, email: true },
      }),
    ]);
    const holderName = new Map(holders.map((h) => [h.id, h.name]));
    const userEmail = new Map(users.map((u) => [u.id, u.email]));

    return {
      rows: page.map((r) => ({
        id: r.id,
        at: r.createdAt,
        event: r.event,
        /** false for sign-in, sign-out, lock and password events (no company). */
        companyScoped: r.companyId !== null,
        holder:
          r.stakeholderId === null
            ? null
            : {
                stakeholderId: r.stakeholderId,
                name: holderName.get(r.stakeholderId) ?? null,
              },
        portalUserEmail: userEmail.get(r.portalUserId) ?? null,
        target:
          r.targetType === null
            ? null
            : { type: r.targetType, id: r.targetId, name: r.targetName },
        ip: r.ip,
        userAgent: r.userAgent,
      })),
      nextCursor,
    };
  });
