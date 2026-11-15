// portalAdmin.overview (04-investor-portal.md 5.6; package P3; the page
// that shows it is P9).
//
// Every portal access of the caller's company, with the holder's name, the
// address, the company-scoped state (`describeAccess`), last seen, and the
// number of reports and documents the holder can see in the portal.
//
// The two counts apply the visibility rules of 5.4 directly (reports: P11;
// documents: P13, P14 with the holder and document re-read in this company).
// When P5 / P6 land `src/server/portal/visibility-{reports,documents}.ts`,
// these counts should call those modules instead, so the rule is written
// once.
import { describeAccess } from "@/lib/portal/access-admin-core";
import { withLlcAccessControl } from "@/trpc/api/trpc";

export const overviewProcedure = withLlcAccessControl
  .meta({ policies: { portal: { allow: ["read"] } } })
  .query(async ({ ctx }) => {
    const companyId = ctx.membership.companyId;
    const rows = await ctx.db.portalAccess.findMany({
      where: { companyId },
      orderBy: [{ invitedAt: "desc" }, { id: "asc" }],
      take: 2000,
      select: {
        publicId: true,
        stakeholderId: true,
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
    const holderIds = [...new Set(rows.map((r) => r.stakeholderId))];
    if (holderIds.length === 0) return [];

    const [holders, reports, grants] = await Promise.all([
      ctx.db.stakeholder.findMany({
        where: { companyId, id: { in: holderIds } },
        select: { id: true, name: true },
      }),
      ctx.db.memberReportRecipient.findMany({
        where: {
          companyId,
          stakeholderId: { in: holderIds },
          report: {
            companyId,
            status: "SENT",
            publishedAt: { not: null },
            unpublishedAt: null,
          },
        },
        select: { stakeholderId: true, reportId: true },
      }),
      ctx.db.portalDocumentGrant.findMany({
        where: { companyId, stakeholderId: { in: holderIds } },
        select: { stakeholderId: true, documentId: true },
      }),
    ]);
    const documents = await ctx.db.document.findMany({
      where: {
        companyId,
        id: { in: [...new Set(grants.map((g) => g.documentId))] },
      },
      select: { id: true, stakeholderId: true },
    });
    const docOwner = new Map(documents.map((d) => [d.id, d.stakeholderId]));

    const holderName = new Map(holders.map((h) => [h.id, h.name]));
    const reportCount = new Map<string, Set<string>>();
    for (const r of reports) {
      const set = reportCount.get(r.stakeholderId) ?? new Set<string>();
      set.add(r.reportId);
      reportCount.set(r.stakeholderId, set);
    }
    const documentCount = new Map<string, number>();
    for (const g of grants) {
      if (!docOwner.has(g.documentId)) continue;
      const owner = docOwner.get(g.documentId);
      if (owner && owner !== g.stakeholderId) continue; // P14
      documentCount.set(
        g.stakeholderId,
        (documentCount.get(g.stakeholderId) ?? 0) + 1,
      );
    }

    const now = new Date();
    return rows
      .filter((r) => r.portalUser !== null && holderName.has(r.stakeholderId))
      .map((r) => {
        const view = describeAccess(r, r.portalUser, now);
        return {
          accessId: r.publicId,
          stakeholderId: r.stakeholderId,
          holderName: holderName.get(r.stakeholderId) ?? "",
          email: r.portalUser.email,
          status: view.state,
          passwordSet: view.passwordSet,
          locked: view.locked,
          invitedAt: r.invitedAt,
          inviteSentAt: r.inviteSentAt,
          lastSeenAt: r.lastSeenAt,
          disabledAt: r.disabledAt,
          reportCount: reportCount.get(r.stakeholderId)?.size ?? 0,
          documentCount: documentCount.get(r.stakeholderId) ?? 0,
        };
      });
  });
