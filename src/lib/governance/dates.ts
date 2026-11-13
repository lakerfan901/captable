// Governance date and deadline math (03-governance.md G3). Pure: no function
// reads the system clock; callers pass `now` / `today`.

import dayjs from "dayjs";
import timezone from "dayjs/plugin/timezone";
import utc from "dayjs/plugin/utc";
import {
  addDays as llcAddDays,
  addMonths as llcAddMonths,
  daysBetween as llcDaysBetween,
  quarterOf as llcQuarterOf,
} from "../llc/dates";

dayjs.extend(utc);
dayjs.extend(timezone);

export const GOVERNANCE_TIME_ZONE = "America/Denver";

/** A "YYYY-MM-DD" calendar date. */
export type Ymd = string;

/** Same shape as ECONOMICS `addBusinessDays`: day 1 is the first business day strictly after `ymd`. */
export type AddBusinessDays = (ymd: Ymd, n: number) => Ymd;

/** UTC midnight of the date. */
export function ymdToUtcDate(ymd: Ymd): Date {
  return new Date(`${ymd}T00:00:00.000Z`);
}

export function utcDateToYmd(date: Date): Ymd {
  return date.toISOString().slice(0, 10);
}

export const addDays: (ymd: Ymd, n: number) => Ymd = llcAddDays;
/** Clamps the day to the month length (Jan 31 + 1 month = Feb 28/29). */
export const addMonths: (ymd: Ymd, n: number) => Ymd = llcAddMonths;
/** `to - from` in days. */
export const daysBetween: (from: Ymd, to: Ymd) => number = llcDaysBetween;

export function todayInZone(now: Date, tz: string = GOVERNANCE_TIME_ZONE): Ymd {
  return dayjs(now).tz(tz).format("YYYY-MM-DD");
}

/** 23:59:59.999 local time on `ymd` in `tz`. */
export function endOfDayInZone(
  ymd: Ymd,
  tz: string = GOVERNANCE_TIME_ZONE,
): Date {
  const nextMidnight = dayjs.tz(addDays(ymd, 1), tz).valueOf();
  return new Date(nextMidnight - 1);
}

/** R14: last instant on which a response counts. */
export function responseDeadline(
  sentAt: Date,
  days: number,
  tz: string = GOVERNANCE_TIME_ZONE,
): Date {
  return endOfDayInZone(addDays(todayInZone(sentAt, tz), days), tz);
}

export interface FiscalQuarter {
  fiscalYear: number;
  quarter: 1 | 2 | 3 | 4;
  start: Ymd;
  end: Ymd;
}

/** R42: fiscal year = calendar year. */
export function quarterOf(ymd: Ymd): FiscalQuarter {
  const q = llcQuarterOf(ymd);
  return { fiscalYear: q.year, quarter: q.quarter, start: q.start, end: q.end };
}

export function quarterBounds(
  fiscalYear: number,
  quarter: 1 | 2 | 3 | 4,
): FiscalQuarter {
  const month = String((quarter - 1) * 3 + 1).padStart(2, "0");
  return quarterOf(`${String(fiscalYear).padStart(4, "0")}-${month}-01`);
}

/** R23: quarter end + 45 calendar days (not rolled to a business day). */
export function quarterlyReportDueOn(
  fiscalYear: number,
  quarter: 1 | 2 | 3 | 4,
): Ymd {
  return addDays(quarterBounds(fiscalYear, quarter).end, 45);
}

/** R24: Dec 31 + 90 days. */
export function annualFinancialsDueOn(fiscalYear: number): Ymd {
  return addDays(`${fiscalYear}-12-31`, 90);
}

/** R25: March 31 of the following year. */
export function k1TargetDueOn(fiscalYear: number): Ymd {
  return `${fiscalYear + 1}-03-31`;
}

/** R25: September 15 of the following year (extended Form 1065 due date). */
export function k1FinalDueOn(fiscalYear: number): Ymd {
  return `${fiscalYear + 1}-09-15`;
}

/** R35: a notice received on the 1st takes effect on the 1st of the next month. */
export function firstOfFollowingMonth(ymd: Ymd): Ymd {
  return addMonths(`${ymd.slice(0, 7)}-01`, 1);
}

export interface TransferDatesInput {
  kind:
    | "VOLUNTARY"
    | "PERMITTED_TRANSFEREE"
    | "INVOLUNTARY"
    | "DEATH_INCAPACITY";
  noticeReceivedOn: Ymd;
  transferNoticeOn: Ymd | null;
  priceEstablishedOn: Ymd | null;
}

export interface TransferDates {
  noticeCopyDueOn: Ymd | null;
  managerRofrEndsOn: Ymd | null;
  memberRofrEndsOn: Ymd | null;
  closeByOn: Ymd | null;
  purchaseCloseByOn: Ymd | null;
  effectiveOn: Ymd | null;
}

export function computeTransferDates(
  input: TransferDatesInput,
  add: AddBusinessDays,
): TransferDates {
  const hasRofr = input.kind === "VOLUNTARY" || input.kind === "INVOLUNTARY";
  const received = input.noticeReceivedOn;
  return {
    noticeCopyDueOn: hasRofr ? add(received, 5) : null,
    managerRofrEndsOn: hasRofr ? addDays(received, 45) : null,
    memberRofrEndsOn: hasRofr ? addDays(received, 90) : null,
    closeByOn: input.kind === "VOLUNTARY" ? addDays(received, 270) : null,
    purchaseCloseByOn: input.priceEstablishedOn
      ? addDays(input.priceEstablishedOn, 45)
      : null,
    effectiveOn: input.transferNoticeOn
      ? firstOfFollowingMonth(input.transferNoticeOn)
      : null,
  };
}

export interface DeadlineSpec {
  ruleKey: string;
  dedupeKey: string;
  title: string;
  section: string;
  dueOn: Ymd;
}

/** Rule-based deadlines C1–C4 (see G14). Pure: no database. */
export function generateRuleDeadlines(input: {
  firstAdmittedOn: Ymd | null;
  today: Ymd;
  horizonDays: number;
}): DeadlineSpec[] {
  const { firstAdmittedOn } = input;
  if (firstAdmittedOn === null) return [];
  const limit = addDays(input.today, input.horizonDays);
  const specs: DeadlineSpec[] = [];

  let q = quarterOf(firstAdmittedOn);
  for (;;) {
    const dueOn = quarterlyReportDueOn(q.fiscalYear, q.quarter);
    if (dueOn > limit) break;
    specs.push({
      ruleKey: "QUARTERLY_REPORT",
      dedupeKey: `QUARTERLY_REPORT:${q.fiscalYear}Q${q.quarter}`,
      title: `Q${q.quarter} ${q.fiscalYear} quarterly report to Members`,
      section: "8.2; 5.6(a)",
      dueOn,
    });
    q = quarterOf(addDays(q.end, 1));
  }

  // The fiscal year of firstAdmittedOn is the first whose Dec 31 >= it.
  for (let fy = Number(firstAdmittedOn.slice(0, 4)); ; fy++) {
    const yearly: DeadlineSpec[] = [
      {
        ruleKey: "ANNUAL_FINANCIALS",
        dedupeKey: `ANNUAL_FINANCIALS:${fy}`,
        title: `FY${fy} balance sheet and income statement to Members`,
        section: "8.2",
        dueOn: annualFinancialsDueOn(fy),
      },
      {
        ruleKey: "K1_TARGET",
        dedupeKey: `K1_TARGET:${fy}`,
        title: `FY${fy} Schedules K-1 to Members (target)`,
        section: "8.2",
        dueOn: k1TargetDueOn(fy),
      },
      {
        ruleKey: "K1_FINAL",
        dedupeKey: `K1_FINAL:${fy}`,
        title: `FY${fy} Schedules K-1 (extended filing deadline)`,
        section: "8.2",
        dueOn: k1FinalDueOn(fy),
      },
    ];
    const inHorizon = yearly.filter((s) => s.dueOn <= limit);
    if (inHorizon.length === 0) break;
    specs.push(...inHorizon);
  }

  return specs.sort((a, b) =>
    a.dueOn !== b.dueOn
      ? a.dueOn < b.dueOn
        ? -1
        : 1
      : a.dedupeKey < b.dedupeKey
        ? -1
        : a.dedupeKey > b.dedupeKey
          ? 1
          : 0,
  );
}

const REMINDER_BUCKETS = [0, 1, 3, 7, 14, 30] as const;

/** Reminder bucket for a deadline today, or null when no reminder is due (G14). */
export function reminderBucket(dueOn: Ymd, today: Ymd): number | null {
  const left = daysBetween(today, dueOn);
  if (left > 30) return null;
  if (left >= 0) return REMINDER_BUCKETS.find((b) => b >= left) ?? null;
  return -(Math.floor((-left - 1) / 7) + 1);
}
