import { Audit } from "@/server/audit";
import { withLlcAccessControl } from "@/trpc/api/trpc";
import { createDocumentHandler } from "@/trpc/routers/document-router/procedures/create-document";
import { ZAttachDocumentInput } from "../member-schema";

export const attachDocumentProcedure = withLlcAccessControl
  .meta({
    policies: {
      stakeholder: { allow: ["update"] },
      documents: { allow: ["create"] },
    },
  })
  .input(ZAttachDocumentInput)
  .mutation(
    ({ ctx: { db, membership, session, userAgent, requestIp }, input }) => {
      const { companyId, memberId } = membership;
      const user = session.user;

      return db.$transaction(async (tx) => {
        // createDocumentHandler verifies bucket and stakeholder ownership.
        const document = await createDocumentHandler({
          db: tx,
          companyId,
          requestIp,
          userAgent,
          input: { name: input.name, bucketId: input.bucketId },
          uploaderName: user.name,
          uploaderId: memberId,
          stakeholderId: input.stakeholderId,
          kind: input.kind,
        });

        await Audit.create(
          {
            action: "document.attached",
            companyId,
            actor: { type: "user", id: user.id },
            context: { userAgent, requestIp },
            target: [
              { type: "document", id: document.id },
              { type: "stakeholder", id: input.stakeholderId },
            ],
            summary: `${user.name} attached document ${document.name} (${input.kind}) to a member`,
          },
          tx,
        );

        return {
          id: document.id,
          publicId: document.publicId,
          name: document.name,
          kind: document.kind,
        };
      });
    },
  );
