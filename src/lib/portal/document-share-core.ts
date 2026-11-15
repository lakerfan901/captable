// Document sharing on top of `visibility-core` (04-investor-portal.md P13,
// P14, P28, S6; package P6). Pure: no database, no `@/` imports.
//
// `visibility-core.documentShareability` decides P14 from one column,
// `Document.stakeholderId`. In this app a file is tied to a holder through
// more than that column, so `src/server/portal/visibility-documents.ts`
// collects every tie it can find (the facts below) and `documentBinding`
// turns them into the one holder the file belongs to, if any:
//
// - DOCUMENT: `Document.stakeholderId` (a W-9, a countersigned Exhibit B, a
//   wire confirmation or any file attached on the member page).
// - SAME_FILE: another Document of the company that points at the same
//   Bucket and is tied to a holder. `document.create` accepts any bucket of
//   the company, so a second, untied Document can point at a W-9's object;
//   the object, not the row, is what is shared.
// - SECURITY: the holder of the Share, Option, Safe or ConvertibleNote the
//   Document is filed on.
// - ESIGN_PACKET: `Template.stakeholderId` of the subscription packet whose
//   file this is (the unsigned packet on the same Bucket, or the envelope
//   whose `signedDocumentId` is this Document).
// - PRIVATE_REPORT_FILE: a member-report attachment on the same Bucket that
//   is private to one holder (a K-1).
//
// A file tied to two different holders, or tied to a holder that no longer
// exists (a member-page kind, or a subscription envelope, whose holder
// column was cleared by the holder's deletion, `onDelete: SetNull`), can be
// shared with nobody.

export type BindingSource =
  | "DOCUMENT"
  | "SAME_FILE"
  | "SECURITY"
  | "ESIGN_PACKET"
  | "PRIVATE_REPORT_FILE";

export interface BindingFacts {
  ties: readonly { source: BindingSource; stakeholderId: string }[];
  /**
   * The Document (or another Document on the same Bucket) has a member-page
   * kind (`exhibit-b`, `w9`, `wire-confirmation`, `other`) but no holder:
   * the holder it was filed on was deleted.
   */
  holderRemoved: boolean;
}

export type DocumentBinding =
  | { kind: "ANY" }
  | {
      kind: "HOLDER_ONLY";
      stakeholderId: string;
      sources: BindingSource[];
    }
  | { kind: "NONE"; reason: "MULTIPLE_HOLDERS" | "HOLDER_REMOVED" };

/** P14 generalised: the one holder a file may be shared with, any holder, or nobody. */
export function documentBinding(facts: BindingFacts): DocumentBinding {
  const holders = new Map<string, BindingSource[]>();
  for (const tie of facts.ties) {
    const list = holders.get(tie.stakeholderId) ?? [];
    if (!list.includes(tie.source)) list.push(tie.source);
    holders.set(tie.stakeholderId, list);
  }
  if (holders.size > 1) return { kind: "NONE", reason: "MULTIPLE_HOLDERS" };
  if (facts.holderRemoved) return { kind: "NONE", reason: "HOLDER_REMOVED" };
  const [only] = [...holders.entries()];
  if (only === undefined) return { kind: "ANY" };
  return { kind: "HOLDER_ONLY", stakeholderId: only[0], sources: only[1] };
}

/**
 * The value `visibility-core` reads as `Document.stakeholderId` for a file
 * that may be shared with nobody. Holder ids are cuids from the database and
 * client ids are checked against the company's holders first, so no holder
 * can ever equal it.
 */
export const NO_HOLDER = "\u0000no-holder";

/** The `{ stakeholderId }` that `shareRefusals` and `isDocumentVisible` take. */
export function bindingStakeholderId(binding: DocumentBinding): string | null {
  if (binding.kind === "ANY") return null;
  if (binding.kind === "NONE") return NO_HOLDER;
  return binding.stakeholderId;
}

/** Document kinds set only by the member page, the W-9 upload and e-sign (F13). */
export const MEMBER_DOCUMENT_KINDS: readonly string[] = [
  "exhibit-b",
  "w9",
  "wire-confirmation",
  "other",
];

/** A member-page kind without a holder: the holder was deleted. */
export function isHolderRemoved(doc: {
  kind: string | null;
  stakeholderId: string | null;
}): boolean {
  return (
    doc.stakeholderId === null &&
    doc.kind !== null &&
    MEMBER_DOCUMENT_KINDS.includes(doc.kind)
  );
}

// ---------------------------------------------------------------------------
// Where a file comes from, and the S6 warning

export type DocumentSource =
  | "W9"
  | "EXHIBIT_B"
  | "MEMBER_FILE"
  | "ESIGN"
  | "RESOLUTION"
  | "MEMBER_REPORT"
  | "FINANCIAL_STATEMENTS"
  | "DATA_ROOM"
  | "SECURITY_FILE"
  | "UPLOAD";

export interface SourceFacts {
  name: string;
  kind: string | null;
  recordCategory: string | null;
  /** `Bucket.tags`. */
  tags: readonly string[];
  /** `Bucket.key`; only its prefix segment is read. */
  key: string;
  /** Filed on a Share, Option, Safe or ConvertibleNote. */
  security: boolean;
  /** The completed file of an e-sign envelope (`Template.signedDocumentId`). */
  esignOutput: boolean;
}

/** `{identifier}/{keyPrefix}-…`: the part after the first slash. */
function keyTail(key: string): string {
  const slash = key.indexOf("/");
  return slash === -1 ? key : key.slice(slash + 1);
}

export function documentSource(f: SourceFacts): DocumentSource {
  const tail = keyTail(f.key);
  if (f.kind === "w9") return "W9";
  if (f.kind === "exhibit-b") return "EXHIBIT_B";
  if (f.kind !== null) return "MEMBER_FILE";
  if (f.tags.includes("resolution") || tail.startsWith("resolutions-")) {
    return "RESOLUTION";
  }
  if (f.tags.includes("member-report") || tail.startsWith("member-reports-")) {
    return "MEMBER_REPORT";
  }
  if (f.esignOutput || f.tags.includes("esign")) return "ESIGN";
  if (f.security) return "SECURITY_FILE";
  if (f.recordCategory === "FINANCIAL_STATEMENTS")
    return "FINANCIAL_STATEMENTS";
  if (f.tags.includes("data-room") || tail.startsWith("data-room/")) {
    return "DATA_ROOM";
  }
  return "UPLOAD";
}

export type ShareWarningCode =
  | "MEMBER_LIST"
  | "RESOLUTION"
  | "CONSENTS"
  | "MEMBER_REPORT"
  | "SIGNED_DOCUMENT";

export interface ShareWarning {
  code: ShareWarningCode;
  message: string;
}

const EXHIBIT_A_NAME = /exhibit[\s_.-]*a(?![a-z0-9])/i;

/**
 * S6: files that name other Members. The system cannot tell whether such a
 * file is safe to share; the share dialog shows these lines and the Manager
 * user decides.
 */
export function shareWarnings(
  f: SourceFacts & { source?: DocumentSource },
): ShareWarning[] {
  const source = f.source ?? documentSource(f);
  const out: ShareWarning[] = [];
  if (f.recordCategory === "MEMBER_LIST" || EXHIBIT_A_NAME.test(f.name)) {
    out.push({
      code: "MEMBER_LIST",
      message:
        "This looks like a member list (Exhibit A): it names every Member with their units and amounts.",
    });
  }
  if (source === "RESOLUTION") {
    out.push({
      code: "RESOLUTION",
      message:
        "This is an executed resolution: it names the Members who consented.",
    });
  } else if (f.recordCategory === "CONSENTS_AND_MINUTES") {
    out.push({
      code: "CONSENTS",
      message: "Consents and minutes usually name the Members who took part.",
    });
  }
  if (source === "MEMBER_REPORT") {
    out.push({
      code: "MEMBER_REPORT",
      message:
        "This is a filed member report: it names payees and insiders of the period. Members who were sent the report already have it.",
    });
  }
  if (source === "ESIGN") {
    out.push({
      code: "SIGNED_DOCUMENT",
      message:
        "This is a signed document: it shows the name and signature of every signer.",
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// The share dialog

export interface ShareListHolder {
  stakeholderId: string;
  isCurrentMember: boolean;
}

/**
 * P28: the current Members a shareable document is not shared with, and the
 * sentence the dialog shows ("1 current Member is not on this list"). For a
 * file tied to one holder, or to nobody, the list is empty: the others could
 * not be added.
 */
export function missingCurrentMembers(
  binding: DocumentBinding,
  holders: readonly ShareListHolder[],
  sharedWith: ReadonlySet<string>,
): { stakeholderIds: string[]; message: string | null } {
  if (binding.kind !== "ANY") return { stakeholderIds: [], message: null };
  const ids = holders
    .filter((h) => h.isCurrentMember && !sharedWith.has(h.stakeholderId))
    .map((h) => h.stakeholderId);
  if (ids.length === 0) return { stakeholderIds: [], message: null };
  return {
    stakeholderIds: ids,
    message:
      ids.length === 1
        ? "1 current Member is not on this list"
        : `${ids.length} current Members are not on this list`,
  };
}

/** The sentence a refused share names (BAD_REQUEST); never names a foreign row. */
export function bindingRefusalMessage(
  documentName: string,
  binding: DocumentBinding,
  boundHolderName: string | null,
): string {
  if (binding.kind === "NONE") {
    return binding.reason === "MULTIPLE_HOLDERS"
      ? `"${documentName}" is tied to more than one holder and cannot be shared in the portal.`
      : `"${documentName}" was filed on a holder that no longer exists and cannot be shared in the portal.`;
  }
  return `"${documentName}" belongs to ${
    boundHolderName ?? "one holder"
  } and can be shared only with that holder (a W-9, signed Exhibit B or other file tied to a holder is never shown to anyone else).`;
}

// ---------------------------------------------------------------------------
// Access log paging

/** `portalAdmin.accessLog`: rows per page. */
export const ACCESS_LOG_PAGE = 50;

/** The events that belong to no company (`PortalAccessLog.companyId` null). */
export const ACCOUNT_EVENTS: readonly string[] = [
  "SIGNED_IN",
  "SIGNED_OUT",
  "ACCOUNT_LOCKED",
  "PASSWORD_SET",
];

/**
 * Opaque cursor of the access log: newest first by `(createdAt, id)`. Encoded
 * as `{epochMs}.{id}`; anything else decodes to null.
 */
export function encodeLogCursor(row: { createdAt: Date; id: string }): string {
  return `${row.createdAt.getTime()}.${row.id}`;
}

export function decodeLogCursor(
  cursor: string,
): { createdAt: Date; id: string } | null {
  const match = /^(\d{1,15})\.([A-Za-z0-9_-]{1,64})$/.exec(cursor);
  if (match === null) return null;
  const ms = Number(match[1]);
  if (!Number.isSafeInteger(ms)) return null;
  return { createdAt: new Date(ms), id: match[2] as string };
}
