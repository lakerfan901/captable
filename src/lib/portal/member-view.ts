// View logic of the team's "See what this member sees" dialog
// (04-investor-portal.md 6.2; package P9b). Pure: relative imports only, no
// clock, tested (`member-view.test.ts`). The lists come from
// `portalAdmin.holderView`, which computes them with the portal's own
// visibility modules; this module only explains them.

import {
  type SourceState,
  serializeSourceState,
} from "../../components/financials/team-dashboard-model";
import { formatDateOnly } from "../date-only";
import { formatDay, periodText, reportTypeShort } from "./portal-files-view";

/** What the dialog reads of one visible report (`portal.reports.list` row). */
export interface MemberViewReport {
  type: string;
  periodStart: string | null;
  periodEnd: string | null;
  releasedAt: Date | string | null;
  hasOwnFiles: boolean;
}

/** What the dialog reads of one visible document (`portal.documents.list` row). */
export interface MemberViewDocument {
  sharedAt: Date | string;
}

/** "Quarterly report · Jul 1 – Sep 30, 2026" (type, then the period when there is one). */
export function reportSubtitle(r: MemberViewReport): string {
  const period = periodText(r.periodStart, r.periodEnd);
  return [reportTypeShort(r.type), period].filter(Boolean).join(" · ");
}

/**
 * Why the member sees this report: it was released to them and is published
 * in the portal (P11); a K-1 report shows only their own Schedule K-1 (P12);
 * other reports may carry files only this member can open.
 */
export function reportReason(r: MemberViewReport, timeZone: string): string {
  const day = formatDay(r.releasedAt, timeZone);
  const parts = [
    day
      ? `Released to this member on ${day}, published in the portal`
      : "Released to this member, published in the portal",
  ];
  if (r.type === "TAX_K1") {
    parts.push(
      r.hasOwnFiles
        ? "only their own Schedule K-1 is shown"
        : "no Schedule K-1 of theirs is attached",
    );
  } else if (r.hasOwnFiles) {
    parts.push("includes files only this member can open");
  }
  return `${parts.join("; ")}.`;
}

/** Why the member sees this document: it is shared with them (P13). */
export function documentReason(
  d: MemberViewDocument,
  timeZone: string,
): string {
  const day = formatDay(d.sharedAt, timeZone);
  return day
    ? `Shared with this member on ${day}.`
    : "Shared with this member.";
}

/**
 * Who sees these lists now. Visibility belongs to the holder: every person
 * with an active access for it sees the same lists; with none, nobody does.
 */
export function accessNote(activeAccesses: number): string {
  if (activeAccesses <= 0) {
    return "Nobody can sign in to the portal for this member at the moment, so nobody sees this now. It is what an active portal access would show.";
  }
  return activeAccesses === 1
    ? "The one person with active portal access for this member sees exactly this."
    : `The ${activeAccesses} people with active portal access for this member see exactly this.`;
}

/**
 * The Financials line: what the member's dashboard shows, by the
 * published-through date (P33) and whether there are month figures through
 * it (the portal's empty state otherwise).
 */
export function financialsLine(
  publishedThrough: string | null,
  hasFigures: boolean,
): string {
  if (publishedThrough === null) {
    return "No financial period has been published to this member yet: the portal shows no Financials or My investment.";
  }
  const through = formatDateOnly(publishedThrough);
  return hasFigures
    ? `Financials and My investment show figures through ${through}.`
    : `Reports through ${through} are released to this member, but there are no month figures for those periods, so Financials says that no period has been published yet.`;
}

/**
 * The team dashboard in "Preview as investor" for this holder, or null when
 * the preview would not open on it (it lists only holders with a published
 * month of their own, and falls back to another holder otherwise).
 */
export function previewHref(
  companyPublicId: string,
  stakeholderId: string,
  previewable: boolean,
): string | null {
  if (!previewable) return null;
  const state: SourceState = {
    source: "preview",
    holder: stakeholderId,
    section: "fund",
  };
  const q = serializeSourceState(state).toString();
  return `/${encodeURIComponent(companyPublicId)}/financials/dashboard?${q}`;
}
