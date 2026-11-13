import { fromDateOnly } from "@/lib/date-only";
import {
  computeAvailableCash,
  reserveBalances,
} from "@/lib/llc/available-cash";
import { compareIso } from "@/lib/llc/dates";
import { formatCents } from "@/lib/money";
import { economicsToday } from "@/server/llc/economics/clock";
import {
  assertNotFuture,
  assertUnusedCapitalCovers,
  financialsAudit,
  loadCashLedger,
  loadReserveRows,
} from "@/server/llc/economics/financials";
import {
  type ReserveRow,
  reserveLedgerError,
  toReserveEntries,
} from "@/server/llc/economics/financials.logic";
import {
  lockCompanyLedger,
  notFound,
  ruleViolation,
} from "@/server/llc/economics/scope";
import {
  assertBooksOpen,
  getEconomicsContext,
  getOrCreateLlcTerm,
} from "@/server/llc/economics/term";
import { toWire } from "@/server/llc/economics/wire";
import { createTRPCRouter, withLlcAccessControl } from "@/trpc/api/trpc";
import {
  ZAsOfSchema,
  ZReserveEstablishSchema,
  ZReserveReleaseSchema,
  ZReverseSchema,
} from "../schema";

function assertLedgerValid(rows: readonly ReserveRow[]): void {
  const error = reserveLedgerError(rows);
  if (error !== null) {
    ruleViolation(
      `A reserve balance would go below zero (Section 5.6(a)): ${error}`,
    );
  }
}

export const reserveRouter = createTRPCRouter({
  list: withLlcAccessControl
    .meta({ policies: { "llc-financials": { allow: ["read"] } } })
    .input(ZAsOfSchema)
    .query(async ({ ctx, input }) => {
      const companyId = ctx.membership.companyId;
      const asOf = input.asOf ?? economicsToday(ctx.company.timezone);
      const rows = await loadReserveRows(ctx.db, companyId);
      const reversed = new Set(rows.map((r) => r.reversesEntryId));
      return toWire({
        asOf,
        rows: rows
          .filter((r) => compareIso(r.effectiveOn, asOf) <= 0)
          .map((r) => ({
            ...r,
            isReversal: r.reversesEntryId !== null,
            reversed: reversed.has(r.id),
          })),
      });
    }),

  balances: withLlcAccessControl
    .meta({ policies: { "llc-financials": { allow: ["read"] } } })
    .input(ZAsOfSchema)
    .query(async ({ ctx, input }) => {
      const companyId = ctx.membership.companyId;
      const asOf = input.asOf ?? economicsToday(ctx.company.timezone);
      const term = await getOrCreateLlcTerm(ctx.db, companyId);
      const rows = await loadReserveRows(ctx.db, companyId);
      const balances = reserveBalances(toReserveEntries(rows), asOf);
      const minimum = balances.byKind.get("MINIMUM_OPERATING")?.total ?? 0n;
      return toWire({
        asOf,
        ...balances,
        minimumRequired: term.minimumOperatingReserveCents,
        minimumMet: minimum >= term.minimumOperatingReserveCents,
      });
    }),

  establish: withLlcAccessControl
    .meta({ policies: { "llc-financials": { allow: ["create"] } } })
    .input(ZReserveEstablishSchema)
    .mutation(({ ctx, input }) => {
      const companyId = ctx.membership.companyId;
      return ctx.db.$transaction(async (tx) => {
        await lockCompanyLedger(tx, companyId);
        const { term, today } = await getEconomicsContext(tx, ctx.company);
        assertNotFuture(input.effectiveOn, today);
        assertBooksOpen(term, input.effectiveOn);
        const amount = BigInt(input.amountCents);
        if (input.fundingSource === "OPERATING_CASH") {
          const ledger = await loadCashLedger(tx, companyId);
          // At the reserve's date and today, like capital-funded spending.
          let raw = computeAvailableCash(ledger, input.effectiveOn).raw;
          const rawToday = computeAvailableCash(ledger, today).raw;
          if (rawToday < raw) raw = rawToday;
          if (amount > raw) {
            ruleViolation(
              `Only ${formatCents(raw > 0n ? raw : 0n)} of Available Cash exists on ${input.effectiveOn}; a reserve cannot hold cash that is not there.`,
            );
          }
        } else {
          await assertUnusedCapitalCovers(
            tx,
            companyId,
            amount,
            input.effectiveOn,
            today,
          );
        }
        const candidate: ReserveRow = {
          effectiveOn: input.effectiveOn,
          kind: input.kind,
          type: "ESTABLISH",
          amountCents: amount,
          fundingSource: input.fundingSource,
          releaseTo: null,
        };
        assertLedgerValid([
          ...(await loadReserveRows(tx, companyId)),
          candidate,
        ]);
        const row = await tx.reserveEntry.create({
          data: {
            companyId,
            effectiveOn: fromDateOnly(input.effectiveOn),
            kind: input.kind,
            type: "ESTABLISH",
            amountCents: amount,
            fundingSource: input.fundingSource,
            reason: input.reason,
            createdById: ctx.membership.memberId,
          },
        });
        await financialsAudit(
          tx,
          ctx,
          companyId,
          "reserve.established",
          { type: "reserve", id: row.id },
          `Established ${formatCents(amount)} in the ${input.kind} reserve from ${input.fundingSource} on ${input.effectiveOn}: ${input.reason}`,
        );
        return toWire({ id: row.id });
      });
    }),

  release: withLlcAccessControl
    .meta({ policies: { "llc-financials": { allow: ["create"] } } })
    .input(ZReserveReleaseSchema)
    .mutation(({ ctx, input }) => {
      const companyId = ctx.membership.companyId;
      return ctx.db.$transaction(async (tx) => {
        await lockCompanyLedger(tx, companyId);
        const { term, today } = await getEconomicsContext(tx, ctx.company);
        assertNotFuture(input.effectiveOn, today);
        assertBooksOpen(term, input.effectiveOn);
        const amount = BigInt(input.amountCents);
        const releaseTo = input.releaseTo ?? input.fundingSource;
        const rows = await loadReserveRows(tx, companyId);
        const before = reserveBalances(
          toReserveEntries(rows),
          input.effectiveOn,
        ).byKind.get(input.kind) ?? { operating: 0n, capital: 0n, total: 0n };
        const pool =
          input.fundingSource === "OPERATING_CASH"
            ? before.operating
            : before.capital;
        if (amount > pool) {
          ruleViolation(
            `The ${input.kind} reserve holds ${formatCents(pool)} funded from ${input.fundingSource} on ${input.effectiveOn}.`,
          );
        }
        if (
          input.kind === "MINIMUM_OPERATING" &&
          !input.allowBelowMinimum &&
          before.total - amount < term.minimumOperatingReserveCents
        ) {
          ruleViolation(
            `The minimum operating reserve may not fall below ${formatCents(term.minimumOperatingReserveCents)} (Section 5.6(a)) except for winding up.`,
          );
        }
        assertLedgerValid([
          ...rows,
          {
            effectiveOn: input.effectiveOn,
            kind: input.kind,
            type: "RELEASE",
            amountCents: amount,
            fundingSource: input.fundingSource,
            releaseTo,
          },
        ]);
        const row = await tx.reserveEntry.create({
          data: {
            companyId,
            effectiveOn: fromDateOnly(input.effectiveOn),
            kind: input.kind,
            type: "RELEASE",
            amountCents: amount,
            fundingSource: input.fundingSource,
            releaseTo,
            reason: input.reason,
            createdById: ctx.membership.memberId,
          },
        });
        await financialsAudit(
          tx,
          ctx,
          companyId,
          "reserve.released",
          { type: "reserve", id: row.id },
          `Released ${formatCents(amount)} from the ${input.kind} reserve (${input.fundingSource} → ${releaseTo}) on ${input.effectiveOn}: ${input.reason}`,
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
        const original = await tx.reserveEntry.findFirst({
          where: { id: input.id, companyId },
        });
        if (!original) notFound("Reserve entry");
        const already = await tx.reserveEntry.findFirst({
          where: { companyId, reversesEntryId: original.id },
          select: { id: true },
        });
        if (
          already ||
          original.reversesEntryId !== null ||
          original.amountCents < 0n
        ) {
          ruleViolation("This reserve entry has already been reversed.");
        }
        if (
          original.type === "RELEASE" &&
          original.releaseTo !== null &&
          original.releaseTo !== original.fundingSource
        ) {
          ruleViolation(
            "A release into the other pool cannot be reversed. Establish the reserve again from the pool that received the cash.",
          );
        }
        assertLedgerValid([
          ...(await loadReserveRows(tx, companyId)),
          {
            effectiveOn: today,
            kind: original.kind,
            type: original.type,
            amountCents: -original.amountCents,
            fundingSource: original.fundingSource,
            releaseTo: original.releaseTo,
          },
        ]);
        const row = await tx.reserveEntry.create({
          data: {
            companyId,
            effectiveOn: fromDateOnly(today),
            kind: original.kind,
            type: original.type,
            amountCents: -original.amountCents,
            fundingSource: original.fundingSource,
            releaseTo: original.releaseTo,
            reason: input.reason,
            reversesEntryId: original.id,
            createdById: ctx.membership.memberId,
          },
        });
        await financialsAudit(
          tx,
          ctx,
          companyId,
          "reserve.reversed",
          { type: "reserve", id: original.id },
          `Reversed the ${original.type} of ${formatCents(original.amountCents)} in the ${original.kind} reserve: ${input.reason}`,
        );
        return toWire({ id: row.id });
      });
    }),
});
