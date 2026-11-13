import type { LlcTerm } from "@prisma/client";
import { fromDateOnly, toDateOnly } from "@/lib/date-only";
import type { IsoDate } from "@/lib/llc/dates";
import { formatCents, numberToCents } from "@/lib/money";
import { Audit } from "@/server/audit";
import type { AuditSchemaType } from "@/server/audit/schema";
import type { TPrismaOrTransaction } from "@/server/db";
import { economicsToday } from "@/server/llc/economics/clock";
import {
  lockCompanyLedger,
  notFound,
  ruleViolation,
} from "@/server/llc/economics/scope";
import {
  assertNoPendingTermExtension,
  countTermExtensions,
  getOrCreateLlcTerm,
  getTermClock,
  isEconomicsLocked,
} from "@/server/llc/economics/term";
import { toWire } from "@/server/llc/economics/wire";
import { assertCompanyOwns } from "@/server/tenant-ownership";
import { createTRPCRouter, withLlcAccessControl } from "@/trpc/api/trpc";
import {
  LOCKED_TERM_FIELDS,
  type TLlcTermUpdate,
  ZLlcTermUpdateSchema,
  ZReopenBooksSchema,
  ZSetLoiExtensionSchema,
  ZSetOperationsCommencementDateSchema,
} from "./schema";

function dateOrNull(d: Date | null): IsoDate | null {
  return d === null ? null : toDateOnly(d);
}

/** All LlcTerm columns, dates as `YYYY-MM-DD` (cents become numbers through `toWire`). */
function toTermDto(term: LlcTerm) {
  return {
    ...term,
    replacementFunderOutsideDate: toDateOnly(term.replacementFunderOutsideDate),
    operationsCommencementDate: dateOrNull(term.operationsCommencementDate),
    ocdNoticeSentOn: dateOrNull(term.ocdNoticeSentOn),
    extraHolidays: term.extraHolidays.map(toDateOnly),
    booksClosedThrough: dateOrNull(term.booksClosedThrough),
  };
}

type AuditCtx = {
  session: { user: { id: string } };
  requestIp: string;
  userAgent: string;
};

function audit(
  tx: TPrismaOrTransaction,
  ctx: AuditCtx,
  companyId: string,
  termId: string,
  action: AuditSchemaType["action"],
  summary: string,
) {
  return Audit.create(
    {
      action,
      companyId,
      actor: { type: "user", id: ctx.session.user.id },
      context: { requestIp: ctx.requestIp, userAgent: ctx.userAgent },
      target: [{ type: "llcTerm", id: termId }],
      summary,
    },
    tx,
  );
}

const CENTS_FIELDS = new Set<keyof TLlcTermUpdate>([
  "minimumOperatingReserveCents",
  "orgExpenseCapCents",
]);

/** Current value of an update field, in the input's representation. */
function currentValue(
  term: LlcTerm,
  key: keyof TLlcTermUpdate,
): string | number | boolean | string[] {
  switch (key) {
    case "replacementFunderOutsideDate":
      return toDateOnly(term.replacementFunderOutsideDate);
    case "extraHolidays":
      return term.extraHolidays.map(toDateOnly);
    case "minimumOperatingReserveCents":
    case "orgExpenseCapCents":
      return Number(term[key]);
    default:
      return term[key];
  }
}

function display(key: keyof TLlcTermUpdate, value: unknown): string {
  if (CENTS_FIELDS.has(key) && typeof value === "number") {
    return formatCents(value);
  }
  if (Array.isArray(value)) return value.length ? value.join(", ") : "none";
  return String(value);
}

function sameValue(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    const x = [...a].sort();
    const y = [...b].sort();
    return x.length === y.length && x.every((v, i) => v === y[i]);
  }
  return a === b;
}

const LOCKED = new Set<string>(LOCKED_TERM_FIELDS);

export const llcTermRouter = createTRPCRouter({
  get: withLlcAccessControl
    .meta({ policies: { "llc-terms": { allow: ["read"] } } })
    .query(async ({ ctx }) => {
      const companyId = ctx.membership.companyId;
      const term = await getOrCreateLlcTerm(ctx.db, companyId);
      const preferred = await ctx.db.unitClass.findFirst({
        where: { companyId, kind: "PREFERRED" },
      });
      const clock = await getTermClock(ctx.db, companyId);
      const extensionsApproved = await countTermExtensions(ctx.db, companyId);
      const economicsLocked = await isEconomicsLocked(ctx.db, companyId);
      return toWire({
        term: toTermDto(term),
        clock,
        today: economicsToday(ctx.company.timezone),
        unitClassTerms: preferred
          ? {
              finalClosingDate: dateOrNull(preferred.finalClosingDate),
              balanceOutsideDate: dateOrNull(preferred.balanceOutsideDate),
              prefReturnBps: preferred.prefReturnBps,
              residualSplitBps: preferred.residualSplitBps,
              pricePerUnitCents: preferred.pricePerUnitCents,
              fractionalUnitsAllowed: preferred.fractionalUnitsAllowed,
              balanceReturnStartRule: preferred.balanceReturnStartRule,
            }
          : null,
        extensionsApproved,
        economicsLocked,
      });
    }),

  update: withLlcAccessControl
    .meta({ policies: { "llc-terms": { allow: ["update"] } } })
    .input(ZLlcTermUpdateSchema)
    .mutation(({ ctx, input }) => {
      const companyId = ctx.membership.companyId;
      return ctx.db.$transaction(async (tx) => {
        await lockCompanyLedger(tx, companyId);
        const term = await getOrCreateLlcTerm(tx, companyId);
        const keys = (Object.keys(input) as (keyof TLlcTermUpdate)[]).filter(
          (k) => input[k] !== undefined,
        );
        const changed = keys.filter(
          (k) => !sameValue(currentValue(term, k), input[k]),
        );
        if (changed.length === 0) return toWire({ term: toTermDto(term) });

        // The Target Sale Date (and what an open term-extension consent
        // states) depends on the term length.
        if (changed.some((k) => k === "targetSaleYears")) {
          await assertNoPendingTermExtension(
            tx,
            companyId,
            "The term parameters",
          );
        }
        if (changed.some((k) => LOCKED.has(k))) {
          if (await isEconomicsLocked(tx, companyId)) {
            ruleViolation(
              `${changed.filter((k) => LOCKED.has(k)).join(", ")} cannot be changed after the first Call Notice, default or distribution: it would rewrite history.`,
            );
          }
        }
        const loiMax = input.loiExtensionMaxDays;
        if (loiMax !== undefined && loiMax < term.loiExtensionDays) {
          ruleViolation(
            `The LOI extension maximum cannot be below the LOI extension already recorded (${term.loiExtensionDays} days, Section 2.4).`,
          );
        }

        const {
          replacementFunderOutsideDate,
          extraHolidays,
          minimumOperatingReserveCents,
          orgExpenseCapCents,
          ...rest
        } = input;
        const updated = await tx.llcTerm.update({
          where: { companyId },
          data: {
            ...rest,
            ...(replacementFunderOutsideDate !== undefined
              ? {
                  replacementFunderOutsideDate: fromDateOnly(
                    replacementFunderOutsideDate,
                  ),
                }
              : {}),
            ...(extraHolidays !== undefined
              ? {
                  extraHolidays: [...new Set(extraHolidays)]
                    .sort()
                    .map(fromDateOnly),
                }
              : {}),
            ...(minimumOperatingReserveCents !== undefined
              ? {
                  minimumOperatingReserveCents: numberToCents(
                    minimumOperatingReserveCents,
                  ),
                }
              : {}),
            ...(orgExpenseCapCents !== undefined
              ? { orgExpenseCapCents: numberToCents(orgExpenseCapCents) }
              : {}),
          },
        });
        await audit(
          tx,
          ctx,
          companyId,
          term.id,
          "llcTerm.updated",
          changed
            .map(
              (k) =>
                `${k}: ${display(k, currentValue(term, k))} → ${display(k, input[k])}`,
            )
            .join("; "),
        );
        return toWire({ term: toTermDto(updated) });
      });
    }),

  setOperationsCommencementDate: withLlcAccessControl
    .meta({ policies: { "llc-terms": { allow: ["update"] } } })
    .input(ZSetOperationsCommencementDateSchema)
    .mutation(({ ctx, input }) => {
      const companyId = ctx.membership.companyId;
      const today = economicsToday(ctx.company.timezone);
      return ctx.db.$transaction(async (tx) => {
        await lockCompanyLedger(tx, companyId);
        const term = await getOrCreateLlcTerm(tx, companyId);
        if (input.date > today) {
          ruleViolation(
            "The Operations Commencement Date cannot be in the future (Section 1.21).",
          );
        }
        const current = dateOrNull(term.operationsCommencementDate);
        if (current !== input.date) {
          await assertNoPendingTermExtension(
            tx,
            companyId,
            "The Operations Commencement Date",
          );
        }
        if (current !== null && current !== input.date) {
          if ((await countTermExtensions(tx, companyId)) > 0) {
            ruleViolation(
              "The Operations Commencement Date cannot change after a term extension was approved (Section 2.4).",
            );
          }
        }
        if (input.noticeSentOn !== null) {
          if (input.noticeSentOn < input.date || input.noticeSentOn > today) {
            ruleViolation(
              "The OCD notice date must be on or after the Operations Commencement Date and not in the future (Section 1.21).",
            );
          }
        }
        const updated = await tx.llcTerm.update({
          where: { companyId },
          data: {
            operationsCommencementDate: fromDateOnly(input.date),
            ocdNoticeSentOn:
              input.noticeSentOn === null
                ? null
                : fromDateOnly(input.noticeSentOn),
          },
        });
        await audit(
          tx,
          ctx,
          companyId,
          term.id,
          "llcTerm.ocd-set",
          `Operations Commencement Date: ${current ?? "not set"} → ${input.date}; notice sent on: ${input.noticeSentOn ?? "not sent"}`,
        );
        return toWire({ term: toTermDto(updated) });
      });
    }),

  setLoiExtension: withLlcAccessControl
    .meta({ policies: { "llc-terms": { allow: ["update"] } } })
    .input(ZSetLoiExtensionSchema)
    .mutation(({ ctx, input }) => {
      const companyId = ctx.membership.companyId;
      return ctx.db.$transaction(async (tx) => {
        await lockCompanyLedger(tx, companyId);
        const term = await getOrCreateLlcTerm(tx, companyId);
        if (term.operationsCommencementDate === null) {
          ruleViolation(
            "Set the Operations Commencement Date first (Section 1.21).",
          );
        }
        if (input.days !== term.loiExtensionDays) {
          await assertNoPendingTermExtension(
            tx,
            companyId,
            "The LOI extension",
          );
        }
        if (input.days > term.loiExtensionMaxDays) {
          ruleViolation(
            `The LOI extension is at most ${term.loiExtensionMaxDays} days (Section 2.4).`,
          );
        }
        if (input.days > 0 && input.loiDocumentId === null) {
          ruleViolation(
            "Attach the signed letter of intent or purchase agreement in effect on the Target Sale Date (Section 2.4).",
          );
        }
        if (input.loiDocumentId !== null) {
          await assertCompanyOwns(
            tx,
            companyId,
            { documentIds: [input.loiDocumentId] },
            () => notFound("Document"),
          );
        }
        const updated = await tx.llcTerm.update({
          where: { companyId },
          data: {
            loiExtensionDays: input.days,
            loiDocumentId: input.loiDocumentId,
          },
        });
        await audit(
          tx,
          ctx,
          companyId,
          term.id,
          "llcTerm.updated",
          `loiExtensionDays: ${term.loiExtensionDays} → ${input.days}; loiDocumentId: ${term.loiDocumentId ?? "none"} → ${input.loiDocumentId ?? "none"}`,
        );
        return toWire({ term: toTermDto(updated) });
      });
    }),

  reopenBooks: withLlcAccessControl
    .meta({ policies: { "llc-terms": { allow: ["update"] } } })
    .input(ZReopenBooksSchema)
    .mutation(({ ctx, input }) => {
      const companyId = ctx.membership.companyId;
      return ctx.db.$transaction(async (tx) => {
        await lockCompanyLedger(tx, companyId);
        const term = await getOrCreateLlcTerm(tx, companyId);
        const current = dateOrNull(term.booksClosedThrough);
        if (current === null) ruleViolation("The books are not closed.");
        if (input.through !== null && input.through >= current) {
          ruleViolation(
            `The books are closed through ${current}; choose an earlier date to reopen them.`,
          );
        }
        const blocking = await tx.distribution.findFirst({
          where: {
            companyId,
            status: "FINALIZED",
            isReversal: false,
            type: { in: ["OPERATING", "SALE_OR_LIQUIDATION"] },
            ...(input.through !== null
              ? { periodEnd: { gt: fromDateOnly(input.through) } }
              : {}),
          },
          orderBy: { periodEnd: "desc" },
          select: { number: true, periodEnd: true },
        });
        if (blocking) {
          ruleViolation(
            `Distribution ${blocking.number === null ? "" : `#${blocking.number} `}covers the period through ${toDateOnly(blocking.periodEnd)}; reverse it before reopening the books for that period (Section 5.6(a)).`,
          );
        }
        const updated = await tx.llcTerm.update({
          where: { companyId },
          data: {
            booksClosedThrough:
              input.through === null ? null : fromDateOnly(input.through),
          },
        });
        await audit(
          tx,
          ctx,
          companyId,
          term.id,
          "llcTerm.books-reopened",
          `Books closed through: ${current} → ${input.through ?? "open"}. Reason: ${input.reason}`,
        );
        return toWire({ term: toTermDto(updated) });
      });
    }),
});
