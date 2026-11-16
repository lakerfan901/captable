// portal.documents.list (04-investor-portal.md 5.4, P13, P14; package P6).
//
// The documents shared with the holder of `input.access`, newest share
// first. The holder and company come only from `ctx.holder`, resolved by
// `investorProcedure` from the access row on this request (P10, G2); the
// rules are in `src/server/portal/visibility-documents.ts` and are
// re-evaluated on every call (P16). Output built field by field (G4): the
// document's public id, never a storage key, bucket id or holder id.

import {
  listVisibleDocuments,
  type PortalDocumentListItem,
  portalDocumentListItem,
} from "@/server/portal/visibility-documents";
import { investorProcedure } from "@/trpc/api/portal-procedure";

export type { PortalDocumentListItem };

export const documentsListProcedure = investorProcedure.query(
  async ({ ctx }): Promise<PortalDocumentListItem[]> => {
    const visible = await listVisibleDocuments(ctx.db, {
      companyId: ctx.holder.companyId,
      stakeholderId: ctx.holder.stakeholderId,
    });
    return visible.map(portalDocumentListItem);
  },
);
