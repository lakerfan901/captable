// portalAdmin.unlock (04-investor-portal.md 5.6; rule P6, S9; package P3).
//
// Clears a sign-in lock in force (and the failure counter) of the person
// behind one ACTIVE access of the caller's company; without a lock in force
// nothing is written. The lock is account-wide (P6), so
// this lifts it for every holder the person may use; a team may lift it
// only for a person it has itself given active access. Under the user's row
// lock, the lock sign-in takes, so a concurrent wrong password is counted
// either before (and cleared) or after (and kept).
import { Audit } from "@/server/audit";
import { lockPortalUser } from "@/server/portal/account";
import { withLlcAccessControl } from "@/trpc/api/trpc";
import { ZAccessRefInput } from "../schema";
import { accessNotFound, auditContext, TX_OPTIONS } from "./shared";

export const unlockProcedure = withLlcAccessControl
  .meta({ policies: { portal: { allow: ["update"] } } })
  .input(ZAccessRefInput)
  .mutation(async ({ ctx, input }) => {
    const companyId = ctx.membership.companyId;
    const context = auditContext(ctx);

    const result = await ctx.db.$transaction(async (tx) => {
      const access = await tx.portalAccess.findFirst({
        where: { publicId: input.accessId, companyId, status: "ACTIVE" },
        select: { id: true, portalUserId: true, stakeholderId: true },
      });
      if (access === null) return null;
      const user = await lockPortalUser(tx, access.portalUserId);
      if (user === null) return null;
      // Re-check under the lock: a Disable may have committed meanwhile.
      const still = await tx.portalAccess.findFirst({
        where: { id: access.id, companyId, status: "ACTIVE" },
        select: { id: true },
      });
      if (still === null) return null;
      const now = new Date();
      const wasLocked =
        user.lockedUntil !== null && user.lockedUntil.getTime() > now.getTime();
      // Only a lock in force is lifted. Not locked: nothing is written, so
      // the failure counter cannot be reset (to allow more guesses) without
      // a lock and an audit row.
      if (!wasLocked) return { email: user.email, unlocked: false };
      await tx.portalUser.update({
        where: { id: user.id },
        data: { lockedUntil: null, failedSignIns: 0 },
        select: { id: true },
      });
      await Audit.create(
        {
          action: "portal.account-unlocked",
          companyId,
          actor: { type: "user", id: ctx.session.user.id },
          context,
          target: [
            { type: "portalAccess", id: access.id },
            { type: "stakeholder", id: access.stakeholderId },
          ],
          summary: `${ctx.session.user.name ?? "A user"} unlocked the investor portal sign-in of ${user.email}`,
        },
        tx,
      );
      return { email: user.email, unlocked: true };
    }, TX_OPTIONS);
    if (result === null) accessNotFound();

    return { ok: true as const, ...result };
  });
