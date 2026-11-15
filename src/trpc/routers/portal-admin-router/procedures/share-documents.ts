// portalAdmin.shareDocuments (04-investor-portal.md 5.6, P13, P14, P28,
// P29, P30; package P6).
//
// The Manager user's confirmed list of holders is stored as one
// `PortalDocumentGrant` row per document and holder. Presets only fill the
// picker; nothing here follows the register later (P28, frozen lists).
//
// All-or-nothing, in one transaction:
// 1. Lock the requested Document rows (`FOR UPDATE`, in id order) and the
//    requested holders (`FOR SHARE`), then re-read both, company-scoped.
//    Any id that is not a document or holder of this company: NOT_FOUND,
//    nothing written, no foreign row named.
// 2. `shareRefusals` over the documents' live holder ties (P14 generalised,
//    `document-share-core.ts`): a file tied to one holder only with that
//    holder; a file tied to two holders or to a deleted one with nobody.
//    Any refusal: BAD_REQUEST naming the rule, nothing written.
// 3. Under the document locks, read the existing grants and insert only the
//    missing pairs (`skipDuplicates` is the backstop of the unique index
//    `[documentId, stakeholderId]`). Two concurrent shares of the same pair
//    therefore create one row, and only the transaction that created it
//    names the holder in its audit row.
// 4. One `portal.documents-shared` audit row per document that gained a
//    holder, naming the holders added (never a token or a storage key).
//
// Prospects may be selected (5.6 lists every holder; the only prospect rule
// of the plan, P18, is for reports); they are in no preset.
//
// `notify` (P10): `assertMailDeliverable` runs before anything is written;
// the queueing itself is P10's (marked below). Until P10 is merged a ticked
// box sends nothing and the result says `notificationsQueued: 0`.

import { TRPCError } from "@trpc/server";
import { z } from "zod";
import {
  bindingRefusalMessage,
  bindingStakeholderId,
} from "@/lib/portal/document-share-core";
import { shareRefusals } from "@/lib/portal/visibility-core";
import { Audit } from "@/server/audit";
import type { PrismaTransactionalClient } from "@/server/db";
import { assertMailDeliverable } from "@/server/mail-delivery";
import {
  loadCompanyDocuments,
  loadDocumentFacts,
} from "@/server/portal/visibility-documents";
import { withLlcAccessControl } from "@/trpc/api/trpc";

export const ZShareDocumentsInput = z.object({
  documentPublicIds: z.array(z.string().min(1).max(64)).min(1).max(50),
  stakeholderIds: z.array(z.string().min(1).max(64)).min(1).max(500),
  notify: z.boolean().default(false),
});

/** Holder names listed in one audit summary before "and N more". */
const SUMMARY_NAMES = 25;

export function namesSentence(names: readonly string[]): string {
  if (names.length <= SUMMARY_NAMES) return names.join(", ");
  return `${names.slice(0, SUMMARY_NAMES).join(", ")} and ${
    names.length - SUMMARY_NAMES
  } more`;
}

export interface ShareActor {
  companyId: string;
  memberId: string;
  userId: string;
  userName: string;
  requestIp: string;
  userAgent: string;
}

export interface ShareResult {
  /** Rows created by this call. */
  added: number;
  /** Pairs that were already on the list (nothing written for them). */
  alreadyShared: number;
  documents: { documentPublicId: string; addedStakeholderIds: string[] }[];
}

/** Steps 1–4 of the header, inside the caller's transaction. */
export async function shareDocumentsInTx(
  tx: PrismaTransactionalClient,
  actor: ShareActor,
  input: {
    documentPublicIds: readonly string[];
    stakeholderIds: readonly string[];
  },
): Promise<ShareResult> {
  const { companyId } = actor;
  const publicIds = [...new Set(input.documentPublicIds)];
  const stakeholderIds = [...new Set(input.stakeholderIds)];

  // 1. Lock, then re-read.
  await tx.$queryRaw`
    SELECT id FROM "Document"
    WHERE "companyId" = ${companyId} AND "publicId" = ANY(${publicIds}::text[])
    ORDER BY id
    FOR UPDATE`;
  await tx.$queryRaw`
    SELECT id FROM "Stakeholder"
    WHERE "companyId" = ${companyId} AND id = ANY(${stakeholderIds}::text[])
    ORDER BY id
    FOR SHARE`;
  const documents = await loadCompanyDocuments(tx, companyId, { publicIds });
  if (documents.length !== publicIds.length) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "One or more documents were not found.",
    });
  }
  const holders = await tx.stakeholder.findMany({
    where: { companyId, id: { in: stakeholderIds } },
    select: { id: true, name: true },
  });
  if (holders.length !== stakeholderIds.length) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "One or more holders were not found.",
    });
  }
  const nameOf = new Map(holders.map((h) => [h.id, h.name]));

  // 2. P14 against live data.
  const facts = await loadDocumentFacts(tx, companyId, documents);
  const byPublicId = new Map(documents.map((d) => [d.publicId, d]));
  const effective = documents.map((d) => {
    const f = facts.get(d.id);
    if (f === undefined) throw new TRPCError({ code: "NOT_FOUND" });
    return { id: d.publicId, stakeholderId: bindingStakeholderId(f.binding) };
  });
  const refusals = shareRefusals(
    publicIds,
    stakeholderIds,
    effective,
    holders.map((h) => h.id),
  );
  const first = refusals[0];
  if (first !== undefined) {
    const doc = byPublicId.get(first.documentId);
    const f = doc ? facts.get(doc.id) : undefined;
    if (first.code !== "HOLDER_ONLY" || doc === undefined || f === undefined) {
      throw new TRPCError({ code: "NOT_FOUND" });
    }
    const boundName =
      f.binding.kind === "HOLDER_ONLY"
        ? (
            (await tx.stakeholder.findFirst({
              where: { id: f.binding.stakeholderId, companyId },
              select: { name: true },
            })) ?? { name: null }
          ).name
        : null;
    const others = refusals.length - 1;
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `${bindingRefusalMessage(doc.name, f.binding, boundName)}${
        others > 0
          ? ` ${others} other ${others === 1 ? "pair was" : "pairs were"} refused for the same reason.`
          : ""
      } Nothing was shared.`,
    });
  }

  // 3. Insert only the missing pairs.
  const existing = await tx.portalDocumentGrant.findMany({
    where: {
      companyId,
      documentId: { in: documents.map((d) => d.id) },
      stakeholderId: { in: stakeholderIds },
    },
    select: { documentId: true, stakeholderId: true },
  });
  const have = new Set(
    existing.map((g) => `${g.documentId}\u0000${g.stakeholderId}`),
  );
  const toCreate = documents.flatMap((d) =>
    stakeholderIds
      .filter((s) => !have.has(`${d.id}\u0000${s}`))
      .map((s) => ({
        companyId,
        documentId: d.id,
        stakeholderId: s,
        grantedById: actor.memberId,
      })),
  );
  const created =
    toCreate.length === 0
      ? []
      : await tx.portalDocumentGrant.createManyAndReturn({
          data: toCreate,
          skipDuplicates: true,
          select: { id: true, documentId: true, stakeholderId: true },
        });

  // 4. Audit, per document that gained holders.
  const result: ShareResult = {
    added: created.length,
    alreadyShared: publicIds.length * stakeholderIds.length - created.length,
    documents: [],
  };
  for (const doc of documents) {
    const rows = created.filter((g) => g.documentId === doc.id);
    result.documents.push({
      documentPublicId: doc.publicId,
      addedStakeholderIds: rows.map((g) => g.stakeholderId),
    });
    if (rows.length === 0) continue;
    const names = rows.map((g) => nameOf.get(g.stakeholderId) ?? "a holder");
    await Audit.create(
      {
        action: "portal.documents-shared",
        companyId,
        actor: { type: "user", id: actor.userId },
        context: { requestIp: actor.requestIp, userAgent: actor.userAgent },
        target: [
          { type: "document", id: doc.id },
          ...rows.map((g) => ({
            type: "stakeholder" as const,
            id: g.stakeholderId,
          })),
        ],
        summary: `${actor.userName} shared "${doc.name}" in the investor portal with ${
          rows.length === 1 ? "1 holder" : `${rows.length} holders`
        }: ${namesSentence(names)}`,
      },
      tx,
    );
  }
  return result;
}

export const shareDocumentsProcedure = withLlcAccessControl
  .meta({ policies: { portal: { allow: ["create"] } } })
  .input(ZShareDocumentsInput)
  .mutation(async ({ ctx, input }) => {
    // P30: refused in production while mail goes to the catcher, before any write.
    if (input.notify) assertMailDeliverable("MEMBER_EMAIL");
    const actor: ShareActor = {
      companyId: ctx.membership.companyId,
      memberId: ctx.membership.memberId,
      userId: ctx.session.user.id,
      userName: ctx.session.user.name ?? "A user",
      requestIp: ctx.requestIp,
      userAgent: ctx.userAgent,
    };
    const result = await ctx.db.$transaction(
      async (tx) => {
        const shared = await shareDocumentsInTx(tx, actor, input);
        // P10: queuePortalNotifications(tx, { companyId, kind:
        // "portal.documents-shared", batchKey, subjectLine, stakeholderIds })
        // goes here, for the holders that gained a document.
        return shared;
      },
      { maxWait: 10_000, timeout: 30_000 },
    );
    // P10: emitPortalNotifications(ids) after commit goes here.
    return { ...result, notificationsQueued: 0 };
  });
