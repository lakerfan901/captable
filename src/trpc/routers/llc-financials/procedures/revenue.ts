import { formatDateOnly, fromDateOnly, toDateOnly } from "@/lib/date-only";
import { compareIso } from "@/lib/llc/dates";
import { managementFeeForMonth } from "@/lib/llc/management-fee";
import { formatCents } from "@/lib/money";
import { financialsAudit } from "@/server/llc/economics/financials";
import {
  firstOfMonth,
  lastOfMonth,
  revenueYearRows,
} from "@/server/llc/economics/financials.logic";
import { lockCompanyLedger, ruleViolation } from "@/server/llc/economics/scope";
import {
  assertBooksOpen,
  getEconomicsContext,
  getOrCreateLlcTerm,
} from "@/server/llc/economics/term";
import { toWire } from "@/server/llc/economics/wire";
import { createTRPCRouter, withLlcAccessControl } from "@/trpc/api/trpc";
import { ZRevenueListSchema, ZRevenueSaveSchema } from "../schema";

export const revenueRouter = createTRPCRouter({
  list: withLlcAccessControl
    .meta({ policies: { "llc-financials": { allow: ["read"] } } })
    .input(ZRevenueListSchema)
    .query(async ({ ctx, input }) => {
      const companyId = ctx.membership.companyId;
      const term = await getOrCreateLlcTerm(ctx.db, companyId);
      const rows = await ctx.db.revenuePeriod.findMany({
        where: {
          companyId,
          month: {
            gte: fromDateOnly(`${input.year}-01-01`),
            lte: fromDateOnly(`${input.year}-12-01`),
          },
        },
        orderBy: { month: "asc" },
      });
      return toWire({
        year: input.year,
        rows: revenueYearRows(
          input.year,
          rows.map((r) => ({
            month: toDateOnly(r.month),
            customerReceiptsCents: r.customerReceiptsCents,
            passThroughFeesCents: r.passThroughFeesCents,
            otherIncomeCents: r.otherIncomeCents,
            assetSaleProceedsCents: r.assetSaleProceedsCents,
            insuranceProceedsCents: r.insuranceProceedsCents,
            managementFeeCents: r.managementFeeCents,
            managementFeeBps: r.managementFeeBps,
            utilizationBps: r.utilizationBps,
            notes: r.notes,
          })),
          term.booksClosedThrough === null
            ? null
            : toDateOnly(term.booksClosedThrough),
        ),
      });
    }),

  save: withLlcAccessControl
    .meta({ policies: { "llc-financials": { allow: ["create"] } } })
    .input(ZRevenueSaveSchema)
    .mutation(({ ctx, input }) => {
      const companyId = ctx.membership.companyId;
      return ctx.db.$transaction(async (tx) => {
        await lockCompanyLedger(tx, companyId);
        const { term, today } = await getEconomicsContext(tx, ctx.company);
        if (compareIso(input.month, firstOfMonth(today)) > 0) {
          ruleViolation(
            `${formatDateOnly(input.month)} is a future month. Enter revenue once the month has started.`,
          );
        }
        assertBooksOpen(term, lastOfMonth(input.month));

        const customerReceiptsCents = BigInt(input.customerReceiptsCents);
        const passThroughFeesCents = BigInt(input.passThroughFeesCents);
        const gross = customerReceiptsCents - passThroughFeesCents;
        const managementFeeBps = term.managementFeeBps;
        const managementFeeCents = managementFeeForMonth(
          gross,
          managementFeeBps,
        );
        const data = {
          customerReceiptsCents,
          passThroughFeesCents,
          otherIncomeCents: BigInt(input.otherIncomeCents),
          assetSaleProceedsCents: BigInt(input.assetSaleProceedsCents),
          insuranceProceedsCents: BigInt(input.insuranceProceedsCents),
          utilizationBps: input.utilizationBps,
          notes: input.notes,
          managementFeeBps,
          managementFeeCents,
          updatedById: ctx.membership.memberId,
        };
        const month = fromDateOnly(input.month);
        const row = await tx.revenuePeriod.upsert({
          where: { companyId_month: { companyId, month } },
          create: { companyId, month, ...data },
          update: data,
        });
        await financialsAudit(
          tx,
          ctx,
          companyId,
          "revenuePeriod.saved",
          { type: "revenuePeriod", id: row.id },
          `Saved revenue for ${input.month.slice(0, 7)}: gross revenue ${formatCents(gross)}, management fee ${formatCents(managementFeeCents)}.`,
        );
        return toWire({
          id: row.id,
          month: input.month,
          grossRevenue: gross,
          managementFeeCents,
        });
      });
    }),
});
