// Document sharing rules and portal email normalisation
// (04-investor-portal.md P1, P13, P14, S3, S6; package P1). Pure: no
// database, no `@/` imports.
//
// `src/server/portal/visibility-documents.ts` (P6) loads the grant and
// document rows; the decisions are here.

import { hasUnsafeChar } from "./chars";

export type DocumentShareability =
  | { kind: "ANY" }
  | { kind: "HOLDER_ONLY"; stakeholderId: string };

/**
 * P14: a document tied to one holder (`Document.stakeholderId` set: an
 * Exhibit B, a W-9, a wire confirmation) can be shared only with that holder.
 * Only an explicit `null` means "not tied to anyone"; every string, the empty
 * string included, ties it. A missing field (the caller forgot to select
 * `stakeholderId`) throws rather than opening the document to everyone.
 */
export function documentShareability(doc: {
  stakeholderId: string | null;
}): DocumentShareability {
  const id: unknown = doc.stakeholderId;
  if (id === null) return { kind: "ANY" };
  if (typeof id !== "string") {
    throw new TypeError("documentShareability needs Document.stakeholderId");
  }
  return { kind: "HOLDER_ONLY", stakeholderId: id };
}

/** P14 for one document and one holder. */
export function canShareWith(
  doc: { stakeholderId: string | null },
  stakeholderId: string,
): boolean {
  const s = documentShareability(doc);
  return s.kind === "ANY" || s.stakeholderId === stakeholderId;
}

export interface ShareRefusal {
  documentId: string;
  stakeholderId: string;
  code: "UNKNOWN_DOCUMENT" | "UNKNOWN_HOLDER" | "HOLDER_ONLY";
}

/**
 * `portalAdmin.shareDocuments` is all-or-nothing (5.6): every requested
 * document must be one of `documents` (loaded by `{ publicId, companyId }`),
 * every holder one of `holderIds` (the company's holders), and every pair
 * must pass P14. Returns every refusal; an empty list means the share may be
 * written. Duplicated ids are checked once. Ids are compared as strings in
 * Maps and Sets, never as object keys.
 */
export function shareRefusals(
  requestedDocumentIds: readonly string[],
  requestedStakeholderIds: readonly string[],
  documents: readonly { id: string; stakeholderId: string | null }[],
  holderIds: readonly string[],
): ShareRefusal[] {
  const docs = new Map(documents.map((d) => [d.id, d]));
  const holders = new Set(holderIds);
  const stakeholderIds = [...new Set(requestedStakeholderIds)];
  const refusals: ShareRefusal[] = [];
  for (const documentId of new Set(requestedDocumentIds)) {
    const doc = docs.get(documentId);
    if (!doc) {
      refusals.push({
        documentId,
        stakeholderId: "",
        code: "UNKNOWN_DOCUMENT",
      });
      continue;
    }
    for (const stakeholderId of stakeholderIds) {
      if (!holders.has(stakeholderId)) {
        refusals.push({ documentId, stakeholderId, code: "UNKNOWN_HOLDER" });
      } else if (!canShareWith(doc, stakeholderId)) {
        refusals.push({ documentId, stakeholderId, code: "HOLDER_ONLY" });
      }
    }
  }
  return refusals;
}

/**
 * The read side (P13, P14 second line of defence): a holder may open a
 * document only when a grant row names that document and that holder AND the
 * document is not tied to another holder. A hand-inserted grant for the
 * wrong holder is ignored.
 */
export function isDocumentVisible(
  doc: { id: string; stakeholderId: string | null },
  grantedDocumentIds: ReadonlySet<string>,
  holderStakeholderId: string,
): boolean {
  if (!grantedDocumentIds.has(doc.id)) return false;
  return canShareWith(doc, holderStakeholderId);
}

export const PORTAL_EMAIL_MAX_LENGTH = 254;

// Characters never valid in an unquoted address (and never wanted in an
// identity key): whitespace, controls, and the RFC 5322 specials other than
// `@` and `.`.
const EMAIL_FORBIDDEN_RE = /[\s<>()[\]\\,;:"]/;

/**
 * P1: a portal user is identified by one lower-cased, trimmed address. The
 * address is trimmed, Unicode-normalised to NFC and lower-cased; it is then
 * returned only when it has the shape `local@domain` with exactly one `@`, a
 * local part of 1–64 characters, a domain with a dot and no empty label, and
 * at most 254 characters in total. Anything else is null. Shape only: whether
 * the address receives mail is proved by the emailed link.
 */
export function normalizePortalEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const email = raw.trim().normalize("NFC").toLowerCase();
  if (email.length === 0 || email.length > PORTAL_EMAIL_MAX_LENGTH) return null;
  if (EMAIL_FORBIDDEN_RE.test(email) || hasUnsafeChar(email)) return null;
  const parts = email.split("@");
  if (parts.length !== 2) return null;
  const [local = "", domain = ""] = parts;
  if (local.length === 0 || local.length > 64) return null;
  if (local.startsWith(".") || local.endsWith(".") || local.includes("..")) {
    return null;
  }
  const labels = domain.split(".");
  if (
    labels.length < 2 ||
    labels.some((l) => l.length === 0 || l.length > 63)
  ) {
    return null;
  }
  if (labels.some((l) => l.startsWith("-") || l.endsWith("-"))) return null;
  return email;
}
