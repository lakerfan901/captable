// Economics configuration: built from FOUNDATION's Preferred UnitClass and LlcTerm.

import type { BusinessDayOptions } from "./business-days";
import type { IsoDate } from "./dates";
import type { Cents } from "./money";

export type OffsetTarget = "BALANCE" | "INTEREST" | "COSTS";

export interface LlcEconomicsConfig {
  // from FOUNDATION's Preferred UnitClass
  pricePerUnitCents: Cents;
  fractionalUnitsAllowed: boolean;
  prefReturnBps: number;
  dayCountBasis: number;
  residualPreferredBps: number;
  balanceReturnStartRule: "LATER_OF_RECEIPT_AND_DUE" | "RECEIPT_DATE";
  finalClosingDate: IsoDate | null;
  balanceOutsideDate: IsoDate | null;
  // from LlcTerm
  replacementFunderOutsideDate: IsoDate;
  prefAccrualCutoff: "PAYMENT_DATE" | "PERIOD_END";
  accrueOnDefaulterCapital: boolean;
  capitalReturnLotOrder: "PRO_RATA" | "FIFO" | "LIFO";
  callNoticeBusinessDays: number;
  forfeitureCureBusinessDays: number;
  creditDateMaxDays: number;
  defaultInterestBps: number;
  defaultInterestDayBasis: number;
  forfeitureBps: number;
  replacementCreditBps: number;
  forfeitureBaseNetOfReplacementFunding: boolean;
  defaultOffsetOrder: readonly OffsetTarget[];
  managementFeeBps: number;
  minimumOperatingReserveCents: Cents;
  orgExpenseCapCents: Cents;
  distributionDeadlineDays: number;
  targetSaleYears: number;
  loiExtensionMaxDays: number;
  extensionRequestMonthsBefore: number;
  extensionConsentWindowDays: number;
  dissolutionElectionDays: number;
  ocdNoticeBusinessDays: number;
  includeInsiderDistributionsInManagerList: boolean;
  businessDays: BusinessDayOptions;
}

export const OA_DEFAULTS: LlcEconomicsConfig = {
  pricePerUnitCents: 100_000n,
  fractionalUnitsAllowed: true,
  prefReturnBps: 800,
  dayCountBasis: 365,
  residualPreferredBps: 7000,
  balanceReturnStartRule: "LATER_OF_RECEIPT_AND_DUE",
  finalClosingDate: "2026-11-30",
  balanceOutsideDate: "2027-03-31",
  replacementFunderOutsideDate: "2027-06-30",
  prefAccrualCutoff: "PAYMENT_DATE",
  accrueOnDefaulterCapital: true,
  capitalReturnLotOrder: "PRO_RATA",
  callNoticeBusinessDays: 3,
  forfeitureCureBusinessDays: 5,
  creditDateMaxDays: 30,
  defaultInterestBps: 1200,
  defaultInterestDayBasis: 365,
  forfeitureBps: 5000,
  replacementCreditBps: 5000,
  forfeitureBaseNetOfReplacementFunding: false,
  defaultOffsetOrder: ["BALANCE", "INTEREST", "COSTS"],
  managementFeeBps: 500,
  minimumOperatingReserveCents: 5_000_000n,
  orgExpenseCapCents: 4_000_000n,
  distributionDeadlineDays: 45,
  targetSaleYears: 5,
  loiExtensionMaxDays: 180,
  extensionRequestMonthsBefore: 9,
  extensionConsentWindowDays: 30,
  dissolutionElectionDays: 180,
  ocdNoticeBusinessDays: 10,
  includeInsiderDistributionsInManagerList: true,
  businessDays: {
    holidays: "US_FEDERAL",
    saturdayObservedOnFriday: true,
    extraHolidays: [],
  },
};
