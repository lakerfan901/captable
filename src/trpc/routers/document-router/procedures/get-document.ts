import { getPresignedGetUrl } from "@/server/file-uploads";
import { assertKeyReadableByCompany } from "@/server/tenant-ownership";
import { withAccessControl } from "@/trpc/api/trpc";
import { TRPCError } from "@trpc/server";
import { ZodGetDocumentQuerySchema } from "../schema";

export const getDocumentProcedure = withAccessControl
  .input(ZodGetDocumentQuerySchema)
  .meta({ policies: { documents: { allow: ["read"] } } })
  .query(
    async ({
      ctx: {
        db,
        membership: { companyId },
      },
      input,
    }) => {
      const data = await db.document.findFirst({
        where: {
          publicId: input.publicId,
          companyId,
        },
        select: {
          bucket: {
            select: {
              key: true,
            },
          },
          company: { select: { id: true, publicId: true } },
        },
      });

      if (!data) {
        throw new TRPCError({ code: "NOT_FOUND" });
      }

      assertKeyReadableByCompany(data.bucket.key, data.company);

      return getPresignedGetUrl(data.bucket.key);
    },
  );
