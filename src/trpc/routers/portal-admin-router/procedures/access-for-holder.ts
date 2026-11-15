// portalAdmin.accessForHolder (04-investor-portal.md 5.6; package P3).
//
// The portal accesses of one holder of the caller's company, for the
// "Portal access" card on the member page. Company-scoped facts only
// (`describeAccess`): nothing about the person's accesses for other holders
// or companies, and never the person's name or account-wide sign-in time.
import { describeAccess } from "@/lib/portal/access-admin-core";
import { withLlcAccessControl } from "@/trpc/api/trpc";
import { ZAccessForHolderInput } from "../schema";
import { memberNotFound } from "./shared";

export const accessForHolderProcedure = withLlcAccessControl
  .meta({ policies: { portal: { allow: ["read"] } } })
  .input(ZAccessForHolderInput)
  .query(async ({ ctx, input }) => {
    const companyId = ctx.membership.companyId;
    const holder = await ctx.db.stakeholder.findFirst({
      where: { id: input.stakeholderId, companyId },
      select: { id: true },
    });
    if (holder === null) memberNotFound();

    const rows = await ctx.db.portalAccess.findMany({
      where: { companyId, stakeholderId: holder.id },
      orderBy: [{ invitedAt: "asc" }, { id: "asc" }],
      select: {
        publicId: true,
        status: true,
        invitedAt: true,
        inviteSentAt: true,
        lastSeenAt: true,
        disabledAt: true,
        portalUser: {
          select: { email: true, passwordSetAt: true, lockedUntil: true },
        },
      },
    });
    const now = new Date();
    return rows
      .filter((row) => row.portalUser !== null)
      .map((row) => {
        const view = describeAccess(row, row.portalUser, now);
        return {
          accessId: row.publicId,
          email: row.portalUser.email,
          status: view.state,
          passwordSet: view.passwordSet,
          locked: view.locked,
          invitedAt: row.invitedAt,
          inviteSentAt: row.inviteSentAt,
          lastSeenAt: row.lastSeenAt,
          disabledAt: row.disabledAt,
        };
      });
  });
