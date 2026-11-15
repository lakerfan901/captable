// portal.documents.list (04-investor-portal.md 5.4, P13, P14; package P6).
//
// The documents shared with the holder of `input.access`, newest share
// first. The holder and company come only from `ctx.holder`, resolved by
// `investorProcedure` from the access row on this request (P10, G2); the
// rules are in `src/server/portal/visibility-documents.ts` and are
// re-evaluated on every call (P16). Output built field by field (G4): the
// document's public id, never a storage key, bucket id or holder id.

import { isInlineContentType } from "@/lib/inline-content-type";
import { listVisibleDocuments } from "@/server/portal/visibility-documents";
import { investorProcedure } from "@/trpc/api/portal-procedure";

export interface PortalDocumentListItem {
  /** `Document.publicId`; the input of `portal.documents.fileUrl`. */
  id: string;
  name: string;
  sharedAt: Date;
  /** PDF and raster images open in the browser; anything else downloads. */
  inline: boolean;
  sizeBytes: number;
  /** Books-and-records category (`BooksRecordCategoryEnum`), or null. */
  category: string | null;
}

export const documentsListProcedure = investorProcedure.query(
  async ({ ctx }): Promise<PortalDocumentListItem[]> => {
    const visible = await listVisibleDocuments(ctx.db, {
      companyId: ctx.holder.companyId,
      stakeholderId: ctx.holder.stakeholderId,
    });
    return visible.map((v) => ({
      id: v.document.publicId,
      name: v.document.name,
      sharedAt: v.sharedAt,
      inline: isInlineContentType(v.file.mimeType),
      sizeBytes: v.file.size,
      category: v.document.recordCategory,
    }));
  },
);
