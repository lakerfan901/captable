import {
  buildMemberSchedule,
  type MemberScheduleDTO,
} from "@/lib/admission/member-schedule";
import { todayInTimeZone } from "@/lib/date-only";
import { centsToNumber } from "@/lib/money";
import type { TPrismaOrTransaction } from "@/server/db";
import { getMemberPositions } from "@/server/llc/positions";
import { dateToWire } from "@/server/llc/serialize";

export type { MemberScheduleDTO };

/** `[streetAddress, city, [state, zipcode].join(" ")]`, non-empty parts. */
export function noticeAddressOf(s: {
  streetAddress: string | null;
  city: string | null;
  state: string | null;
  zipcode: string | null;
}): string {
  const stateZip = [s.state, s.zipcode]
    .map((p) => p?.trim() ?? "")
    .filter((p) => p !== "")
    .join(" ");
  return [s.streetAddress?.trim() ?? "", s.city?.trim() ?? "", stateZip]
    .filter((p) => p !== "")
    .join(", ");
}

/**
 * Live Exhibit A for a company as of `opts.asOf` (default: today in the
 * company's time zone). Holdings come from `getMemberPositions` only.
 */
export async function loadMemberSchedule(
  db: TPrismaOrTransaction,
  company: { id: string; name: string; timezone: string },
  opts?: { asOf?: string },
): Promise<MemberScheduleDTO> {
  const companyId = company.id;
  const today = todayInTimeZone(company.timezone);
  const asOf = opts?.asOf ?? today;

  const [classes, stakeholders, positions, pending, decided] =
    await Promise.all([
      db.unitClass.findMany({
        where: { companyId },
        select: {
          id: true,
          kind: true,
          name: true,
          offeringCapCents: true,
          finalClosingDate: true,
          initialInstallmentBps: true,
          pricePerUnitCents: true,
        },
      }),
      db.stakeholder.findMany({
        where: { companyId },
        select: {
          id: true,
          name: true,
          email: true,
          noticeEmail: true,
          memberStatus: true,
          isInsider: true,
          admittedOn: true,
          streetAddress: true,
          city: true,
          state: true,
          zipcode: true,
        },
      }),
      getMemberPositions(db, companyId, { asOf }),
      db.commitment.findMany({
        where: { companyId, status: "PENDING" },
        select: {
          committedCents: true,
          acceptanceDeadline: true,
          unitClass: { select: { finalClosingDate: true } },
        },
      }),
      db.commitment.findMany({
        where: {
          companyId,
          status: { not: "PENDING" },
          refundDueCents: { gt: 0 },
        },
        select: { refundDueCents: true, refundPaidCents: true },
      }),
    ]);

  let pendingCommitted = 0n;
  let overdueDecisions = 0;
  for (const c of pending) {
    pendingCommitted += c.committedCents;
    const acceptance = dateToWire(c.acceptanceDeadline);
    const closing = dateToWire(c.unitClass.finalClosingDate);
    const deadline =
      acceptance === null
        ? closing
        : closing !== null && closing < acceptance
          ? closing
          : acceptance;
    if (deadline !== null && deadline < today) overdueDecisions += 1;
  }

  let refundCount = 0;
  let refundOutstanding = 0n;
  for (const c of decided) {
    const open = c.refundDueCents - c.refundPaidCents;
    if (open > 0n) {
      refundCount += 1;
      refundOutstanding += open;
    }
  }

  return buildMemberSchedule({
    asOf,
    today,
    companyName: company.name,
    classes: classes.map((c) => ({
      id: c.id,
      kind: c.kind,
      name: c.name,
      offeringCapCents:
        c.offeringCapCents === null ? null : centsToNumber(c.offeringCapCents),
      finalClosingDate: dateToWire(c.finalClosingDate),
      initialInstallmentBps: c.initialInstallmentBps,
      pricePerUnitCents:
        c.pricePerUnitCents === null
          ? null
          : centsToNumber(c.pricePerUnitCents),
    })),
    members: stakeholders.map((s) => ({
      id: s.id,
      name: s.name,
      memberStatus: s.memberStatus,
      isInsider: s.isInsider,
      admittedOn: dateToWire(s.admittedOn),
      noticeAddress: noticeAddressOf(s),
      noticeEmail: s.noticeEmail ?? s.email,
    })),
    positions: positions.map((p) => ({
      stakeholderId: p.stakeholderId,
      unitClassId: p.unitClassId,
      committedCents: centsToNumber(p.committedCents),
      pendingCommittedCents: centsToNumber(p.pendingCommittedCents),
      capitalCents: centsToNumber(p.capitalCents),
      units: p.units,
    })),
    pending: {
      count: pending.length,
      committedCents: centsToNumber(pendingCommitted),
      overdueDecisions,
    },
    refunds: {
      count: refundCount,
      outstandingCents: centsToNumber(refundOutstanding),
    },
  });
}
