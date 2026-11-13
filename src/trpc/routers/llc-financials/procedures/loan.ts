import { fromDateOnly, toDateOnly } from "@/lib/date-only";
import { compareIso } from "@/lib/llc/dates";
import { formatCents } from "@/lib/money";
import { economicsToday } from "@/server/llc/economics/clock";
import {
  assertNotFuture,
  financialsAudit,
  getLoanStates,
} from "@/server/llc/economics/financials";
import { loanState } from "@/server/llc/economics/financials.logic";
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
import { ZLoanCreateSchema, ZLoanPaymentSchema } from "../schema";

export const loanRouter = createTRPCRouter({
  list: withLlcAccessControl
    .meta({ policies: { "llc-financials": { allow: ["read"] } } })
    .query(async ({ ctx }) => {
      const companyId = ctx.membership.companyId;
      const today = economicsToday(ctx.company.timezone);
      const loans = await ctx.db.memberLoan.findMany({
        where: { companyId },
        orderBy: [{ madeOn: "asc" }, { createdAt: "asc" }],
        include: { payments: { orderBy: { paidOn: "asc" } } },
      });
      const names = new Map(
        (
          await ctx.db.stakeholder.findMany({
            where: {
              companyId,
              id: { in: loans.map((l) => l.lenderStakeholderId) },
            },
            select: { id: true, name: true },
          })
        ).map((s) => [s.id, s.name]),
      );
      const states = new Map(
        (await getLoanStates(ctx.db, companyId, today)).map((s) => [
          s.loanId,
          s,
        ]),
      );
      return toWire({
        asOf: today,
        loans: loans.map((l) => ({
          ...l,
          lenderName: names.get(l.lenderStakeholderId) ?? null,
          madeOn: toDateOnly(l.madeOn),
          maturityOn: toDateOnly(l.maturityOn),
          payments: l.payments.map((p) => ({
            ...p,
            paidOn: toDateOnly(p.paidOn),
          })),
          state: states.get(l.id) ?? null,
        })),
      });
    }),

  create: withLlcAccessControl
    .meta({ policies: { "llc-financials": { allow: ["create"] } } })
    .input(ZLoanCreateSchema)
    .mutation(({ ctx, input }) => {
      const companyId = ctx.membership.companyId;
      return ctx.db.$transaction(async (tx) => {
        await lockCompanyLedger(tx, companyId);
        const { term, today } = await getEconomicsContext(tx, ctx.company);
        assertNotFuture(input.madeOn, today);
        assertBooksOpen(term, input.madeOn);
        await assertCompanyOwns(tx, companyId, {
          stakeholderIds: [input.lenderStakeholderId],
          documentIds: [input.noteDocumentId],
        });
        const principal = BigInt(input.principalCents);
        const row = await tx.memberLoan.create({
          data: {
            companyId,
            lenderStakeholderId: input.lenderStakeholderId,
            principalCents: principal,
            interestBps: input.interestBps,
            madeOn: fromDateOnly(input.madeOn),
            maturityOn: fromDateOnly(input.maturityOn),
            noteDocumentId: input.noteDocumentId,
            resolutionId: input.resolutionId,
            notes: input.notes,
            createdById: ctx.membership.memberId,
          },
        });
        await financialsAudit(
          tx,
          ctx,
          companyId,
          "memberLoan.created",
          { type: "memberLoan", id: row.id },
          `Recorded a member loan of ${formatCents(principal)} at ${input.interestBps} bps made on ${input.madeOn}, maturing ${input.maturityOn} (Section 4.6).`,
        );
        return toWire({ id: row.id });
      });
    }),

  recordPayment: withLlcAccessControl
    .meta({ policies: { "llc-financials": { allow: ["create"] } } })
    .input(ZLoanPaymentSchema)
    .mutation(({ ctx, input }) => {
      const companyId = ctx.membership.companyId;
      return ctx.db.$transaction(async (tx) => {
        await lockCompanyLedger(tx, companyId);
        const { term, today } = await getEconomicsContext(tx, ctx.company);
        assertNotFuture(input.paidOn, today);
        assertBooksOpen(term, input.paidOn);
        const loan = await tx.memberLoan.findFirst({
          where: { id: input.memberLoanId, companyId },
          include: { payments: true },
        });
        if (!loan) notFound("Member loan");
        const madeOn = toDateOnly(loan.madeOn);
        if (compareIso(input.paidOn, madeOn) < 0) {
          ruleViolation("A payment cannot be dated before the loan was made.");
        }
        // Outstanding after every recorded payment (dated any time).
        const state = loanState(
          {
            madeOn,
            maturityOn: toDateOnly(loan.maturityOn),
            principalCents: loan.principalCents,
            interestBps: loan.interestBps,
          },
          loan.payments.map((p) => ({
            paidOn: toDateOnly(p.paidOn),
            principalCents: p.principalCents,
            interestCents: p.interestCents,
          })),
          "9999-12-31",
        );
        const principal = BigInt(input.principalCents);
        const interest = BigInt(input.interestCents);
        if (principal > state.principalOutstanding) {
          ruleViolation(
            `Only ${formatCents(state.principalOutstanding)} of principal is outstanding on this loan.`,
          );
        }
        const row = await tx.memberLoanPayment.create({
          data: {
            companyId,
            memberLoanId: loan.id,
            paidOn: fromDateOnly(input.paidOn),
            principalCents: principal,
            interestCents: interest,
            fundingSource: input.fundingSource,
            createdById: ctx.membership.memberId,
          },
        });
        await financialsAudit(
          tx,
          ctx,
          companyId,
          "memberLoan.payment-recorded",
          { type: "memberLoan", id: loan.id },
          `Recorded a loan payment on ${input.paidOn}: principal ${formatCents(principal)}, interest ${formatCents(interest)} from ${input.fundingSource}.`,
        );
        return toWire({ id: row.id });
      });
    }),
});
