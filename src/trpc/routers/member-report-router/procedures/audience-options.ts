import { GOVERNANCE_TIME_ZONE, todayInZone } from "@/lib/governance/dates";
import { currentMailDelivery } from "@/server/mail-delivery";
import { withLlcAccessControl } from "@/trpc/api/trpc";
import { ZMemberReportAudienceOptionsSchema } from "../schema";
import { loadAudienceContext } from "./audience";
import { asReportType, findReportRef } from "./shared";

// memberReport.audienceOptions (04-investor-portal.md P18, 5.5; package P4a):
// what the release dialog's audience picker shows. Read only, no locks; the
// release re-checks everything under its locks.
//
// Every holder of the company that may receive this report (a Member or a
// Financial-Interest-only holder; never a prospect), with its units today,
// whether a K-1 of this report names it, its notice address, whether it is
// already a recipient and when it was emailed, and its portal state; the
// presets and the default one (P18); for a transfer notice the transferring
// Member is marked `transferor`. `deadlineAudienceIds` are the holders whose
// selection with email closes the report's deadline (`deadlineOutcome`).

export const audienceOptionsProcedure = withLlcAccessControl
  .meta({ policies: { governance: { allow: ["read"] } } })
  .input(ZMemberReportAudienceOptionsSchema)
  .query(async ({ ctx, input }) => {
    const companyId = ctx.membership.companyId;
    const zone = ctx.company.timezone || GOVERNANCE_TIME_ZONE;
    const today = todayInZone(new Date(), zone);
    const ref = await findReportRef(ctx.db, companyId, input.publicId);
    const report = await ctx.db.memberReport.findFirstOrThrow({
      where: { id: ref.id, companyId },
      select: { id: true, type: true, noticeKind: true, status: true },
    });
    const audience = await loadAudienceContext(
      ctx.db,
      companyId,
      report,
      today,
    );
    const recipients = await ctx.db.memberReportRecipient.findMany({
      where: { reportId: report.id, companyId },
      select: { stakeholderId: true, sentAt: true },
    });
    const recipientOf = new Map(
      recipients.map((r) => [r.stakeholderId, r.sentAt]),
    );

    return {
      type: asReportType(report.type),
      status: report.status,
      today,
      holders: audience.holders
        .filter(
          (h) =>
            h.memberStatus === "MEMBER" ||
            h.memberStatus === "FINANCIAL_INTEREST_ONLY",
        )
        .map((h) => ({
          stakeholderId: h.stakeholderId,
          name: h.name,
          memberStatus: h.memberStatus,
          preferredUnits: h.preferredUnits,
          commonUnits: h.commonUnits,
          noticeEmail: h.noticeEmail,
          hasK1: h.hasK1,
          isRecipient: recipientOf.has(h.stakeholderId),
          emailedAt: recipientOf.get(h.stakeholderId) ?? null,
          portal: h.portal,
          transferor: h.stakeholderId === audience.transferorId,
        })),
      presets: audience.presets.presets,
      defaultPreset: audience.presets.defaultPreset,
      deadlineAudienceIds: audience.deadlineAudienceIds,
      /** Production with the mail catcher: release WITH email is refused. */
      mailDelivery: currentMailDelivery("REPORT"),
    };
  });
