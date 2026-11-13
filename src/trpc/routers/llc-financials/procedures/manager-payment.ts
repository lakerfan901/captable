import { fromDateOnly, toDateOnly } from "@/lib/date-only";
import { formatCents } from "@/lib/money";
import {
  assertNotFuture,
  assertOrgCapAllows,
  financialsAudit,
  getOrgCapStatus,
  insertExpense,
  insertExpenseReversal,
} from "@/server/llc/economics/financials";
import { unpaidFeeThrough } from "@/server/llc/economics/financials.logic";
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
  ZManagerPaymentCreateSchema,
  ZReverseSchema,
} from "../schema";

export const managerPaymentRouter = createTRPCRouter({
  list: withLlcAccessControl
    .meta({ policies: { "llc-financials": { allow: ["read"] } } })
    .input(ZDateRangeSchema)
    .query(async ({ ctx, input }) => {
      const companyId = ctx.membership.companyId;
      const rows = await ctx.db.managerPayment.findMany({
        where: {
          companyId,
          paidOn: {
            gte: fromDateOnly(input.from),
            lte: fromDateOnly(input.to),
          },
        },
        orderBy: [{ paidOn: "asc" }, { createdAt: "asc" }],
      });
      const ids = rows.map((r) => r.id);
      const reversed = new Set(
        (
          await ctx.db.managerPayment.findMany({
            where: { companyId, reversesPaymentId: { in: ids } },
            select: { reversesPaymentId: true },
          })
        ).map((r) => r.reversesPaymentId),
      );
      const linked = new Map(
        (
          await ctx.db.expenseEntry.findMany({
            where: { companyId, managerPaymentId: { in: ids } },
            select: { id: true, managerPaymentId: true, category: true },
          })
        ).map((e) => [e.managerPaymentId, e]),
      );
      const byCategory = new Map<string, bigint>();
      let total = 0n;
      for (const r of rows) {
        total += r.amountCents;
        byCategory.set(
          r.category,
          (byCategory.get(r.category) ?? 0n) + r.amountCents,
        );
      }
      return toWire({
        rows: rows.map((r) => ({
          ...r,
          paidOn: toDateOnly(r.paidOn),
          isReversal: r.reversesPaymentId !== null,
          reversed: reversed.has(r.id),
          expense: linked.get(r.id) ?? null,
        })),
        totals: { total, byCategory },
      });
    }),

  create: withLlcAccessControl
    .meta({ policies: { "llc-financials": { allow: ["create"] } } })
    .input(ZManagerPaymentCreateSchema)
    .mutation(({ ctx, input }) => {
      const companyId = ctx.membership.companyId;
      return ctx.db.$transaction(async (tx) => {
        await lockCompanyLedger(tx, companyId);
        const { term, today } = await getEconomicsContext(tx, ctx.company);
        assertNotFuture(input.paidOn, today);
        assertBooksOpen(term, input.paidOn);
        await assertCompanyOwns(tx, companyId, {
          stakeholderIds: [input.payeeStakeholderId],
          documentIds: [input.documentId],
        });
        const amount = BigInt(input.amountCents);
        const resolutionId = input.resolutionId ?? null;
        let countsTowardOrgCap = false;

        switch (input.category) {
          case "MANAGEMENT_FEE": {
            if (input.expense !== null || input.countsTowardOrgCap) {
              ruleViolation(
                "A Management Fee payment is not an expense and does not count toward the Section 6.21 cap.",
              );
            }
            const months = await tx.revenuePeriod.findMany({
              where: { companyId },
              select: { month: true, managementFeeCents: true },
            });
            const paid = await tx.managerPayment.findMany({
              where: { companyId, category: "MANAGEMENT_FEE" },
              select: { amountCents: true },
            });
            const unpaid = unpaidFeeThrough(
              months.map((m) => ({
                month: toDateOnly(m.month),
                managementFeeCents: m.managementFeeCents,
              })),
              paid,
              input.paidOn,
            );
            if (amount > unpaid) {
              ruleViolation(
                `Only ${formatCents(unpaid > 0n ? unpaid : 0n)} of Management Fee has accrued unpaid through the last complete month. The fee is accrued monthly and paid quarterly (Section 6.18); it cannot be paid ahead of accrual.`,
              );
            }
            break;
          }
          case "EXPENSE_REIMBURSEMENT":
          case "PURCHASING_AGENT_PASS_THROUGH":
            if (input.expense === null) {
              ruleViolation(
                "Classify the expense this payment covers, so the cost is counted exactly once.",
              );
            }
            break;
          case "OTHER":
            if (input.expense === null && input.countsTowardOrgCap) {
              await assertOrgCapAllows(tx, companyId, amount, resolutionId);
              countsTowardOrgCap = true;
            }
            break;
        }

        const payment = await tx.managerPayment.create({
          data: {
            companyId,
            paidOn: fromDateOnly(input.paidOn),
            payee: input.payee,
            payeeStakeholderId: input.payeeStakeholderId ?? null,
            amountCents: amount,
            category: input.category,
            countsTowardOrgCap,
            memo: input.memo,
            documentId: input.documentId ?? null,
            resolutionId,
            createdById: ctx.membership.memberId,
          },
        });
        let expenseId: string | null = null;
        if (input.expense !== null) {
          const expense = await insertExpense(tx, {
            companyId,
            term,
            today,
            createdById: ctx.membership.memberId,
            expense: {
              incurredOn: input.paidOn,
              category: input.expense.category,
              payee: input.payee,
              amountCents: amount,
              fundingSource: input.expense.fundingSource,
              countsTowardOrgCap: input.expense.countsTowardOrgCap,
              memo: input.memo,
              documentId: input.documentId ?? null,
              resolutionId,
              managerPaymentId: payment.id,
            },
          });
          expenseId = expense.id;
        }
        await financialsAudit(
          tx,
          ctx,
          companyId,
          "managerPayment.created",
          { type: "managerPayment", id: payment.id },
          `Recorded a ${input.category} payment of ${formatCents(amount)} to ${input.payee} on ${input.paidOn}.`,
        );
        return toWire({ id: payment.id, expenseId });
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
        const original = await tx.managerPayment.findFirst({
          where: { id: input.id, companyId },
        });
        if (!original) notFound("Manager payment");
        const already = await tx.managerPayment.findFirst({
          where: { companyId, reversesPaymentId: original.id },
          select: { id: true },
        });
        if (
          already ||
          original.reversesPaymentId !== null ||
          original.amountCents < 0n
        ) {
          ruleViolation("This payment has already been reversed.");
        }
        const reversal = await tx.managerPayment.create({
          data: {
            companyId,
            paidOn: fromDateOnly(today),
            payee: original.payee,
            payeeStakeholderId: original.payeeStakeholderId,
            amountCents: -original.amountCents,
            category: original.category,
            countsTowardOrgCap: original.countsTowardOrgCap,
            memo: `Reversal: ${input.reason}`,
            documentId: original.documentId,
            resolutionId: original.resolutionId,
            reversesPaymentId: original.id,
            createdById: ctx.membership.memberId,
          },
        });
        const linked = await tx.expenseEntry.findFirst({
          where: {
            companyId,
            managerPaymentId: original.id,
            reversesEntryId: null,
          },
        });
        if (linked) {
          await insertExpenseReversal(tx, {
            companyId,
            original: linked,
            today,
            createdById: ctx.membership.memberId,
            reason: input.reason,
            managerPaymentId: reversal.id,
          });
        }
        await financialsAudit(
          tx,
          ctx,
          companyId,
          "managerPayment.reversed",
          { type: "managerPayment", id: original.id },
          `Reversed the ${original.category} payment of ${formatCents(original.amountCents)} to ${original.payee}: ${input.reason}`,
        );
        return toWire({ id: reversal.id });
      });
    }),

  capStatus: withLlcAccessControl
    .meta({ policies: { "llc-financials": { allow: ["read"] } } })
    .query(async ({ ctx }) =>
      toWire(await getOrgCapStatus(ctx.db, ctx.membership.companyId)),
    ),
});
