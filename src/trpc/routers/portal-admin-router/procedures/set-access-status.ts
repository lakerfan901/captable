// portalAdmin.setAccessStatus (04-investor-portal.md 5.6; rules P9, P16;
// package P3).
//
// Disable / Enable one access. Needs no email. A guarded single-row update
// (`{ id, companyId, status: <the other one> }`), so two team members
// pressing at once write one change and one audit row; pressing again is a
// no-op.
//
// Sessions are NOT revoked. A portal session belongs to the person, not to
// one access: revoking it would sign them out of their other holders, which
// this team may not even know about. Disabling is still effective on the
// next request, because every portal request re-reads the access row with
// `status: "ACTIVE"` (`resolveHolder`, `portal.me`); a person with no ACTIVE
// access left keeps a session that reaches nothing (P9) and cannot sign in
// again or receive a reset link until an access is enabled. An invitation
// link not yet used stops working at the same moment (`peekToken`,
// `setPasswordWithToken` and the email worker require an ACTIVE access).
import { Audit } from "@/server/audit";
import { guardedUpdate } from "@/server/guarded-write";
import { lockPortalUser } from "@/server/portal/account";
import { withLlcAccessControl } from "@/trpc/api/trpc";
import { ZSetAccessStatusInput } from "../schema";
import { accessNotFound, auditContext, TX_OPTIONS } from "./shared";

export const setAccessStatusProcedure = withLlcAccessControl
  .meta({ policies: { portal: { allow: ["update"] } } })
  .input(ZSetAccessStatusInput)
  .mutation(async ({ ctx, input }) => {
    const companyId = ctx.membership.companyId;
    const memberId = ctx.membership.memberId;
    const context = auditContext(ctx);
    const disable = input.status === "DISABLED";

    const result = await ctx.db.$transaction(async (tx) => {
      const access = await tx.portalAccess.findFirst({
        where: { publicId: input.accessId, companyId },
        select: { id: true, portalUserId: true, stakeholderId: true },
      });
      if (access === null) return null;
      // The lock every invite of this person takes, so Enable and a
      // re-invitation of the same row cannot interleave.
      const user = await lockPortalUser(tx, access.portalUserId);
      if (user === null) return null;
      // Re-read under the lock; already in the asked state (a second click,
      // another team member) is a no-op without a write.
      const current = await tx.portalAccess.findFirst({
        where: { id: access.id, companyId },
        select: { status: true },
      });
      if (current === null) return null;
      if (current.status === input.status) {
        return { email: user.email, changed: false };
      }
      const now = new Date();
      const changed = await guardedUpdate(() =>
        tx.portalAccess.update({
          where: {
            id: access.id,
            companyId,
            status: disable ? "ACTIVE" : "DISABLED",
          },
          data: disable
            ? { status: "DISABLED", disabledAt: now, disabledById: memberId }
            : { status: "ACTIVE", disabledAt: null, disabledById: null },
          select: { id: true },
        }),
      );
      if (changed === null) {
        // Already in the asked state (a second click, another team member).
        return { email: user.email, changed: false };
      }
      const holder = await tx.stakeholder.findFirst({
        where: { id: access.stakeholderId, companyId },
        select: { name: true },
      });
      await Audit.create(
        {
          action: disable ? "portal.access-disabled" : "portal.access-enabled",
          companyId,
          actor: { type: "user", id: ctx.session.user.id },
          context,
          target: [
            { type: "portalAccess", id: access.id },
            { type: "stakeholder", id: access.stakeholderId },
          ],
          summary: `${ctx.session.user.name ?? "A user"} ${
            disable ? "disabled" : "enabled"
          } investor portal access for ${user.email}${
            holder ? ` to ${holder.name}` : ""
          }`,
        },
        tx,
      );
      return { email: user.email, changed: true };
    }, TX_OPTIONS);
    if (result === null) accessNotFound();

    return { ok: true as const, ...result, status: input.status };
  });
