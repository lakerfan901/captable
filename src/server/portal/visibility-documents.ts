import "server-only";

import {
  type BindingFacts,
  bindingStakeholderId,
  type DocumentBinding,
  type DocumentSource,
  documentBinding,
  documentSource,
  isHolderRemoved,
  type ShareWarning,
  shareWarnings,
} from "@/lib/portal/document-share-core";
import { isDocumentVisible } from "@/lib/portal/visibility-core";
import { isKeyInCompanyNamespace } from "@/lib/upload-authorization";
import type { TPrismaOrTransaction } from "@/server/db";

// The only place the document rules of the investor portal are applied to
// rows (04-investor-portal.md 5.4, P13, P14, S3, S6; package P6). Used by
// `portal.documents.*` (the investor), `portalAdmin.share*` (the team) and
// `portalAdmin.holderView` (P9).
//
// The holder is `{ companyId, stakeholderId }` from `ctx.holder` (portal) or
// from a company-scoped lookup (team); it never comes from client input
// here. This module does not import `portal-procedure.ts` (G5).
//
// Visible to a holder (P13, P14) = a `PortalDocumentGrant` row with that
// company and holder, AND the Document exists in that company, AND the file
// is not tied to another holder or to nobody (`documentBinding`, second line
// of defence: a hand-inserted grant for the wrong holder is ignored), AND
// its Bucket row exists and its key is in the company's namespace. Every
// rule is re-evaluated on every call, so a revoked share, a disabled access
// or a deleted holder or document takes effect on the next request (P16).

export interface DocumentHolder {
  companyId: string;
  stakeholderId: string;
}

const DOCUMENT_SELECT = {
  id: true,
  publicId: true,
  name: true,
  kind: true,
  recordCategory: true,
  recordYear: true,
  stakeholderId: true,
  bucketId: true,
  shareId: true,
  optionId: true,
  safeId: true,
  convertibleNoteId: true,
  createdAt: true,
} as const;

export interface DocumentRow {
  id: string;
  publicId: string;
  name: string;
  kind: string | null;
  recordCategory: string | null;
  recordYear: number | null;
  stakeholderId: string | null;
  bucketId: string;
  shareId: string | null;
  optionId: string | null;
  safeId: string | null;
  convertibleNoteId: string | null;
  createdAt: Date;
}

export interface DocumentFile {
  key: string;
  name: string;
  mimeType: string;
  size: number;
  tags: string[];
}

export interface DocumentFacts {
  binding: DocumentBinding;
  source: DocumentSource;
  warnings: ShareWarning[];
  /** null when the Bucket row is missing. */
  file: DocumentFile | null;
}

/** Documents of the company by public id (unknown or foreign ids are simply absent). */
export function loadCompanyDocuments(
  tx: TPrismaOrTransaction,
  companyId: string,
  where: { publicIds: readonly string[] } | { ids: readonly string[] },
): Promise<DocumentRow[]> {
  return tx.document.findMany({
    where: {
      companyId,
      ...("publicIds" in where
        ? { publicId: { in: [...where.publicIds] } }
        : { id: { in: [...where.ids] } }),
    },
    select: DOCUMENT_SELECT,
  });
}

/**
 * Every tie between each document's file and a holder (see
 * `document-share-core.ts`), its source and S6 warnings, and its Bucket row.
 * Seven company-scoped queries for any number of documents.
 */
export async function loadDocumentFacts(
  tx: TPrismaOrTransaction,
  companyId: string,
  documents: readonly DocumentRow[],
): Promise<Map<string, DocumentFacts>> {
  const out = new Map<string, DocumentFacts>();
  if (documents.length === 0) return out;
  const docIds = documents.map((d) => d.id);
  const bucketIds = [...new Set(documents.map((d) => d.bucketId))];
  const idsOf = (pick: (d: DocumentRow) => string | null) =>
    [
      ...new Set(documents.flatMap((d) => (pick(d) === null ? [] : [pick(d)]))),
    ] as string[];

  const [
    buckets,
    sameFile,
    shares,
    options,
    safes,
    notes,
    templates,
    attachments,
  ] = await Promise.all([
    tx.bucket.findMany({
      where: { id: { in: bucketIds } },
      select: {
        id: true,
        key: true,
        name: true,
        mimeType: true,
        size: true,
        tags: true,
      },
    }),
    tx.document.findMany({
      where: { companyId, bucketId: { in: bucketIds } },
      select: { id: true, bucketId: true, stakeholderId: true, kind: true },
    }),
    tx.share.findMany({
      where: { companyId, id: { in: idsOf((d) => d.shareId) } },
      select: { id: true, stakeholderId: true },
    }),
    tx.option.findMany({
      where: { companyId, id: { in: idsOf((d) => d.optionId) } },
      select: { id: true, stakeholderId: true },
    }),
    tx.safe.findMany({
      where: { companyId, id: { in: idsOf((d) => d.safeId) } },
      select: { id: true, stakeholderId: true },
    }),
    tx.convertibleNote.findMany({
      where: { companyId, id: { in: idsOf((d) => d.convertibleNoteId) } },
      select: { id: true, stakeholderId: true },
    }),
    tx.template.findMany({
      where: {
        companyId,
        OR: [
          { bucketId: { in: bucketIds } },
          { signedDocumentId: { in: docIds } },
        ],
      },
      select: { bucketId: true, signedDocumentId: true, stakeholderId: true },
    }),
    tx.memberReportAttachment.findMany({
      where: {
        companyId,
        bucketId: { in: bucketIds },
        stakeholderId: { not: null },
      },
      select: { bucketId: true, stakeholderId: true },
    }),
  ]);

  const bucketById = new Map(buckets.map((b) => [b.id, b]));
  const securityHolder = new Map<string, string>();
  for (const row of [...shares, ...options, ...safes, ...notes]) {
    securityHolder.set(row.id, row.stakeholderId);
  }

  for (const doc of documents) {
    const ties: BindingFacts["ties"][number][] = [];
    let holderRemoved = isHolderRemoved(doc);
    if (doc.stakeholderId !== null) {
      ties.push({ source: "DOCUMENT", stakeholderId: doc.stakeholderId });
    }
    for (const other of sameFile) {
      if (other.bucketId !== doc.bucketId || other.id === doc.id) continue;
      if (other.stakeholderId !== null) {
        ties.push({ source: "SAME_FILE", stakeholderId: other.stakeholderId });
      } else if (isHolderRemoved(other)) {
        holderRemoved = true;
      }
    }
    let security = false;
    for (const securityId of [
      doc.shareId,
      doc.optionId,
      doc.safeId,
      doc.convertibleNoteId,
    ]) {
      if (securityId === null) continue;
      security = true;
      const holder = securityHolder.get(securityId);
      if (holder !== undefined) {
        ties.push({ source: "SECURITY", stakeholderId: holder });
      }
    }
    let esignOutput = false;
    for (const t of templates) {
      const mine = t.signedDocumentId === doc.id || t.bucketId === doc.bucketId;
      if (!mine) continue;
      if (t.signedDocumentId === doc.id) esignOutput = true;
      if (t.stakeholderId !== null) {
        ties.push({ source: "ESIGN_PACKET", stakeholderId: t.stakeholderId });
      }
    }
    for (const a of attachments) {
      if (a.bucketId === doc.bucketId && a.stakeholderId !== null) {
        ties.push({
          source: "PRIVATE_REPORT_FILE",
          stakeholderId: a.stakeholderId,
        });
      }
    }
    const bucket = bucketById.get(doc.bucketId) ?? null;
    const sourceFacts = {
      name: doc.name,
      kind: doc.kind,
      recordCategory: doc.recordCategory,
      tags: bucket?.tags ?? [],
      key: bucket?.key ?? "",
      security,
      esignOutput,
    };
    const source = documentSource(sourceFacts);
    out.set(doc.id, {
      binding: documentBinding({ ties, holderRemoved }),
      source,
      warnings: shareWarnings({ ...sourceFacts, source }),
      file:
        bucket === null
          ? null
          : {
              key: bucket.key,
              name: bucket.name,
              mimeType: bucket.mimeType,
              size: bucket.size,
              tags: bucket.tags,
            },
    });
  }
  return out;
}

/** A document a holder may see, with what the procedures need (server only: `file.key` never leaves the server). */
export interface VisibleDocument {
  document: DocumentRow;
  file: DocumentFile;
  /** When the grant was created. */
  sharedAt: Date;
}

async function companyRef(tx: TPrismaOrTransaction, companyId: string) {
  return await tx.company.findUnique({
    where: { id: companyId },
    select: { id: true, publicId: true },
  });
}

async function visibleFrom(
  tx: TPrismaOrTransaction,
  holder: DocumentHolder,
  grants: readonly { documentId: string; createdAt: Date }[],
  documents: readonly DocumentRow[],
): Promise<VisibleDocument[]> {
  if (grants.length === 0 || documents.length === 0) return [];
  const company = await companyRef(tx, holder.companyId);
  if (company === null) return [];
  const granted = new Set(grants.map((g) => g.documentId));
  const sharedAt = new Map(grants.map((g) => [g.documentId, g.createdAt]));
  const facts = await loadDocumentFacts(tx, holder.companyId, documents);
  const out: VisibleDocument[] = [];
  for (const document of documents) {
    const f = facts.get(document.id);
    if (f === undefined || f.file === null) continue;
    const effective = {
      id: document.id,
      stakeholderId: bindingStakeholderId(f.binding),
    };
    if (!isDocumentVisible(effective, granted, holder.stakeholderId)) continue;
    if (!isKeyInCompanyNamespace(f.file.key, company)) continue;
    out.push({
      document,
      file: f.file,
      sharedAt: sharedAt.get(document.id) ?? document.createdAt,
    });
  }
  return out;
}

/**
 * P13, P14: every document the holder may see, newest share first (then by
 * name). The holder row itself is checked by the caller (`resolveHolder`
 * re-loads it on every portal request).
 */
export async function listVisibleDocuments(
  tx: TPrismaOrTransaction,
  holder: DocumentHolder,
): Promise<VisibleDocument[]> {
  const grants = await tx.portalDocumentGrant.findMany({
    where: { companyId: holder.companyId, stakeholderId: holder.stakeholderId },
    select: { documentId: true, createdAt: true },
  });
  if (grants.length === 0) return [];
  const documents = await loadCompanyDocuments(tx, holder.companyId, {
    ids: grants.map((g) => g.documentId),
  });
  const visible = await visibleFrom(tx, holder, grants, documents);
  return visible.sort(
    (a, b) =>
      b.sharedAt.getTime() - a.sharedAt.getTime() ||
      a.document.name.localeCompare(b.document.name, "en") ||
      (a.document.id < b.document.id ? -1 : 1),
  );
}

/**
 * P13, P14 for one document, by its public id: the same rules as
 * `listVisibleDocuments`, re-evaluated now. null for unknown, other-company,
 * ungranted, bound-to-another-holder and missing-file documents alike.
 */
export async function canOpenDocument(
  tx: TPrismaOrTransaction,
  holder: DocumentHolder,
  documentPublicId: string,
): Promise<VisibleDocument | null> {
  const documents = await loadCompanyDocuments(tx, holder.companyId, {
    publicIds: [documentPublicId],
  });
  const document = documents[0];
  if (document === undefined) return null;
  const grant = await tx.portalDocumentGrant.findFirst({
    where: {
      companyId: holder.companyId,
      stakeholderId: holder.stakeholderId,
      documentId: document.id,
    },
    select: { documentId: true, createdAt: true },
  });
  if (grant === null) return null;
  const [visible] = await visibleFrom(tx, holder, [grant], [document]);
  return visible ?? null;
}
