import "server-only";

import type { DayCountEnum, LlcTerm, UnitClass } from "@prisma/client";
import { formatDateOnly, fromDateOnly, toDateOnly } from "@/lib/date-only";
import {
  type LlcEconomicsConfig,
  OA_DEFAULTS,
  type OffsetTarget,
} from "@/lib/llc/config";
import type { IsoDate } from "@/lib/llc/dates";
import { computeTermClock, type TermClock } from "@/lib/llc/term";
import type { TPrismaOrTransaction } from "@/server/db";
import { economicsToday } from "./clock";
import { ruleViolation } from "./scope";

type Tx = TPrismaOrTransaction;

const DAY_COUNT_BASIS: Record<DayCountEnum, number> = { ACTUAL_365: 365 };

const OFFSET_ORDER: Record<LlcTerm["defaultOffsetOrder"], OffsetTarget[]> = {
  BALANCE_INTEREST_COSTS: ["BALANCE", "INTEREST", "COSTS"],
  COSTS_INTEREST_BALANCE: ["COSTS", "INTEREST", "BALANCE"],
};

function dateOrNull(d: Date | null): IsoDate | null {
  return d === null ? null : toDateOnly(d);
}

/**
 * The company's single LlcTerm row, created on first use with the column
 * defaults. Safe when two first uses race: `upsert` can raise P2002 for the
 * loser, and inside an interactive transaction a failed statement aborts the
 * whole transaction, so the row is inserted with ON CONFLICT DO NOTHING
 * (`createMany({ skipDuplicates })`, which waits for a concurrent insert of
 * the same key) and then read.
 */
export async function getOrCreateLlcTerm(
  tx: Tx,
  companyId: string,
): Promise<LlcTerm> {
  const existing = await tx.llcTerm.findUnique({ where: { companyId } });
  if (existing) return existing;
  await tx.llcTerm.createMany({
    data: [
      {
        companyId,
        replacementFunderOutsideDate: fromDateOnly(
          OA_DEFAULTS.replacementFunderOutsideDate,
        ),
        extraHolidays: [],
      },
    ],
    skipDuplicates: true,
  });
  return await tx.llcTerm.findUniqueOrThrow({ where: { companyId } });
}

type TermConfig = Omit<
  LlcEconomicsConfig,
  | "pricePerUnitCents"
  | "fractionalUnitsAllowed"
  | "prefReturnBps"
  | "dayCountBasis"
  | "residualPreferredBps"
  | "balanceReturnStartRule"
  | "finalClosingDate"
  | "balanceOutsideDate"
>;

/** The LlcTerm-derived half of the config (everything not on the unit class). */
function termConfig(term: LlcTerm): TermConfig {
  return {
    replacementFunderOutsideDate: toDateOnly(term.replacementFunderOutsideDate),
    prefAccrualCutoff: term.prefAccrualCutoff,
    accrueOnDefaulterCapital: term.accrueOnDefaulterCapital,
    capitalReturnLotOrder: term.capitalReturnLotOrder,
    callNoticeBusinessDays: term.callNoticeBusinessDays,
    forfeitureCureBusinessDays: term.forfeitureCureBusinessDays,
    creditDateMaxDays: term.creditDateMaxDays,
    defaultInterestBps: term.defaultInterestBps,
    defaultInterestDayBasis: term.defaultInterestDayBasis,
    forfeitureBps: term.forfeitureBps,
    replacementCreditBps: term.replacementCreditBps,
    forfeitureBaseNetOfReplacementFunding:
      term.forfeitureBaseNetOfReplacementFunding,
    defaultOffsetOrder: OFFSET_ORDER[term.defaultOffsetOrder],
    managementFeeBps: term.managementFeeBps,
    minimumOperatingReserveCents: term.minimumOperatingReserveCents,
    orgExpenseCapCents: term.orgExpenseCapCents,
    distributionDeadlineDays: term.distributionDeadlineDays,
    targetSaleYears: term.targetSaleYears,
    loiExtensionMaxDays: term.loiExtensionMaxDays,
    extensionRequestMonthsBefore: term.extensionRequestMonthsBefore,
    extensionConsentWindowDays: term.extensionConsentWindowDays,
    dissolutionElectionDays: term.dissolutionElectionDays,
    ocdNoticeBusinessDays: term.ocdNoticeBusinessDays,
    includeInsiderDistributionsInManagerList:
      term.includeInsiderDistributionsInManagerList,
    businessDays: {
      holidays: term.holidayCalendar,
      saturdayObservedOnFriday: term.saturdayHolidayObservedFriday,
      extraHolidays: term.extraHolidays.map(toDateOnly),
    },
  };
}

export function buildConfig(
  term: LlcTerm,
  preferred: UnitClass,
): LlcEconomicsConfig {
  const price = preferred.pricePerUnitCents;
  if (price === null || price <= 0n) {
    ruleViolation("Set the price per unit on the Preferred unit class.");
  }
  return {
    pricePerUnitCents: price,
    fractionalUnitsAllowed: preferred.fractionalUnitsAllowed,
    prefReturnBps: preferred.prefReturnBps,
    dayCountBasis: DAY_COUNT_BASIS[preferred.prefReturnDayCount],
    residualPreferredBps: preferred.residualSplitBps,
    balanceReturnStartRule: preferred.balanceReturnStartRule,
    finalClosingDate: dateOrNull(preferred.finalClosingDate),
    balanceOutsideDate: dateOrNull(preferred.balanceOutsideDate),
    ...termConfig(term),
  };
}

const NO_PREFERRED_CLASS =
  "The company has no Preferred unit class. Switch the company to LLC in Settings to create it.";

export async function getEconomicsContext(
  tx: Tx,
  company: { id: string; timezone: string },
): Promise<{
  term: LlcTerm;
  config: LlcEconomicsConfig;
  today: IsoDate;
  preferredClass: UnitClass;
  commonClass: UnitClass | null;
}> {
  const term = await getOrCreateLlcTerm(tx, company.id);
  const classes = await tx.unitClass.findMany({
    where: { companyId: company.id },
  });
  const preferredClass = classes.find((c) => c.kind === "PREFERRED");
  if (!preferredClass) ruleViolation(NO_PREFERRED_CLASS);
  const commonClass = classes.find((c) => c.kind === "COMMON") ?? null;
  return {
    term,
    config: buildConfig(term, preferredClass),
    today: economicsToday(company.timezone),
    preferredClass,
    commonClass,
  };
}

export function requireOutsideDate(config: LlcEconomicsConfig): IsoDate {
  if (config.balanceOutsideDate === null) {
    ruleViolation(
      "Enter the Balance outside date (Section 4.9) on the Preferred unit class first.",
    );
  }
  return config.balanceOutsideDate;
}

export function assertBooksOpen(term: LlcTerm, date: IsoDate): void {
  const closed = dateOrNull(term.booksClosedThrough);
  if (closed !== null && date <= closed) {
    ruleViolation(
      `Books are closed through ${formatDateOnly(closed)}. Reopen them on the Term clock settings page to record anything dated ${formatDateOnly(date)}.`,
    );
  }
}

/** Rejects a date earlier than the payment date of a finalized distribution (same day is allowed). */
export async function assertLedgerDateOpen(
  tx: Tx,
  companyId: string,
  date: IsoDate,
): Promise<void> {
  const later = await tx.distribution.findFirst({
    where: {
      companyId,
      status: "FINALIZED",
      isReversal: false,
      paymentDate: { gt: fromDateOnly(date) },
    },
    orderBy: { paymentDate: "desc" },
    select: { number: true, paymentDate: true },
  });
  if (later) {
    ruleViolation(
      `Distribution ${later.number === null ? "" : `#${later.number} `}was paid on ${formatDateOnly(toDateOnly(later.paymentDate))}, after ${formatDateOnly(date)}. Reverse it before recording anything dated earlier.`,
    );
  }
}

/** booksClosedThrough = max(current, date). */
export async function closeBooksThrough(
  tx: Tx,
  companyId: string,
  date: IsoDate,
): Promise<void> {
  const term = await getOrCreateLlcTerm(tx, companyId);
  const current = dateOrNull(term.booksClosedThrough);
  if (current !== null && current >= date) return;
  await tx.llcTerm.update({
    where: { companyId },
    data: { booksClosedThrough: fromDateOnly(date) },
  });
}

/** Approved one-year extensions: EFFECTIVE GOVERNANCE TERM_EXTENSION resolutions. */
export async function countTermExtensions(
  tx: Tx,
  companyId: string,
): Promise<number> {
  return await tx.resolution.count({
    where: { companyId, type: "TERM_EXTENSION", status: "EFFECTIVE" },
  });
}

/**
 * True once the economics have history (any FINALIZED distribution, any
 * MemberDefault or any Call Notice line that is being sent, was sent or was
 * paid — SENDING, SENT or PAID): the interpretation switches and default
 * parameters are then frozen (E7 `llcTerm.update`). A line paid in full stays
 * a sent notice, so PAID lines keep the lock.
 */
export async function isEconomicsLocked(
  tx: Tx,
  companyId: string,
): Promise<boolean> {
  const distribution = await tx.distribution.findFirst({
    where: { companyId, status: "FINALIZED" },
    select: { id: true },
  });
  if (distribution) return true;
  const memberDefault = await tx.memberDefault.findFirst({
    where: { companyId },
    select: { id: true },
  });
  if (memberDefault) return true;
  const line = await tx.callNoticeLine.findFirst({
    where: { companyId, status: { in: ["SENDING", "SENT", "PAID"] } },
    select: { id: true },
  });
  return line !== null;
}

export async function getTermClock(
  tx: Tx,
  companyId: string,
): Promise<TermClock> {
  const term = await getOrCreateLlcTerm(tx, companyId);
  // The clock reads only LlcTerm-derived fields, so it works before the
  // Preferred unit class terms (price per unit) are complete.
  const config: LlcEconomicsConfig = { ...OA_DEFAULTS, ...termConfig(term) };
  return computeTermClock(
    {
      operationsCommencementDate: dateOrNull(term.operationsCommencementDate),
      extensionsApproved: await countTermExtensions(tx, companyId),
      loiExtensionDays: term.loiExtensionDays,
    },
    config,
  );
}
