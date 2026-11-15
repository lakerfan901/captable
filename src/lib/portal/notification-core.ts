// The "new documents" notification (04-investor-portal.md 5.8, 9.2 item 8;
// package P10): who gets one, and the wording that needs no database. Pure:
// no `@/` imports.
//
// Rule. For one share action with "notify" ticked, a PERSON (portal user)
// gets exactly one email when, at queue time AND again at send time, they
// have an ACTIVE `PortalAccess` with a password set to at least one holder
// that gained at least one document in that action. The email names only
// those holders (each with the number of documents it gained), the company,
// and a sign-in link; no document name, no file, no token. Holders that
// already had every document gained nothing and cause no email.

import { safeNextPath } from "./next-path";

/** `PortalNotification.kind` and `EmailLog.kind` (mail kinds of 5.6). */
export const DOCUMENTS_SHARED_KIND = "portal.documents-shared";

export interface NotificationAccess {
  portalUserId: string;
  stakeholderId: string;
  status: "ACTIVE" | "DISABLED";
  passwordSet: boolean;
}

/**
 * Per portal user, the affected holders they may be told about: ACTIVE
 * access, password set, holder in `affectedStakeholderIds`. Users with none
 * are absent. Holder ids are sorted and unique; users come out sorted by id
 * (a stable order for inserts and tests).
 */
export function notificationRecipients(
  accesses: readonly NotificationAccess[],
  affectedStakeholderIds: Iterable<string>,
): Map<string, string[]> {
  const affected = new Set(affectedStakeholderIds);
  const byUser = new Map<string, Set<string>>();
  for (const a of accesses) {
    if (a.status !== "ACTIVE" || !a.passwordSet) continue;
    if (!affected.has(a.stakeholderId)) continue;
    const set = byUser.get(a.portalUserId) ?? new Set<string>();
    set.add(a.stakeholderId);
    byUser.set(a.portalUserId, set);
  }
  return new Map(
    [...byUser.keys()]
      .sort()
      .map((u) => [u, [...(byUser.get(u) ?? [])].sort()] as const),
  );
}

/**
 * Per holder that gained at least one document in the share action, the
 * public ids of the documents it gained (from the share result,
 * `documents[].addedStakeholderIds`). A holder that already had every
 * document is absent. Keys and lists are sorted and unique.
 */
export function gainedByHolder(
  documents: readonly {
    documentPublicId: string;
    addedStakeholderIds: readonly string[];
  }[],
): Map<string, string[]> {
  const by = new Map<string, Set<string>>();
  for (const d of documents) {
    for (const s of d.addedStakeholderIds) {
      const set = by.get(s) ?? new Set<string>();
      set.add(d.documentPublicId);
      by.set(s, set);
    }
  }
  return new Map(
    [...by.keys()].sort().map((s) => [s, [...(by.get(s) ?? [])].sort()]),
  );
}

/** Subject line: the company only (one string per share action, never a holder). */
export function documentsSharedSubject(companyName: string | null): string {
  return companyName
    ? `New documents in the ${companyName} investor portal`
    : "New documents in the investor portal";
}

/** "1 new document", "3 new documents". */
export function documentCountPhrase(n: number): string {
  return n === 1 ? "1 new document" : `${n} new documents`;
}

/**
 * The link of the email: the portal sign-in page. With exactly one holder,
 * `next` leads to that holder's documents page (`/portal/{access}/documents`,
 * through `safeNextPath`; a browser already signed in goes straight there).
 * With several holders, no `next`: after sign-in the chooser lists them.
 * The access public id identifies, it does not authorize (S25).
 */
export function documentsSignInUrl(
  baseUrl: string,
  accessPublicIds: readonly string[],
): string {
  const signIn = `${baseUrl.replace(/\/+$/, "")}/portal/sign-in`;
  if (accessPublicIds.length !== 1) return signIn;
  const next = safeNextPath(`/portal/${accessPublicIds[0]}/documents`);
  if (next === "/portal") return signIn;
  return `${signIn}?next=${encodeURIComponent(next)}`;
}

/**
 * The holder whose Emails tab carries the one EmailLog row of a
 * multi-holder email: the lowest stakeholder id (deterministic).
 */
export function logStakeholderId(stakeholderIds: readonly string[]): string {
  const sorted = [...stakeholderIds].sort();
  const first = sorted[0];
  if (first === undefined) throw new Error("no holder to log the email on");
  return first;
}

/** pg-boss singleton key: one job per notification row. */
export function notificationSingletonKey(notificationId: string): string {
  return `portal-notification-${notificationId}`;
}
