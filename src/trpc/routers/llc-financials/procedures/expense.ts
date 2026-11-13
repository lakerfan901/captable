import { fromDateOnly, toDateOnly } from "@/lib/date-only";
import { formatCents } from "@/lib/money";
import {
  financialsAudit,
  insertExpense,
  insertExpenseReversal,
} from "@/server/llc/economics/financials";
import {
  lockCompanyLedger,
  notFound,
  ruleViolation,
} from "@/server/llc/economics/scope";
import {
  assertBooksOpen,
  getEconomicsContext,
} from "@/server/llc/economics/term";
import { toWire } from "@/server/llc/economics/wire";
import { assertCompanyOwns } from "@/server/tenant-ownership";
import { createTRPCRouter, withLlcAccessControl } from "@/trpc/api/trpc";
import {
  ZDateRangeSchema,
  ZExpenseCreateSchema,
  ZReverseSchema,
} from "../schema";

export const expenseRouter = createTRPCRouter({
  list: withLlcAccessControl
    .meta({ policies: { "llc-financials": { allow: ["read"] } } })
    .input(ZDateRangeSchema)
    .query(async ({ ctx, input }) => {
      const companyId = ctx.membership.companyId;
      const rows = await ctx.db.expenseEntry.findMany({
        where: {
          companyId,
          incurredOn: {
            gte: fromDateOnly(input.from),
            lte: fromDateOnly(input.to),
          },
        },
        orderBy: [{ incurredOn: "asc" }, { createdAt: "asc" }],
      });
      const reversed = new Set(
        (
          await ctx.db.expenseEntry.findMany({
            where: {
              companyId,
              reversesEntryId: { in: rows.map((r) => r.id) },
            },
            select: { reversesEntryId: true },
          })
        ).map((r) => r.reversesEntryId),
      );
      const byCategory = new Map<string, bigint>();
      const byFundingSource = new Map<string, bigint>();
      let total = 0n;
      for (const r of rows) {
        total += r.amountCents;
        byCategory.set(
          r.category,
          (byCategory.get(r.category) ?? 0n) + r.amountCents,
        );
        byFundingSource.set(
          r.fundingSource,
          (byFundingSource.get(r.fundingSource) ?? 0n) + r.amountCents,
        );
      }
      return toWire({
        rows: rows.map((r) => ({
          ...r,
          incurredOn: toDateOnly(r.incurredOn),
          isReversal: r.reversesEntryId !== null,
          reversed: reversed.has(r.id),
        })),
        totals: { total, byCategory, byFundingSource },
      });
    }),

  create: withLlcAccessControl
    .meta({ policies: { "llc-financials": { allow: ["create"] } } })
    .input(ZExpenseCreateSchema)
    .mutation(({ ctx, input }) => {
      const companyId = ctx.membership.companyId;
      return ctx.db.$transaction(async (tx) => {
        await lockCompanyLedger(tx, companyId);
        const { term, today } = await getEconomicsContext(tx, ctx.company);
        await assertCompanyOwns(tx, companyId, {
          documentIds: [input.documentId],
        });
        const row = await insertExpense(tx, {
          companyId,
          term,
          today,
          createdById: ctx.membership.memberId,
          expense: {
            incurredOn: input.incurredOn,
            category: input.category,
            payee: input.payee,
            amountCents: BigInt(input.amountCents),
            fundingSource: input.fundingSource,
            countsTowardOrgCap: input.countsTowardOrgCap,
            memo: input.memo,
            documentId: input.documentId ?? null,
            resolutionId: input.resolutionId ?? null,
            managerPaymentId: null,
          },
        });
        await financialsAudit(
          tx,
          ctx,
          companyId,
          "expense.created",
          { type: "expense", id: row.id },
          `Recorded an expense of ${formatCents(row.amountCents)} to ${row.payee} (${row.category}) on ${input.incurredOn}.`,
        );
        return toWire({ id: row.id });
      });
    }),

  reverse: withLlcAccessControl
    .meta({ policies: { "llc-financials": { allow: ["delete"] } } })
    .input(ZReverseSchema)
    .mutation(({ ctx, input }) => {
      const companyId = ctx.membership.companyId;
      return ctx.db.$transaction(async (tx) => {
        await lockCompanyLedger(tx, companyId);
        const { term, today } = await getEconomicsContext(tx, ctx.company);
        assertBooksOpen(term, today);
        const original = await tx.expenseEntry.findFirst({
          where: { id: input.id, companyId },
        });
        if (!original) notFound("Expense");
        if (original.managerPaymentId !== null) {
          ruleViolation(
            "This expense was recorded with a Manager payment. Reverse the Manager payment instead.",
          );
        }
        const row = await insertExpenseReversal(tx, {
          companyId,
          original,
          today,
          createdById: ctx.membership.memberId,
          reason: input.reason,
          managerPaymentId: null,
        });
        await financialsAudit(
          tx,
          ctx,
          companyId,
          "expense.reversed",
          { type: "expense", id: original.id },
          `Reversed the expense of ${formatCents(original.amountCents)} to ${original.payee}: ${input.reason}`,
        );
        return toWire({ id: row.id });
      });
    }),
});
