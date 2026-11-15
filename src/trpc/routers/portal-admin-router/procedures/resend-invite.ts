// portalAdmin.resendInvite (04-investor-portal.md 5.6; rules P5, P30;
// package P3).
//
// ACTIVE access only. A new SET_PASSWORD link (7 days; older unused ones
// stop working) while the person has no password, else the "you have
// access" email. Refused before any write while production mail goes to the
// mail catcher.
import { Audit } from "@/server/audit";
import { assertMailDeliverable } from "@/server/mail-delivery";
import { prepareResend, queueInviteEmail } from "@/server/portal/invite";
import { withLlcAccessControl } from "@/trpc/api/trpc";
import { ZAccessRefInput } from "../schema";
import { accessNotFound, auditContext, TX_OPTIONS } from "./shared";

export const resendInviteProcedure = withLlcAccessControl
  .meta({ policies: { portal: { allow: ["update"] } } })
  .input(ZAccessRefInput)
  .mutation(async ({ ctx, input }) => {
    assertMailDeliverable("MEMBER_EMAIL");

    const companyId = ctx.membership.companyId;
    const context = auditContext(ctx);
    const result = await ctx.db.$transaction(async (tx) => {
      const prepared = await prepareResend(tx, {
        companyId,
        accessPublicId: input.accessId,
        requestIp: context.requestIp,
      });
      if (prepared === null) return null;
      const holder = await tx.stakeholder.findFirst({
        where: { id: prepared.stakeholderId, companyId },
        select: { name: true },
      });
      await Audit.create(
        {
          action: "portal.invite-resent",
          companyId,
          actor: { type: "user", id: ctx.session.user.id },
          context,
          target: [
            { type: "portalAccess", id: prepared.accessId },
            { type: "stakeholder", id: prepared.stakeholderId },
          ],
          summary: `${ctx.session.user.name ?? "A user"} sent the investor portal invitation to ${prepared.email} again${holder ? ` for ${holder.name}` : ""}`,
        },
        tx,
      );
      return prepared;
    }, TX_OPTIONS);
    if (result === null) accessNotFound();

    await queueInviteEmail(result);
    return { ok: true as const, email: result.email };
  });
