// portal.me (04-investor-portal.md 5.4; package P2a).
//
// The signed-in portal user's address and the holders they may act for:
// ACTIVE accesses whose holder row still exists in the access's company and
// whose company is an LLC (P9, P10). Sorted by company, then holder. Built
// field by field (G4): the access's public id, holder and company names and
// the company logo; never an internal id.

import { portalSessionProcedure } from "@/trpc/api/portal-procedure";

export const meProcedure = portalSessionProcedure.query(async ({ ctx }) => {
  const accesses = await ctx.db.portalAccess.findMany({
    where: { portalUserId: ctx.portalUser.id, status: "ACTIVE" },
    select: { publicId: true, companyId: true, stakeholderId: true },
  });
  if (accesses.length === 0) {
    return { email: ctx.portalUser.email, holders: [] };
  }
  const companyIds = [...new Set(accesses.map((a) => a.companyId))];
  const [stakeholders, companies] = await Promise.all([
    ctx.db.stakeholder.findMany({
      where: {
        id: { in: accesses.map((a) => a.stakeholderId) },
        companyId: { in: companyIds },
      },
      select: { id: true, companyId: true, name: true },
    }),
    ctx.db.company.findMany({
      where: { id: { in: companyIds }, entityType: "LLC" },
      select: { id: true, name: true, logo: true },
    }),
  ]);
  const stakeholderById = new Map(stakeholders.map((s) => [s.id, s]));
  const companyById = new Map(companies.map((c) => [c.id, c]));

  const holders: {
    access: string;
    holderName: string;
    companyName: string;
    companyLogo: string | null;
  }[] = [];
  for (const access of accesses) {
    const holder = stakeholderById.get(access.stakeholderId);
    const company = companyById.get(access.companyId);
    // The holder must belong to the access's own company (no cross-company
    // match through the id list).
    if (!holder || !company || holder.companyId !== access.companyId) continue;
    holders.push({
      access: access.publicId,
      holderName: holder.name,
      companyName: company.name,
      companyLogo: company.logo ?? null,
    });
  }
  holders.sort(
    (a, b) =>
      a.companyName.localeCompare(b.companyName) ||
      a.holderName.localeCompare(b.holderName) ||
      a.access.localeCompare(b.access),
  );
  return { email: ctx.portalUser.email, holders };
});
