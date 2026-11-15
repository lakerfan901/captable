import { TRPCError } from "@trpc/server";
import { Audit } from "@/server/audit";
import { guardedWrite } from "@/server/governance/guarded";
import { withLlcAccessControl } from "@/trpc/api/trpc";
import { ZMemberReportPublishSchema } from "../schema";
import {
  auditContext,
  badRequest,
  loadLockedReport,
  readFrozenContent,
} from "./shared";

// memberReport.publish (04-investor-portal.md P24, 5.5; package P4a).
//
// SENT only, under the report lock (re-read after it):
// - unpublished (`unpublishedAt` set): clears `unpublishedAt` (and its
//   author); the report is visible again in the portal and through the
//   emailed link to the same recipients as before;
// - sent before the portal (`publishedAt` never set): sets `publishedAt`
//   and `publishedById`; its recipients are the existing rows;
// - already published: nothing is written, `{ changed: false }` (a second
//   click is not an error).
// Recipients, frozen content and the books are never touched. One guarded
// single-row update; audit `memberReport.published`.

export const publishProcedure = withLlcAccessControl
  .meta({ policies: { governance: { allow: ["update"] } } })
  .input(ZMemberReportPublishSchema)
  .mutation(async ({ ctx, input }) => {
    const companyId = ctx.membership.companyId;
    const memberId = ctx.membership.memberId;
    const userName = ctx.session.user.name ?? "A user";
    const now = new Date();

    return await ctx.db.$transaction(
      async (tx) => {
        const report = await loadLockedReport(tx, companyId, input.publicId);
        if (report.status !== "SENT") {
          badRequest("Only a released report can be published.");
        }
        const wasUnpublished = report.unpublishedAt !== null;
        const neverPublished = report.publishedAt === null;
        if (!wasUnpublished && !neverPublished) {
          return { publicId: report.publicId, changed: false };
        }
        const written = await guardedWrite(() =>
          tx.memberReport.update({
            where: {
              id: report.id,
              companyId,
              status: "SENT",
              ...(wasUnpublished
                ? { unpublishedAt: { not: null } }
                : { publishedAt: null, unpublishedAt: null }),
            },
            data: {
              unpublishedAt: null,
              unpublishedById: null,
              ...(neverPublished
                ? { publishedAt: now, publishedById: memberId }
                : {}),
            },
            select: { id: true },
          }),
        );
        if (!written) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "The report changed meanwhile. Reload and try again.",
          });
        }
        const recipients = await tx.memberReportRecipient.count({
          where: { reportId: report.id, companyId },
        });
        const title =
          readFrozenContent(report.frozenContent)?.title ?? report.title;
        await Audit.create(
          {
            action: "memberReport.published",
            companyId,
            actor: { type: "user", id: ctx.session.user.id },
            context: auditContext(ctx),
            target: [{ type: "memberReport", id: report.id }],
            summary: `${userName} ${
              wasUnpublished ? "published again" : "published"
            } the report "${title}" in the investor portal for its ${recipients} ${
              recipients === 1 ? "recipient" : "recipients"
            }${neverPublished ? " (released before the portal existed)" : ""}`,
          },
          tx,
        );
        return { publicId: report.publicId, changed: true };
      },
      { maxWait: 10_000, timeout: 30_000 },
    );
  });
