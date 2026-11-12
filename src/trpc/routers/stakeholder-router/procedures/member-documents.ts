import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { withLlcAccessControl } from "@/trpc/api/trpc";

export const memberDocumentsProcedure = withLlcAccessControl
  .meta({
    policies: {
      stakeholder: { allow: ["read"] },
      documents: { allow: ["read"] },
    },
  })
  .input(z.object({ stakeholderId: z.string() }))
  .query(async ({ ctx: { db, membership }, input }) => {
    const { companyId } = membership;
    const stakeholder = await db.stakeholder.findFirst({
      where: { id: input.stakeholderId, companyId },
      select: { id: true },
    });
    if (!stakeholder) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Member not found." });
    }

    const documents = await db.document.findMany({
      where: { companyId, stakeholderId: input.stakeholderId },
      select: {
        id: true,
        publicId: true,
        name: true,
        kind: true,
        createdAt: true,
        bucket: {
          select: { id: true, key: true, mimeType: true, size: true },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    return documents;
  });
