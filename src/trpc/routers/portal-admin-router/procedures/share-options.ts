// portalAdmin.shareOptions (04-investor-portal.md 5.6, P14, P28, S6;
// package P6). Read only, no locks: `shareDocuments` re-checks everything
// under its locks.
//
// For the share dialog (P9): every holder of the company with its status,
// units today, whether it is a current Member and its portal state; the
// presets (all current Members, Preferred, Common; prospects are in no
// preset but can be ticked by hand); and per document its current share
// list, whether it can be shared with anyone, only with one holder, or with
// nobody (`shareability`), the current Members not on its list (P28) and the
// S6 warnings for files that name other Members.

import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { GOVERNANCE_TIME_ZONE, todayInZone } from "@/lib/governance/dates";
import { fromMicro, toMicro } from "@/lib/llc/voting";
import {
  type AudienceHolder,
  documentSharePresets,
  type HolderMemberStatus,
  isCurrentMember,
} from "@/lib/portal/audience-core";
import { missingCurrentMembers } from "@/lib/portal/document-share-core";
import type { TPrismaOrTransaction } from "@/server/db";
import { loadUnitPositions } from "@/server/governance/positions";
import {
  loadCompanyDocuments,
  loadDocumentFacts,
} from "@/server/portal/visibility-documents";
import { withLlcAccessControl } from "@/trpc/api/trpc";
import { loadPortalStates } from "@/trpc/routers/member-report-router/procedures/audience";

export const ZShareOptionsInput = z.object({
  documentPublicIds: z.array(z.string().min(1).max(64)).min(1).max(50),
});

export interface ShareOptionHolder extends AudienceHolder {
  name: string;
  isCurrentMember: boolean;
  portal: "NONE" | "INVITED" | "ACTIVE";
}

/** Every holder of the company, by name, with what the picker and the presets need. */
export async function loadShareHolders(
  tx: TPrismaOrTransaction,
  companyId: string,
  timezone: string | null,
): Promise<ShareOptionHolder[]> {
  const today = todayInZone(new Date(), timezone || GOVERNANCE_TIME_ZONE);
  const stakeholders = await tx.stakeholder.findMany({
    where: { companyId },
    select: { id: true, name: true, memberStatus: true },
  });
  const positions = await loadUnitPositions(tx, companyId, today);
  const portal = await loadPortalStates(
    tx,
    companyId,
    stakeholders.map((s) => s.id),
  );
  const units = new Map<string, { preferred: bigint; common: bigint }>();
  for (const p of positions) {
    const row = units.get(p.stakeholderId) ?? { preferred: 0n, common: 0n };
    if (p.unitClassKind === "PREFERRED") row.preferred += toMicro(p.units);
    else row.common += toMicro(p.units);
    units.set(p.stakeholderId, row);
  }
  return stakeholders
    .map((s) => {
      const u = units.get(s.id) ?? { preferred: 0n, common: 0n };
      const holder: AudienceHolder = {
        stakeholderId: s.id,
        memberStatus: s.memberStatus as HolderMemberStatus,
        preferredUnits: fromMicro(u.preferred),
        commonUnits: fromMicro(u.common),
        hasK1: false,
      };
      return {
        ...holder,
        name: s.name,
        isCurrentMember: isCurrentMember(holder),
        portal: portal.get(s.id) ?? "NONE",
      };
    })
    .sort(
      (a, b) =>
        a.name.localeCompare(b.name, "en") ||
        (a.stakeholderId < b.stakeholderId ? -1 : 1),
    );
}

export type Shareability =
  | { kind: "ANY" }
  | { kind: "HOLDER_ONLY"; stakeholderId: string; holderName: string | null }
  | { kind: "NONE"; reason: "MULTIPLE_HOLDERS" | "HOLDER_REMOVED" };

export const shareOptionsProcedure = withLlcAccessControl
  .meta({ policies: { portal: { allow: ["read"] } } })
  .input(ZShareOptionsInput)
  .query(async ({ ctx, input }) => {
    const companyId = ctx.membership.companyId;
    const requested = [...new Set(input.documentPublicIds)];
    const documents = await loadCompanyDocuments(ctx.db, companyId, {
      publicIds: requested,
    });
    if (documents.length !== requested.length) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "One or more documents were not found.",
      });
    }
    const facts = await loadDocumentFacts(ctx.db, companyId, documents);
    const holders = await loadShareHolders(
      ctx.db,
      companyId,
      ctx.company.timezone,
    );
    const nameOf = new Map(holders.map((h) => [h.stakeholderId, h.name]));
    const grants = await ctx.db.portalDocumentGrant.findMany({
      where: { companyId, documentId: { in: documents.map((d) => d.id) } },
      select: { documentId: true, stakeholderId: true, createdAt: true },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    const byPublicId = new Map(documents.map((d) => [d.publicId, d]));

    return {
      holders: holders.map((h) => ({
        stakeholderId: h.stakeholderId,
        name: h.name,
        memberStatus: h.memberStatus,
        preferredUnits: h.preferredUnits,
        commonUnits: h.commonUnits,
        isCurrentMember: h.isCurrentMember,
        portal: h.portal,
      })),
      presets: documentSharePresets(holders),
      documents: requested.map((publicId) => {
        const doc = byPublicId.get(publicId);
        const f = doc ? facts.get(doc.id) : undefined;
        if (doc === undefined || f === undefined) {
          throw new TRPCError({ code: "NOT_FOUND" });
        }
        const mine = grants.filter((g) => g.documentId === doc.id);
        const shareability: Shareability =
          f.binding.kind === "HOLDER_ONLY"
            ? {
                kind: "HOLDER_ONLY",
                stakeholderId: f.binding.stakeholderId,
                holderName: nameOf.get(f.binding.stakeholderId) ?? null,
              }
            : f.binding.kind === "NONE"
              ? { kind: "NONE", reason: f.binding.reason }
              : { kind: "ANY" };
        return {
          documentPublicId: doc.publicId,
          name: doc.name,
          source: f.source,
          category: doc.recordCategory,
          year: doc.recordYear,
          shareability,
          /** Holders on the list; `name` is null for a row whose holder was deleted. */
          sharedWith: mine.map((g) => ({
            stakeholderId: g.stakeholderId,
            name: nameOf.get(g.stakeholderId) ?? null,
            sharedAt: g.createdAt,
          })),
          missingCurrentMembers: missingCurrentMembers(
            f.binding,
            holders,
            new Set(mine.map((g) => g.stakeholderId)),
          ),
          warnings: f.warnings,
        };
      }),
    };
  });
