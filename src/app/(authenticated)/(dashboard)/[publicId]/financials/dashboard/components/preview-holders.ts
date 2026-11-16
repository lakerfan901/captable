import "server-only";
import { db } from "@/server/db";

// The holders the team's "Preview as investor" lists (package P16), shared
// by the dashboard page and its print layout (P17).

/** The holders that can be previewed: those with a published month record of their own. */
export async function previewHolders(companyId: string) {
  const rows = await db.holderFinancialSnapshot.findMany({
    where: { companyId, supersededAt: null },
    distinct: ["stakeholderId"],
    select: { stakeholderId: true },
  });
  if (rows.length === 0) return [];
  const holders = await db.stakeholder.findMany({
    where: { companyId, id: { in: rows.map((r) => r.stakeholderId) } },
    select: { id: true, name: true },
    orderBy: [{ name: "asc" }, { id: "asc" }],
  });
  return holders;
}
