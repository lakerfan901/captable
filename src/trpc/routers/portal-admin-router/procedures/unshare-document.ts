// portalAdmin.unshareDocument (04-investor-portal.md 5.6, P16, P28, P29;
// package P6).
//
// Removes holders from one document's share list. Under the document's row
// lock (the same lock `shareDocuments` takes), the matching grant rows are
// deleted by one `DELETE … RETURNING`, so the audit row names exactly the
// holders whose rows this call removed, also when another request removed
// some of them at the same time. Ids that are not on the list are ignored;
// a document that is not this company's is NOT_FOUND. Rows of deleted
// holders can be removed too (they are already invisible: every read
// re-loads the holder). The next `portal.documents.*` request of a removed
// holder no longer sees the document; a URL issued before stays valid for
// at most 60 seconds (P16).

import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { Audit } from "@/server/audit";
import type { PrismaTransactionalClient } from "@/server/db";
import { withLlcAccessControl } from "@/trpc/api/trpc";
import { namesSentence, type ShareActor } from "./share-documents";

export const ZUnshareDocumentInput = z.object({
  documentPublicId: z.string().min(1).max(64),
  stakeholderIds: z.array(z.string().min(1).max(64)).min(1).max(500),
});

export async function unshareDocumentInTx(
  tx: PrismaTransactionalClient,
  actor: ShareActor,
  input: { documentPublicId: string; stakeholderIds: readonly string[] },
): Promise<{ removed: number; removedStakeholderIds: string[] }> {
  const { companyId } = actor;
  const locked = await tx.$queryRaw<{ id: string; name: string }[]>`
    SELECT id, name FROM "Document"
    WHERE "companyId" = ${companyId} AND "publicId" = ${input.documentPublicId}
    FOR UPDATE`;
  const doc = locked[0];
  if (doc === undefined) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Document not found." });
  }
  const stakeholderIds = [...new Set(input.stakeholderIds)];
  const deleted = await tx.$queryRaw<{ stakeholderId: string }[]>`
    DELETE FROM "PortalDocumentGrant"
    WHERE "companyId" = ${companyId}
      AND "documentId" = ${doc.id}
      AND "stakeholderId" = ANY(${stakeholderIds}::text[])
    RETURNING "stakeholderId"`;
  const removedStakeholderIds = deleted.map((r) => r.stakeholderId).sort();
  if (removedStakeholderIds.length > 0) {
    const holders = await tx.stakeholder.findMany({
      where: { companyId, id: { in: removedStakeholderIds } },
      select: { id: true, name: true },
    });
    const nameOf = new Map(holders.map((h) => [h.id, h.name]));
    const names = removedStakeholderIds.map(
      (id) => nameOf.get(id) ?? "a deleted holder",
    );
    const n = removedStakeholderIds.length;
    await Audit.create(
      {
        action: "portal.document-unshared",
        companyId,
        actor: { type: "user", id: actor.userId },
        context: { requestIp: actor.requestIp, userAgent: actor.userAgent },
        target: [
          { type: "document", id: doc.id },
          ...removedStakeholderIds.map((id) => ({
            type: "stakeholder" as const,
            id,
          })),
        ],
        summary: `${actor.userName} stopped sharing "${doc.name}" in the investor portal with ${
          n === 1 ? "1 holder" : `${n} holders`
        }: ${namesSentence(names)}`,
      },
      tx,
    );
  }
  return { removed: removedStakeholderIds.length, removedStakeholderIds };
}

export const unshareDocumentProcedure = withLlcAccessControl
  .meta({ policies: { portal: { allow: ["delete"] } } })
  .input(ZUnshareDocumentInput)
  .mutation(async ({ ctx, input }) => {
    const actor: ShareActor = {
      companyId: ctx.membership.companyId,
      memberId: ctx.membership.memberId,
      userId: ctx.session.user.id,
      userName: ctx.session.user.name ?? "A user",
      requestIp: ctx.requestIp,
      userAgent: ctx.userAgent,
    };
    return await ctx.db.$transaction(
      (tx) => unshareDocumentInTx(tx, actor, input),
      { maxWait: 10_000, timeout: 30_000 },
    );
  });
