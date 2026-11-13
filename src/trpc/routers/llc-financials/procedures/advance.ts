import { fromDateOnly, toDateOnly } from "@/lib/date-only";
import { formatCents } from "@/lib/money";
import {
  assertNotFuture,
  financialsAudit,
  getTaxAdvancesOutstanding,
} from "@/server/llc/economics/financials";
import { lockCompanyLedger, ruleViolation } from "@/server/llc/economics/scope";
import {
  assertBooksOpen,
  getEconomicsContext,
} from "@/server/llc/economics/term";
import { toWire } from "@/server/llc/economics/wire";
import { assertCompanyOwns } from "@/server/tenant-ownership";
import { createTRPCRouter, withLlcAccessControl } from "@/trpc/api/trpc";
import { ZAdvanceCreateSchema, ZAdvanceRepaymentSchema } from "../schema";

export const advanceRouter = createTRPCRouter({
  list: withLlcAccessControl
    .meta({ policies: { "llc-financials": { allow: ["read"] } } })
    .query(async ({ ctx }) => {
      const companyId = ctx.membership.companyId;
      const advances = await ctx.db.memberAdvance.findMany({
        where: { companyId },
        orderBy: [{ paidOn: "asc" }, { createdAt: "asc" }],
      });
      const recoveries = await ctx.db.memberAdvanceRecovery.findMany({
        where: { companyId },
        orderBy: [{ recoveredOn: "asc" }, { createdAt: "asc" }],
      });
      const outstanding = await getTaxAdvancesOutstanding(ctx.db, companyId);
      const names = new Map(
        (
          await ctx.db.stakeholder.findMany({
            where: { companyId, id: { in: [...outstanding.keys()] } },
            select: { id: true, name: true },
          })
        ).map((s) => [s.id, s.name]),
      );
      return toWire({
        advances: advances.map((a) => ({
          ...a,
          paidOn: toDateOnly(a.paidOn),
        })),
        recoveries: recoveries.map((r) => ({
          ...r,
          recoveredOn: toDateOnly(r.recoveredOn),
        })),
        outstanding: [...outstanding].map(([stakeholderId, amount]) => ({
          stakeholderId,
          name: names.get(stakeholderId) ?? null,
          amount,
        })),
      });
    }),

  create: withLlcAccessControl
    .meta({ policies: { "llc-financials": { allow: ["create"] } } })
    .input(ZAdvanceCreateSchema)
    .mutation(({ ctx, input }) => {
      const companyId = ctx.membership.companyId;
      return ctx.db.$transaction(async (tx) => {
        await lockCompanyLedger(tx, companyId);
        const { term, today } = await getEconomicsContext(tx, ctx.company);
        assertNotFuture(input.paidOn, today);
        assertBooksOpen(term, input.paidOn);
        await assertCompanyOwns(tx, companyId, {
          stakeholderIds: [input.stakeholderId],
          documentIds: [input.documentId],
        });
        const amount = BigInt(input.amountCents);
        const row = await tx.memberAdvance.create({
          data: {
            companyId,
            stakeholderId: input.stakeholderId,
            paidOn: fromDateOnly(input.paidOn),
            kind: input.kind,
            amountCents: amount,
            jurisdiction: input.jurisdiction ?? null,
            taxYear: input.taxYear ?? null,
            memo: input.memo,
            documentId: input.documentId ?? null,
            createdById: ctx.membership.memberId,
          },
        });
        await financialsAudit(
          tx,
          ctx,
          companyId,
          "memberAdvance.created",
          { type: "memberAdvance", id: row.id },
          `Recorded a ${input.kind} tax advance of ${formatCents(amount)} paid on ${input.paidOn} (Section 9.2).`,
        );
        return toWire({ id: row.id });
      });
    }),

  recordRepayment: withLlcAccessControl
    .meta({ policies: { "llc-financials": { allow: ["create"] } } })
    .input(ZAdvanceRepaymentSchema)
    .mutation(({ ctx, input }) => {
      const companyId = ctx.membership.companyId;
      return ctx.db.$transaction(async (tx) => {
        await lockCompanyLedger(tx, companyId);
        const { term, today } = await getEconomicsContext(tx, ctx.company);
        assertNotFuture(input.recoveredOn, today);
        assertBooksOpen(term, input.recoveredOn);
        await assertCompanyOwns(tx, companyId, {
          stakeholderIds: [input.stakeholderId],
        });
        const amount = BigInt(input.amountCents);
        const outstanding =
          (await getTaxAdvancesOutstanding(tx, companyId)).get(
            input.stakeholderId,
          ) ?? 0n;
        if (amount > outstanding) {
          ruleViolation(
            `Only ${formatCents(outstanding > 0n ? outstanding : 0n)} of tax advances is outstanding for this member.`,
          );
        }
        const row = await tx.memberAdvanceRecovery.create({
          data: {
            companyId,
            stakeholderId: input.stakeholderId,
            recoveredOn: fromDateOnly(input.recoveredOn),
            amountCents: amount,
            source: "CASH_REPAYMENT",
            createdById: ctx.membership.memberId,
          },
        });
        await financialsAudit(
          tx,
          ctx,
          companyId,
          "memberAdvance.repaid",
          { type: "memberAdvance", id: row.id },
          `Recorded a cash repayment of ${formatCents(amount)} of tax advances on ${input.recoveredOn}.`,
        );
        return toWire({ id: row.id });
      });
    }),
});
