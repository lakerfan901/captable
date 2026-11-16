// The view logic of "Share with investors" and the "Investor portal" page
// (04-investor-portal.md 6.2, P13, P14, P28, P29; package P9a). Pure:
// relative imports only, unit-tested.
//
// The dialog edits an explicit list of holders per document. Presets only
// tick boxes; the saved list is exactly what is ticked (P28). Saving is
// two calls: `shareDocuments` for the holders added and `unshareDocument`
// for the holders removed, so `saveDiff` decides both.

export type ShareabilityView =
  | { kind: "ANY" }
  | { kind: "HOLDER_ONLY"; stakeholderId: string; holderName: string | null }
  | { kind: "NONE"; reason: "MULTIPLE_HOLDERS" | "HOLDER_REMOVED" };

export interface ShareDocView {
  documentPublicId: string;
  name: string;
  shareability: ShareabilityView;
  sharedWith: readonly {
    stakeholderId: string;
    name: string | null;
    sharedAt: Date | string;
  }[];
  warnings: readonly { code: string; message: string }[];
}

export interface ShareHolderView {
  stakeholderId: string;
  isCurrentMember: boolean;
}

/** The two server limits: documents per call (shareOptions, shareDocuments). */
export const SHARE_DOCUMENTS_MAX = 50;

/** One document open in the dialog, or several (the bulk action). */
export function isSingle(docs: readonly ShareDocView[]): boolean {
  return docs.length === 1;
}

/**
 * Bulk sharing adds the same holders to every document in one call, which
 * the server refuses as a whole when one document is tied to a holder
 * (P14). Such documents are left out of a bulk share and named; each is
 * shared from its own row, where only its holder can be ticked.
 */
export function bulkPlan(docs: readonly ShareDocView[]): {
  shareable: ShareDocView[];
  leftOut: ShareDocView[];
} {
  if (isSingle(docs)) {
    const only = docs[0];
    return only && only.shareability.kind !== "NONE"
      ? { shareable: [only], leftOut: [] }
      : { shareable: [], leftOut: [...docs] };
  }
  return {
    shareable: docs.filter((d) => d.shareability.kind === "ANY"),
    leftOut: docs.filter((d) => d.shareability.kind !== "ANY"),
  };
}

/**
 * The holders that can be ticked. One document tied to a holder: only that
 * holder. One document that can be shared with nobody: none. Otherwise
 * every holder. Without `portal: delete` the holders already on the list
 * cannot be unticked, so they are not offered (they are listed above the
 * picker, without "Remove").
 */
export function candidateHolders<T extends ShareHolderView>(
  holders: readonly T[],
  docs: readonly ShareDocView[],
  canRemove: boolean,
): T[] {
  const only = isSingle(docs) ? docs[0] : undefined;
  let list: T[] = [...holders];
  if (only?.shareability.kind === "NONE") return [];
  if (only?.shareability.kind === "HOLDER_ONLY") {
    const id = only.shareability.stakeholderId;
    list = list.filter((h) => h.stakeholderId === id);
  }
  if (only && !canRemove) {
    const shared = new Set(only.sharedWith.map((s) => s.stakeholderId));
    list = list.filter((h) => !shared.has(h.stakeholderId));
  }
  return list;
}

/** The ticks the dialog opens with: the saved list of one document, nothing for several. */
export function initialTicks(
  docs: readonly ShareDocView[],
  canRemove: boolean,
): Set<string> {
  const only = isSingle(docs) ? docs[0] : undefined;
  if (!only || !canRemove) return new Set();
  return new Set(only.sharedWith.map((s) => s.stakeholderId));
}

/** Presets are offered only where any holder can be ticked. */
export function showPresets(docs: readonly ShareDocView[]): boolean {
  const only = isSingle(docs) ? docs[0] : undefined;
  return !only || only.shareability.kind === "ANY";
}

/**
 * P28: the current Members who would not be on the list after saving,
 * computed from the ticks (not from the saved list), with the ids that
 * "Add them" ticks. Not shown for a document tied to one holder.
 */
export function missingMembers(
  holders: readonly ShareHolderView[],
  docs: readonly ShareDocView[],
  ticks: ReadonlySet<string>,
  canRemove: boolean,
): { stakeholderIds: string[]; message: string | null } {
  if (!showPresets(docs)) return { stakeholderIds: [], message: null };
  const only = isSingle(docs) ? docs[0] : undefined;
  const kept =
    only && !canRemove
      ? new Set(only.sharedWith.map((s) => s.stakeholderId))
      : new Set<string>();
  const ids = holders
    .filter(
      (h) =>
        h.isCurrentMember &&
        !ticks.has(h.stakeholderId) &&
        !kept.has(h.stakeholderId),
    )
    .map((h) => h.stakeholderId);
  if (ids.length === 0) return { stakeholderIds: [], message: null };
  return {
    stakeholderIds: ids,
    message:
      ids.length === 1
        ? "1 current Member is not on this list."
        : `${ids.length} current Members are not on this list.`,
  };
}

/**
 * What Save sends. One document: the ticked holders not yet on the list are
 * added, the listed holders no longer ticked are removed (only with
 * `portal: delete`). Several documents: the ticked holders are added to
 * every shareable document; nothing is removed.
 */
export function saveDiff(
  docs: readonly ShareDocView[],
  ticks: ReadonlySet<string>,
  canRemove: boolean,
): {
  documentPublicIds: string[];
  add: string[];
  remove: string[];
} {
  const { shareable } = bulkPlan(docs);
  const documentPublicIds = shareable.map((d) => d.documentPublicId);
  const only = isSingle(docs) ? docs[0] : undefined;
  if (!only) {
    return {
      documentPublicIds,
      add: documentPublicIds.length > 0 ? [...ticks].sort() : [],
      remove: [],
    };
  }
  const shared = new Set(only.sharedWith.map((s) => s.stakeholderId));
  return {
    documentPublicIds,
    add: [...ticks].filter((id) => !shared.has(id)).sort(),
    remove: canRemove ? [...shared].filter((id) => !ticks.has(id)).sort() : [],
  };
}

/** The holders listed under "Shared with now" that will be removed on Save. */
export function pendingRemovals(
  doc: ShareDocView,
  ticks: ReadonlySet<string>,
  canRemove: boolean,
): number {
  if (!canRemove) return 0;
  return doc.sharedWith.filter((s) => !ticks.has(s.stakeholderId)).length;
}

export function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** The notices above the picker, in order (P14, S6). */
export function shareNotices(docs: readonly ShareDocView[]): {
  tone: "info" | "warning";
  text: string;
}[] {
  const out: { tone: "info" | "warning"; text: string }[] = [];
  const only = isSingle(docs) ? docs[0] : undefined;
  if (only) {
    const s = only.shareability;
    if (s.kind === "HOLDER_ONLY") {
      out.push({
        tone: "info",
        text: `This document belongs to ${s.holderName ?? "one holder"}. It can be shared only with that holder: a W-9, a signed Exhibit B or another file tied to a holder is never shown to anyone else.`,
      });
    } else if (s.kind === "NONE") {
      out.push({
        tone: "info",
        text:
          s.reason === "MULTIPLE_HOLDERS"
            ? "This document is tied to more than one holder, so it cannot be shared in the portal."
            : "This document was filed on a holder that no longer exists, so it cannot be shared in the portal.",
      });
    }
    for (const w of only.warnings)
      out.push({ tone: "warning", text: w.message });
    return out;
  }
  const { leftOut } = bulkPlan(docs);
  if (leftOut.length > 0) {
    out.push({
      tone: "info",
      text: `${plural(leftOut.length, "selected document belongs", "selected documents belong")} to one holder and ${leftOut.length === 1 ? "is" : "are"} left out: ${leftOut
        .map((d) => d.name)
        .join(
          ", ",
        )}. Share ${leftOut.length === 1 ? "it" : "each"} from its own row.`,
    });
  }
  const warned = docs.filter(
    (d) => d.shareability.kind === "ANY" && d.warnings.length > 0,
  );
  if (warned.length > 0) {
    out.push({
      tone: "warning",
      text: `${plural(warned.length, "selected document names", "selected documents name")} other Members (${warned
        .map((d) => d.name)
        .join(", ")}). Check before you share.`,
    });
  }
  return out;
}

/** The toast after Save. */
export function saveMessage(r: {
  added: number;
  holdersAdded: number;
  removed: number;
  notify: boolean;
  notificationsQueued: number;
}): string {
  const parts: string[] = [];
  parts.push(`${plural(r.holdersAdded, "holder", "holders")} added`);
  if (r.removed > 0) parts.push(`${r.removed} removed`);
  let s = `Sharing saved: ${parts.join(", ")}.`;
  if (r.notify) {
    s +=
      r.notificationsQueued > 0
        ? ` ${plural(r.notificationsQueued, "email", "emails")} queued.`
        : " No email was queued (nobody newly added can sign in yet).";
  }
  return s;
}

/** The documents table's "Shared with" cell. */
export function sharedWithLabel(n: number): string {
  return n === 0 ? "—" : plural(n, "holder", "holders");
}

export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

// ---------------------------------------------------------------------------
// The people who can sign in, under each holder

export interface PortalPersonRow {
  stakeholderId: string;
  email: string;
  status: "INVITED" | "ACTIVE" | "DISABLED";
}

export interface PortalPerson {
  email: string;
  state: "ACTIVE" | "INVITED";
}

/** Per holder, the people with access that is not disabled, by address. */
export function peopleByHolder(
  rows: readonly PortalPersonRow[],
): Map<string, PortalPerson[]> {
  const out = new Map<string, PortalPerson[]>();
  for (const r of rows) {
    if (r.status === "DISABLED") continue;
    const list = out.get(r.stakeholderId) ?? [];
    if (!list.some((p) => p.email === r.email)) {
      list.push({ email: r.email, state: r.status });
    }
    out.set(r.stakeholderId, list);
  }
  for (const list of out.values()) {
    list.sort((a, b) => a.email.localeCompare(b.email, "en"));
  }
  return out;
}

export const PERSON_STATE_LABEL: Readonly<
  Record<PortalPerson["state"], string>
> = {
  ACTIVE: "can sign in",
  INVITED: "invited, not yet set up",
};

// ---------------------------------------------------------------------------
// The "Investor portal" page

export type PeopleStatusFilter =
  | "ALL"
  | "ACTIVE"
  | "INVITED"
  | "LOCKED"
  | "DISABLED";

export const PEOPLE_STATUS_OPTIONS: readonly {
  value: PeopleStatusFilter;
  label: string;
}[] = [
  { value: "ALL", label: "All statuses" },
  { value: "ACTIVE", label: "Active" },
  { value: "INVITED", label: "Invited" },
  { value: "LOCKED", label: "Locked" },
  { value: "DISABLED", label: "Disabled" },
];

export interface PeopleRow {
  holderName: string;
  email: string;
  status: "INVITED" | "ACTIVE" | "DISABLED";
  locked: boolean;
}

/** The status one row is filed under: a lock wins over Active and Invited. */
export function peopleStatusOf(
  r: PeopleRow,
): Exclude<PeopleStatusFilter, "ALL"> {
  if (r.status === "DISABLED") return "DISABLED";
  if (r.locked) return "LOCKED";
  return r.status;
}

/** The People tab: search by member or email, and the status filter. */
export function filterPeople<T extends PeopleRow>(
  rows: readonly T[],
  query: string,
  status: PeopleStatusFilter,
): T[] {
  const q = query.trim().toLowerCase();
  return rows.filter(
    (r) =>
      (status === "ALL" || peopleStatusOf(r) === status) &&
      (q === "" ||
        r.holderName.toLowerCase().includes(q) ||
        r.email.toLowerCase().includes(q)),
  );
}

export const EVENT_LABEL: Readonly<Record<string, string>> = {
  SIGNED_IN: "Signed in",
  SIGNED_OUT: "Signed out",
  ACCOUNT_LOCKED: "Account locked (5 wrong passwords)",
  PASSWORD_SET: "Password set",
  REPORT_VIEWED: "Viewed report",
  REPORT_FILE_OPENED: "Opened report file",
  REPORT_EXPORTED: "Downloaded Excel",
  FINANCIALS_EXPORTED: "Downloaded financials (Excel)",
  DOCUMENT_OPENED: "Opened document",
};

export function eventLabel(event: string): string {
  return EVENT_LABEL[event] ?? event;
}

/** The Activity tab's member filter: holders that have or had an access, by name, once each. */
export function memberFilterOptions(
  rows: readonly { stakeholderId: string; holderName: string }[],
): { value: string; label: string }[] {
  const seen = new Map<string, string>();
  for (const r of rows) {
    if (!seen.has(r.stakeholderId)) seen.set(r.stakeholderId, r.holderName);
  }
  return [...seen.entries()]
    .map(([value, label]) => ({ value, label }))
    .sort(
      (a, b) =>
        a.label.localeCompare(b.label, "en") || (a.value < b.value ? -1 : 1),
    );
}

/** The item filter over the rows already loaded (the server filters by member and by document). */
export function filterLogRows<
  T extends { target: { name: string | null } | null },
>(rows: readonly T[], item: string): T[] {
  const q = item.trim().toLowerCase();
  if (q === "") return [...rows];
  return rows.filter((r) => (r.target?.name ?? "").toLowerCase().includes(q));
}

/** `?tab=` of the page: People unless it says activity. */
export function portalTab(value: unknown): "people" | "activity" {
  return value === "activity" ? "activity" : "people";
}
