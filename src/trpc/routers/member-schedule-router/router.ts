import { TRPCError } from "@trpc/server";
import { z } from "zod";
import type { MemberScheduleDTO } from "@/lib/admission/member-schedule";
import { todayInTimeZone, ZDateOnly } from "@/lib/date-only";
import { centsToNumber } from "@/lib/money";
import { loadMemberSchedule } from "@/server/llc/member-schedule";
import { getClassTotals } from "@/server/llc/positions";
import { createTRPCRouter, withLlcAccessControl } from "@/trpc/api/trpc";

export const ZodGetMemberScheduleSchema = z.object({
  asOf: ZDateOnly.optional(),
});

export type MemberScheduleOverview = {
  indicators: MemberScheduleDTO["indicators"];
  paidCents: number;
  outstandingBalanceCents: number;
  memberCount: number;
  prospectCount: number;
  preferredUnits: string;
};

export const memberScheduleRouter = createTRPCRouter({
  get: withLlcAccessControl
    .meta({ policies: { stakeholder: { allow: ["read"] } } })
    .input(ZodGetMemberScheduleSchema)
    .query(({ ctx, input }): Promise<MemberScheduleDTO> => {
      const today = todayInTimeZone(ctx.company.timezone);
      if (input.asOf !== undefined && input.asOf > today) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "The as-of date cannot be after today.",
        });
      }
      return loadMemberSchedule(ctx.db, ctx.company, { asOf: input.asOf });
    }),

  overview: withLlcAccessControl
    .meta({ policies: { stakeholder: { allow: ["read"] } } })
    .query(async ({ ctx }): Promise<MemberScheduleOverview> => {
      const companyId = ctx.membership.companyId;
      const [schedule, preferredClass, memberCount, prospectCount] =
        await Promise.all([
          loadMemberSchedule(ctx.db, ctx.company),
          ctx.db.unitClass.findFirst({
            where: { companyId, kind: "PREFERRED" },
            select: { id: true },
          }),
          ctx.db.stakeholder.count({
            where: { companyId, memberStatus: "MEMBER" },
          }),
          ctx.db.stakeholder.count({
            where: { companyId, memberStatus: "PROSPECT" },
          }),
        ]);
      const totals = preferredClass
        ? await getClassTotals(ctx.db, companyId, preferredClass.id)
        : null;
      return {
        indicators: schedule.indicators,
        paidCents: totals ? centsToNumber(totals.capitalCents) : 0,
        outstandingBalanceCents: totals
          ? centsToNumber(totals.outstandingBalanceCents)
          : 0,
        memberCount,
        prospectCount,
        preferredUnits: totals ? totals.units : "0.000000",
      };
    }),
});
