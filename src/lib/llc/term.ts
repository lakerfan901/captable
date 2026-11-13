// Term clock (§1.21, §2.4, §2.5, §11.1(d), R41) and distribution deadlines (§5.6(a), §8.2, R42).

import { addBusinessDays } from "./business-days";
import type { LlcEconomicsConfig } from "./config";
import {
  addDays,
  addMonths,
  addYears,
  compareIso,
  type IsoDate,
  quarterOf,
} from "./dates";
import { LlcMathError } from "./money";

export interface TermInput {
  operationsCommencementDate: IsoDate | null;
  /** EFFECTIVE TERM_EXTENSION resolutions */
  extensionsApproved: number;
  loiExtensionDays: number;
}

export interface TermClock {
  operationsCommencementDate: IsoDate | null;
  ocdNoticeDueOn: IsoDate | null;
  baseTargetSaleDate: IsoDate | null;
  extendedTargetSaleDate: IsoDate | null;
  effectiveTargetSaleDate: IsoDate | null;
  extensionRequestDueOn: IsoDate | null;
  nextExtensionTargetSaleDate: IsoDate | null;
  loiExtensionMaxDate: IsoDate | null;
  dissolutionElectionAvailableAfter: IsoDate | null;
  extensionsApproved: number;
}

export function computeTermClock(
  i: TermInput,
  cfg: LlcEconomicsConfig,
): TermClock {
  if (
    !Number.isInteger(i.loiExtensionDays) ||
    i.loiExtensionDays < 0 ||
    i.loiExtensionDays > cfg.loiExtensionMaxDays
  ) {
    throw new LlcMathError(
      "BAD_LOI_EXTENSION",
      `LOI extension must be 0..${cfg.loiExtensionMaxDays} days, got ${i.loiExtensionDays}`,
    );
  }
  if (!Number.isInteger(i.extensionsApproved) || i.extensionsApproved < 0) {
    throw new LlcMathError(
      "BAD_EXTENSIONS",
      `Extensions approved must be a non-negative integer, got ${i.extensionsApproved}`,
    );
  }
  const ocd = i.operationsCommencementDate;
  if (ocd === null) {
    return {
      operationsCommencementDate: null,
      ocdNoticeDueOn: null,
      baseTargetSaleDate: null,
      extendedTargetSaleDate: null,
      effectiveTargetSaleDate: null,
      extensionRequestDueOn: null,
      nextExtensionTargetSaleDate: null,
      loiExtensionMaxDate: null,
      dissolutionElectionAvailableAfter: null,
      extensionsApproved: i.extensionsApproved,
    };
  }
  const base = addYears(ocd, cfg.targetSaleYears);
  const extended = addYears(base, i.extensionsApproved);
  const effective = addDays(extended, i.loiExtensionDays);
  return {
    operationsCommencementDate: ocd,
    ocdNoticeDueOn: addBusinessDays(
      ocd,
      cfg.ocdNoticeBusinessDays,
      cfg.businessDays,
    ),
    baseTargetSaleDate: base,
    extendedTargetSaleDate: extended,
    effectiveTargetSaleDate: effective,
    extensionRequestDueOn: addMonths(
      extended,
      -cfg.extensionRequestMonthsBefore,
    ),
    nextExtensionTargetSaleDate: addYears(extended, 1),
    loiExtensionMaxDate: addDays(extended, cfg.loiExtensionMaxDays),
    dissolutionElectionAvailableAfter: addDays(
      effective,
      cfg.dissolutionElectionDays,
    ),
    extensionsApproved: i.extensionsApproved,
  };
}

export function consentDeemedAgainstOn(
  requestSentOn: IsoDate,
  cfg: LlcEconomicsConfig,
): IsoDate {
  return addDays(requestSentOn, cfg.extensionConsentWindowDays);
}

/** True when `d` is before the effective Target Sale Date; null when there is no OCD. */
export function isBeforeTargetSaleDate(
  d: IsoDate,
  clock: TermClock,
): boolean | null {
  if (clock.effectiveTargetSaleDate === null) return null;
  return compareIso(d, clock.effectiveTargetSaleDate) < 0;
}

/** R42: calendar days after quarter end, not rolled to a business day. */
export function distributionDeadline(
  quarterEnd: IsoDate,
  cfg: LlcEconomicsConfig,
): IsoDate {
  return addDays(quarterEnd, cfg.distributionDeadlineDays);
}

/** Every quarter end in [from, to]. */
export function quarterlyDeadlines(
  from: IsoDate,
  to: IsoDate,
  cfg: LlcEconomicsConfig,
): { quarterEnd: IsoDate; deadline: IsoDate; label: string }[] {
  const out: { quarterEnd: IsoDate; deadline: IsoDate; label: string }[] = [];
  let q = quarterOf(from);
  while (compareIso(q.end, to) <= 0) {
    out.push({
      quarterEnd: q.end,
      deadline: distributionDeadline(q.end, cfg),
      label: `Q${q.quarter} ${q.year}`,
    });
    q = quarterOf(addDays(q.end, 1));
  }
  return out;
}
