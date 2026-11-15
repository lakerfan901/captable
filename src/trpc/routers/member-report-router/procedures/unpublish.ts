import { TRPCError } from "@trpc/server";
import { Audit } from "@/server/audit";
import { guardedWrite } from "@/server/governance/guarded";
import { withLlcAccessControl } from "@/trpc/api/trpc";
import { ZMemberReportUnpublishSchema } from "../schema";
import {
  auditContext,
  badRequest,
  loadLockedReport,
  readFrozenContent,
} from "./shared";

// memberReport.unpublish (04-investor-portal.md P24, 5.5; package P4a).
//
// SENT and published, under the report lock (re-read after it): sets
// `unpublishedAt` and `unpublishedById`, so the portal and the emailed link
// stop showing the report on the next request (the readers are P5a / P5b).
// A report sent before the portal (`publishedAt` never set) is refused: it
// was never in the portal, and its emailed links keep working as before.
// Already unpublished: nothing is written, `{ changed: false }`.
// Recipients, frozen content and the books are never touched. One guarded
// single-row update; audit `memberReport.unpublished`.

export const unpublishProcedure = withLlcAccessControl
  .meta({ policies: { governance: { allow: ["update"] } } })
  .input(ZMemberReportUnpublishSchema)
  .mutation(async ({ ctx, input }) => {
    const companyId = ctx.membership.companyId;
    const memberId = ctx.membership.memberId;
    const userName = ctx.session.user.name ?? "A user";
    const now = new Date();

    return await ctx.db.$transaction(
      async (tx) => {
        const report = await loadLockedReport(tx, companyId, input.publicId);
        if (report.status !== "SENT") {
          badRequest("Only a released report can be unpublished.");
        }
        if (report.publishedAt === null) {
          badRequest(
            "This report was sent before the investor portal and is not in the portal.",
          );
        }
        if (report.unpublishedAt !== null) {
          return { publicId: report.publicId, changed: false };
        }
        const written = await guardedWrite(() =>
          tx.memberReport.update({
            where: {
              id: report.id,
              companyId,
              status: "SENT",
              publishedAt: { not: null },
              unpublishedAt: null,
            },
            data: { unpublishedAt: now, unpublishedById: memberId },
            select: { id: true },
          }),
        );
        if (!written) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "The report changed meanwhile. Reload and try again.",
          });
        }
        const title =
          readFrozenContent(report.frozenContent)?.title ?? report.title;
        await Audit.create(
          {
            action: "memberReport.unpublished",
            companyId,
            actor: { type: "user", id: ctx.session.user.id },
            context: auditContext(ctx),
            target: [{ type: "memberReport", id: report.id }],
            summary: `${userName} unpublished the report "${title}" from the investor portal`,
          },
          tx,
        );
        return { publicId: report.publicId, changed: true };
      },
      { maxWait: 10_000, timeout: 30_000 },
    );
  });
