// portal.documents.fileUrl (04-investor-portal.md 5.4, P13, P14, P16, S19;
// package P6).
//
// A mutation (so the URL is never in a page URL, and the client address in
// the log is the browser's, 2.2). Re-evaluates P13 and P14 for this one
// document now (`canOpenDocument`: grant for `ctx.holder`, document by
// `{ publicId, companyId }`, not tied to another holder, Bucket row present,
// key in the company namespace), checks the namespace again with
// `assertKeyReadableByCompany`, signs a 60-second GET of the private object,
// writes one `DOCUMENT_OPENED` row and returns `{ url, expiresInSeconds }`.
//
// Unknown, other-company, ungranted, revoked and bound-to-another-holder ids
// are one and the same message-less NOT_FOUND, and none writes a log row.
// Revoking a share takes effect on the next call; a URL issued before the
// revoke stays valid for at most 60 seconds (P16). The storage key and the
// bucket appear only inside the signed URL itself (they are its path); no
// other field carries them.

import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { getPresignedGetUrl } from "@/server/file-uploads";
import { writePortalLog } from "@/server/portal/log";
import { canOpenDocument } from "@/server/portal/visibility-documents";
import { assertKeyReadableByCompany } from "@/server/tenant-ownership";
import { investorProcedure } from "@/trpc/api/portal-procedure";

/** P16, S19: lifetime of a portal storage URL. */
export const PORTAL_FILE_URL_SECONDS = 60;

export const documentsFileUrlProcedure = investorProcedure
  .input(z.object({ documentId: z.string().min(1).max(64) }))
  .mutation(async ({ ctx, input }) => {
    const found = await canOpenDocument(
      ctx.db,
      {
        companyId: ctx.holder.companyId,
        stakeholderId: ctx.holder.stakeholderId,
      },
      input.documentId,
    );
    if (found === null) throw new TRPCError({ code: "NOT_FOUND" });
    assertKeyReadableByCompany(found.file.key, ctx.company);
    const { url } = await getPresignedGetUrl(
      found.file.key,
      { mimeType: found.file.mimeType, name: found.file.name },
      { expiresIn: PORTAL_FILE_URL_SECONDS },
    );
    await writePortalLog(ctx.db, ctx, {
      event: "DOCUMENT_OPENED",
      targetType: "document",
      targetId: found.document.id,
      targetName: found.document.name,
    });
    return { url, expiresInSeconds: PORTAL_FILE_URL_SECONDS };
  });
