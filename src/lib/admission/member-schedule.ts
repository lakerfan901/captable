/**
 * Member Schedule (live Exhibit A) builder. Pure: the server loader
 * (`src/server/llc/member-schedule.ts`) passes wire-typed inputs, so this is
 * unit-testable. Units are handled as bigint micro-units and percentages as
 * integers in 1/10,000 of a percent; no floating point.
 */
import { diffInDays } from "../date-only";
import { microUnitsFromDecimal, microUnitsToDecimalString } from "../llc/money";

type Cents = number;
type Units = string;
type Pct = string;
type DateOnly = string;

export type LlcMemberStatus = "PROSPECT" | "MEMBER" | "FINANCIAL_INTEREST_ONLY";

export type MemberScheduleInput = {
  asOf: DateOnly;
  today: DateOnly;
  companyName: string;
  classes: {
    id: string;
    kind: "PREFERRED" | "COMMON";
    name: string;
    offeringCapCents: Cents | null;
    finalClosingDate: DateOnly | null;
    initialInstallmentBps: number;
  }[];
  members: {
    id: string;
    name: string;
    memberStatus: LlcMemberStatus;
    isInsider: boolean;
    admittedOn: DateOnly | null;
    noticeAddress: string;
    noticeEmail: string;
  }[];
  positions: {
    stakeholderId: string;
    unitClassId: string;
    committedCents: Cents;
    pendingCommittedCents: Cents;
    capitalCents: Cents;
    units: Units;
  }[];
  pending: { count: number; committedCents: Cents; overdueDecisions: number };
  refunds: { count: number; outstandingCents: Cents };
};

export type MemberScheduleCommonRow = {
  stakeholderId: string;
  name: string;
  capitalContributionCents: Cents;
  units: Units;
  percent: Pct;
};

export type MemberSchedulePreferredRow = {
  stakeholderId: string;
  name: string;
  committedCents: Cents;
  paidCents: Cents;
  units: Units;
  percent: Pct;
  admittedOn: DateOnly | null;
  noticeAddress: string;
  noticeEmail: string;
  memberStatus: LlcMemberStatus;
  isInsider: boolean;
};

export type MemberScheduleDTO = {
  asOf: DateOnly;
  companyName: string;
  common: {
    className: string;
    rows: MemberScheduleCommonRow[];
    totalUnits: Units;
  };
  preferred: {
    className: string;
    rows: MemberSchedulePreferredRow[];
    totals: {
      committedCents: Cents;
      paidCents: Cents;
      units: Units;
      percent: Pct;
    };
  };
  indicators: {
    capCents: Cents | null;
    committedCents: Cents;
    remainingCents: Cents | null;
    capUsedBps: number | null;
    finalClosingDate: DateOnly | null;
    daysToFinalClosing: number | null;
    initialInstallmentBps: number;
    pendingCount: number;
    pendingCommittedCents: Cents;
    overdueDecisions: number;
    refundsOutstandingCount: number;
    refundsOutstandingCents: Cents;
  };
  managerNotice: { name: string; address: string; email: string }[];
};

/** Whole percent in steps of 1/10,000 of a percent. */
const PCT_STEPS = 1_000_000n;

/** 333334n → "33.3334". */
export function formatPctSteps(steps: bigint): Pct {
  const whole = steps / 10_000n;
  const frac = (steps % 10_000n).toString().padStart(4, "0");
  return `${whole}.${frac}`;
}

/**
 * Percentage of the class for each holder, 4 decimals, by largest remainder
 * so the column sums to exactly 100.0000. Ties in the remainder go to more
 * units first, then the smaller `stakeholderId`. Total 0 → all "0.0000".
 */
export function largestRemainderPercents(
  holders: { stakeholderId: string; units: Units }[],
): Map<string, Pct> {
  const items = holders.map((h) => ({
    id: h.stakeholderId,
    micro: microUnitsFromDecimal(h.units),
  }));
  const total = items.reduce((s, i) => s + i.micro, 0n);
  const result = new Map<string, Pct>();
  if (total === 0n) {
    for (const i of items) result.set(i.id, "0.0000");
    return result;
  }
  const shares = items.map((i) => {
    const scaled = i.micro * PCT_STEPS;
    return { ...i, steps: scaled / total, remainder: scaled % total };
  });
  let missing = PCT_STEPS - shares.reduce((s, i) => s + i.steps, 0n);
  const order = [...shares].sort((a, b) => {
    if (a.remainder !== b.remainder) return a.remainder > b.remainder ? -1 : 1;
    if (a.micro !== b.micro) return a.micro > b.micro ? -1 : 1;
    if (a.id !== b.id) return a.id < b.id ? -1 : 1;
    return 0;
  });
  for (const s of order) {
    if (missing <= 0n) break;
    s.steps += 1n;
    missing -= 1n;
  }
  for (const s of shares) result.set(s.id, formatPctSteps(s.steps));
  return result;
}

type Member = MemberScheduleInput["members"][number];
type Position = MemberScheduleInput["positions"][number];

function byAdmissionThenName(
  a: { member: Member },
  b: { member: Member },
): number {
  const da = a.member.admittedOn;
  const db = b.member.admittedOn;
  if (da !== db) {
    if (da === null) return 1;
    if (db === null) return -1;
    return da < db ? -1 : 1;
  }
  if (a.member.name !== b.member.name)
    return a.member.name < b.member.name ? -1 : 1;
  if (a.member.id !== b.member.id) return a.member.id < b.member.id ? -1 : 1;
  return 0;
}

function rowsForClass(
  input: MemberScheduleInput,
  unitClassId: string | undefined,
): { member: Member; position: Position }[] {
  if (unitClassId === undefined) return [];
  const members = new Map(input.members.map((m) => [m.id, m]));
  const out: { member: Member; position: Position }[] = [];
  for (const p of input.positions) {
    if (p.unitClassId !== unitClassId) continue;
    if (!(p.committedCents > 0 || microUnitsFromDecimal(p.units) !== 0n))
      continue;
    const member = members.get(p.stakeholderId);
    if (!member) {
      throw new Error(
        `Position references stakeholder ${p.stakeholderId}, which was not loaded.`,
      );
    }
    out.push({ member, position: p });
  }
  return out.sort(byAdmissionThenName);
}

const sumUnits = (units: Units[]): Units =>
  microUnitsToDecimalString(
    units.reduce((s, u) => s + microUnitsFromDecimal(u), 0n),
  );

export function buildMemberSchedule(
  input: MemberScheduleInput,
): MemberScheduleDTO {
  const preferredClass = input.classes.find((c) => c.kind === "PREFERRED");
  const commonClass = input.classes.find((c) => c.kind === "COMMON");

  const commonRows = rowsForClass(input, commonClass?.id);
  const commonPct = largestRemainderPercents(commonRows.map((r) => r.position));
  const common: MemberScheduleDTO["common"] = {
    className: commonClass?.name ?? "",
    rows: commonRows.map(({ member, position }) => ({
      stakeholderId: member.id,
      name: member.name,
      capitalContributionCents: position.capitalCents,
      units: microUnitsToDecimalString(microUnitsFromDecimal(position.units)),
      percent: commonPct.get(member.id) ?? "0.0000",
    })),
    totalUnits: sumUnits(commonRows.map((r) => r.position.units)),
  };

  const prefRows = rowsForClass(input, preferredClass?.id);
  const prefPct = largestRemainderPercents(prefRows.map((r) => r.position));
  const rows: MemberSchedulePreferredRow[] = prefRows.map(
    ({ member, position }) => ({
      stakeholderId: member.id,
      name: member.name,
      committedCents: position.committedCents,
      paidCents: position.capitalCents,
      units: microUnitsToDecimalString(microUnitsFromDecimal(position.units)),
      percent: prefPct.get(member.id) ?? "0.0000",
      admittedOn: member.admittedOn,
      noticeAddress: member.noticeAddress,
      noticeEmail: member.noticeEmail,
      memberStatus: member.memberStatus,
      isInsider: member.isInsider,
    }),
  );
  const prefUnits = sumUnits(rows.map((r) => r.units));
  const preferred: MemberScheduleDTO["preferred"] = {
    className: preferredClass?.name ?? "",
    rows,
    totals: {
      committedCents: rows.reduce((s, r) => s + r.committedCents, 0),
      paidCents: rows.reduce((s, r) => s + r.paidCents, 0),
      units: prefUnits,
      percent:
        microUnitsFromDecimal(prefUnits) === 0n
          ? "0.0000"
          : formatPctSteps(PCT_STEPS),
    },
  };

  const committedCents = preferred.totals.committedCents;
  const capCents = preferredClass?.offeringCapCents ?? null;
  const finalClosingDate = preferredClass?.finalClosingDate ?? null;
  const indicators: MemberScheduleDTO["indicators"] = {
    capCents,
    committedCents,
    remainingCents:
      capCents === null ? null : Math.max(0, capCents - committedCents),
    capUsedBps:
      capCents === null || capCents <= 0
        ? null
        : Number((BigInt(committedCents) * 10_000n) / BigInt(capCents)),
    finalClosingDate,
    daysToFinalClosing:
      finalClosingDate === null
        ? null
        : diffInDays(input.today, finalClosingDate),
    initialInstallmentBps: preferredClass?.initialInstallmentBps ?? 0,
    pendingCount: input.pending.count,
    pendingCommittedCents: input.pending.committedCents,
    overdueDecisions: input.pending.overdueDecisions,
    refundsOutstandingCount: input.refunds.count,
    refundsOutstandingCents: input.refunds.outstandingCents,
  };

  return {
    asOf: input.asOf,
    companyName: input.companyName,
    common,
    preferred,
    indicators,
    managerNotice: commonRows.map(({ member }) => ({
      name: member.name,
      address: member.noticeAddress,
      email: member.noticeEmail,
    })),
  };
}
