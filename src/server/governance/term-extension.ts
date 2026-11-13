import "server-only";

import { TRPCError } from "@trpc/server";
import { formatDateOnly } from "@/lib/date-only";
import { buildTitle, termExtensionDates } from "@/lib/governance/presets";
import type { TPrismaOrTransaction } from "@/server/db";
import {
  findPendingTermExtension,
  getTermClockWithNextExtension,
} from "@/server/llc/economics/term";

// TERM_EXTENSION consents and the canonical term clock (03-governance.md
// R14, 02-economics.md R41; Codex review 2, finding 3).
//
// The consent states "the Target Sale Date will be extended from {current}
// to {proposed}", and approving it moves the clock by one extension (the
// clock counts EFFECTIVE TERM_EXTENSION resolutions). Those two dates are
// therefore never typed by the user: they are derived here from the clock
// (create, update and clone store them), and `resolution.send` refuses a
// draft whose dates (or title) are not exactly the clock's current effective
// Target Sale Date and the effective date after one more extension. Section
// 2.5 sets no maximum number of extensions ("Unlimited number of
// extensions", R14), so none is enforced; only one consent may be open at a
// time.

export interface TermExtensionParams {
  currentTargetSaleDate: string;
  extensionNumber: number;
}

export const NO_OCD_MESSAGE =
  "Set the Operations Commencement Date (Settings → LLC term) first: the Target Sale Date is computed from it (Sections 1.21, 2.4).";

export type CanonicalTermExtension =
  | {
      ok: true;
      params: TermExtensionParams;
      /** effective Target Sale Date now */
      current: string;
      /** effective Target Sale Date after one more approved extension */
      proposed: string;
    }
  | { ok: false; reason: string };

/** The params the clock dictates, or why no consent can be prepared now. */
export async function canonicalTermExtension(
  tx: TPrismaOrTransaction,
  companyId: string,
): Promise<CanonicalTermExtension> {
  const { clock, next } = await getTermClockWithNextExtension(tx, companyId);
  const current = clock.effectiveTargetSaleDate;
  const after = next.effectiveTargetSaleDate;
  if (current === null || after === null) {
    return { ok: false, reason: NO_OCD_MESSAGE };
  }
  const params: TermExtensionParams = {
    currentTargetSaleDate: current,
    extensionNumber: clock.extensionsApproved + 1,
  };
  // The consent text adds twelve months to the current date; the clock adds
  // one year to the un-LOI'd date and then the LOI days. They agree except
  // around a February 29: then nothing is sent rather than a guess.
  const stated = termExtensionDates(params);
  if (stated.proposed !== after) {
    return {
      ok: false,
      reason: `One more extension moves the Target Sale Date from ${formatDateOnly(current)} to ${formatDateOnly(after)} under the term clock, but the consent text would state ${formatDateOnly(stated.proposed)}. A term-extension consent cannot be prepared for these dates; ask counsel before extending the term.`,
    };
  }
  return { ok: true, params, current, proposed: after };
}

/** Every reason `resolution.send` refuses this TERM_EXTENSION draft (empty: it may be sent). */
export async function termExtensionSendBlockers(
  tx: TPrismaOrTransaction,
  companyId: string,
  draft: { id: string; params: unknown; title: string },
): Promise<string[]> {
  const canon = await canonicalTermExtension(tx, companyId);
  if (!canon.ok) return [canon.reason];
  const blockers: string[] = [];
  const stated = termExtensionDates(draft.params);
  const number = (draft.params as TermExtensionParams).extensionNumber;
  if (
    stated.current !== canon.current ||
    stated.proposed !== canon.proposed ||
    number !== canon.params.extensionNumber
  ) {
    blockers.push(
      `This draft asks to extend the Target Sale Date from ${formatDateOnly(stated.current)} to ${formatDateOnly(stated.proposed)} (extension No. ${number}), but under the term clock the current Target Sale Date is ${formatDateOnly(canon.current)} and one more extension moves it to ${formatDateOnly(canon.proposed)} (extension No. ${canon.params.extensionNumber}). Save the draft again to update its dates.`,
    );
  } else {
    const title = buildTitle("TERM_EXTENSION", canon.params, {
      companyName: "",
    });
    if (draft.title.trim() !== title) {
      blockers.push(
        `The title of a term-extension consent states the extended Target Sale Date and must be "${title}". Save the draft again to reset it.`,
      );
    }
  }
  const pending = await findPendingTermExtension(tx, companyId, draft.id);
  if (pending) {
    blockers.push(
      `The term-extension consent ${pending.referenceCode ?? "already sent"} is still open. Only one extension can be asked at a time: wait until it is decided, or withdraw it.`,
    );
  }
  return blockers;
}

/**
 * create / update / clone: a TERM_EXTENSION draft always stores the clock's
 * params and title (the form shows them read-only). Refused when no consent
 * can be prepared (no Operations Commencement Date, leap-day mismatch).
 */
export async function termExtensionDraftFields(
  tx: TPrismaOrTransaction,
  companyId: string,
): Promise<{ params: TermExtensionParams; title: string }> {
  const canon = await canonicalTermExtension(tx, companyId);
  if (!canon.ok) {
    throw new TRPCError({ code: "BAD_REQUEST", message: canon.reason });
  }
  return {
    params: canon.params,
    title: buildTitle("TERM_EXTENSION", canon.params, { companyName: "" }),
  };
}
