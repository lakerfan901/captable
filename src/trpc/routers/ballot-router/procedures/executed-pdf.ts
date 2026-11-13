import { TRPCError } from "@trpc/server";
import { getPresignedGetUrl } from "@/server/file-uploads";
import { assertKeyReadableByCompany } from "@/server/tenant-ownership";
import { withoutAuth } from "@/trpc/api/trpc";
import { ZBallotTokenSchema } from "../schema";
import { resolveOpenBallot } from "./resolve";

// ballot.executedPdf (03-governance.md G8, A6). Public; an OK link only.
//
// Serves exactly one file: the executed PDF of THIS ballot's own resolution,
// only once that resolution is EFFECTIVE and the finalize job has filed it.
// The document is loaded by the id stored on the resolution AND the
// resolution's company; its bucket key must be in that company's namespace.
// Only a 10-minute presigned GET URL is returned (it is signed for that one
// object); the storage key, bucket and document ids are never returned.

const unavailable = (): never => {
  throw new TRPCError({
    code: "NOT_FOUND",
    message: "The executed document is not available.",
  });
};

export const executedPdfProcedure = withoutAuth
  .input(ZBallotTokenSchema)
  .query(async ({ ctx, input }) => {
    const { resolution, company } = await resolveOpenBallot(
      ctx.db,
      input.token,
      new Date(),
    );
    if (
      resolution.status !== "EFFECTIVE" ||
      resolution.executedDocumentId === null
    ) {
      return unavailable();
    }

    const document = await ctx.db.document.findFirst({
      where: {
        id: resolution.executedDocumentId,
        companyId: resolution.companyId,
      },
      select: { bucket: { select: { key: true, mimeType: true } } },
    });
    if (document?.bucket.mimeType !== "application/pdf") {
      return unavailable();
    }
    // Throws NOT_FOUND unless the key is in the company's namespace.
    assertKeyReadableByCompany(document.bucket.key, {
      id: company.id,
      publicId: company.publicId,
    });

    const { url } = await getPresignedGetUrl(document.bucket.key);
    return { url };
  });
