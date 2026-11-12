import { TRPCError } from "@trpc/server";
import { fromDateOnly } from "@/lib/date-only";
import { centsToNumber, formatCents } from "@/lib/money";
import { Audit } from "@/server/audit";
import type { TPrismaOrTransaction } from "@/server/db";
import { lockUnitClass } from "@/server/llc/commitments";
import { dateToWire, unitsToWire } from "@/server/llc/serialize";
import { createTRPCRouter, withLlcAccessControl } from "@/trpc/api/trpc";
import {
  changedFields,
  type UnitClassField,
  validateUnitClassUpdate,
} from "./rules";
import { type UnitClassDTO, ZodUpdateUnitClassSchema } from "./schema";

const centsOrNull = (b: bigint | null) =>
  b === null ? null : centsToNumber(b);
const toBigIntOrNull = (n: number | null) => (n === null ? null : BigInt(n));
const toDateOrNull = (s: string | null) =>
  s === null ? null : fromDateOnly(s);

async function loadUnitClasses(
  db: TPrismaOrTransaction,
  companyId: string,
  id?: string,
): Promise<UnitClassDTO[]> {
  const where = id ? { companyId, id } : { companyId };
  const classes = await db.unitClass.findMany({ where });
  if (classes.length === 0) return [];
  const classIds = classes.map((c) => c.id);

  const [issued, activeCommitments, issuingReceipts] = await Promise.all([
    db.capitalReceipt.groupBy({
      by: ["unitClassId"],
      where: { companyId, unitClassId: { in: classIds }, voidedAt: null },
      _sum: { unitsIssued: true },
    }),
    db.commitment.groupBy({
      by: ["unitClassId"],
      where: {
        companyId,
        unitClassId: { in: classIds },
        status: { in: ["ACCEPTED", "REDUCED"] },
      },
      _count: { _all: true },
    }),
    db.capitalReceipt.groupBy({
      by: ["unitClassId"],
      where: {
        companyId,
        unitClassId: { in: classIds },
        voidedAt: null,
        unitsIssued: { not: 0 },
      },
      _count: { _all: true },
    }),
  ]);

  const issuedBy = new Map(
    issued.map((r) => [r.unitClassId, r._sum.unitsIssued]),
  );
  const locked = new Set([
    ...activeCommitments.map((r) => r.unitClassId),
    ...issuingReceipts.map((r) => r.unitClassId),
  ]);

  return classes
    .map(
      (c): UnitClassDTO => ({
        id: c.id,
        name: c.name,
        kind: c.kind,
        pricePerUnitCents: centsOrNull(c.pricePerUnitCents),
        authorizedUnits: c.authorizedUnits
          ? unitsToWire(c.authorizedUnits)
          : null,
        issuedUnits: unitsToWire(issuedBy.get(c.id)),
        fractionalUnitsAllowed: c.fractionalUnitsAllowed,
        votesPerUnit: unitsToWire(c.votesPerUnit),
        prefReturnBps: c.prefReturnBps,
        prefReturnDayCount: c.prefReturnDayCount,
        balanceReturnStartRule: c.balanceReturnStartRule,
        residualSplitBps: c.residualSplitBps,
        minCommitmentCents: centsOrNull(c.minCommitmentCents),
        minCommitmentFloorCents: centsOrNull(c.minCommitmentFloorCents),
        offeringCapCents: centsOrNull(c.offeringCapCents),
        initialInstallmentBps: c.initialInstallmentBps,
        finalClosingDate: dateToWire(c.finalClosingDate),
        balanceOutsideDate: dateToWire(c.balanceOutsideDate),
        acceptanceBusinessDays: c.acceptanceBusinessDays,
        refundBusinessDays: c.refundBusinessDays,
        termsLocked: locked.has(c.id),
      }),
    )
    .sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "PREFERRED" ? -1 : 1));
}

const MONEY_FIELDS: readonly UnitClassField[] = [
  "pricePerUnitCents",
  "minCommitmentCents",
  "minCommitmentFloorCents",
  "offeringCapCents",
];

function formatFieldValue(field: UnitClassField, value: unknown): string {
  if (value === null || value === undefined) return "none";
  if (MONEY_FIELDS.includes(field) && typeof value === "number") {
    return formatCents(value);
  }
  return String(value);
}

export const unitClassRouter = createTRPCRouter({
  list: withLlcAccessControl
    .meta({ policies: { "unit-classes": { allow: ["read"] } } })
    .query(async ({ ctx }) => {
      const classes = await loadUnitClasses(ctx.db, ctx.membership.companyId);
      const residualSplitTotalBps = classes.reduce(
        (sum, c) => sum + c.residualSplitBps,
        0,
      );
      return { classes, residualSplitTotalBps };
    }),

  update: withLlcAccessControl
    .meta({ policies: { "unit-classes": { allow: ["update"] } } })
    .input(ZodUpdateUnitClassSchema)
    .mutation(({ ctx, input }) => {
      const companyId = ctx.membership.companyId;
      const { id, confirmAmendment, amendmentReason, ...terms } = input;

      return ctx.db.$transaction(async (tx) => {
        // Take the class row lock first (the same lock every ledger write
        // takes), so `termsLocked`, units issued and the accepted total are
        // read after any acceptance in flight has committed (M2).
        await lockUnitClass(tx, companyId, id);
        const [current] = await loadUnitClasses(tx, companyId, id);
        if (!current) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Unit class not found.",
          });
        }
        const accepted = await tx.commitment.aggregate({
          where: {
            companyId,
            unitClassId: id,
            status: { in: ["ACCEPTED", "REDUCED"] },
          },
          _sum: { acceptedCents: true },
        });

        const error = validateUnitClassUpdate(
          current,
          { ...terms, confirmAmendment, amendmentReason },
          { acceptedCents: centsToNumber(accepted._sum.acceptedCents ?? 0n) },
        );
        if (error) {
          throw new TRPCError({ code: "BAD_REQUEST", message: error });
        }

        const changed = changedFields(current, terms);

        await tx.unitClass.update({
          where: { id, companyId },
          data: {
            name: terms.name,
            pricePerUnitCents: toBigIntOrNull(terms.pricePerUnitCents),
            authorizedUnits: terms.authorizedUnits,
            fractionalUnitsAllowed: terms.fractionalUnitsAllowed,
            votesPerUnit: terms.votesPerUnit,
            prefReturnBps: terms.prefReturnBps,
            balanceReturnStartRule: terms.balanceReturnStartRule,
            residualSplitBps: terms.residualSplitBps,
            minCommitmentCents: toBigIntOrNull(terms.minCommitmentCents),
            minCommitmentFloorCents: toBigIntOrNull(
              terms.minCommitmentFloorCents,
            ),
            offeringCapCents: toBigIntOrNull(terms.offeringCapCents),
            initialInstallmentBps: terms.initialInstallmentBps,
            finalClosingDate: toDateOrNull(terms.finalClosingDate),
            balanceOutsideDate: toDateOrNull(terms.balanceOutsideDate),
            acceptanceBusinessDays: terms.acceptanceBusinessDays,
            refundBusinessDays: terms.refundBusinessDays,
          },
        });

        const changes = changed.map(
          (f) =>
            `${f}: ${formatFieldValue(f, current[f])} → ${formatFieldValue(f, terms[f])}`,
        );
        const reason =
          confirmAmendment && amendmentReason?.trim()
            ? ` Amendment reason: ${amendmentReason.trim()}`
            : "";

        await Audit.create(
          {
            action: "unitClass.updated",
            companyId,
            actor: { type: "user", id: ctx.session.user.id },
            context: {
              userAgent: ctx.userAgent,
              requestIp: ctx.requestIp,
            },
            target: [{ type: "unitClass", id }],
            summary: `${ctx.session.user.name} updated unit class ${terms.name}: ${
              changes.length > 0 ? changes.join("; ") : "no changes"
            }.${reason}`,
          },
          tx,
        );

        const [updated] = await loadUnitClasses(tx, companyId, id);
        if (!updated) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Unit class not found.",
          });
        }
        return updated;
      });
    }),
});
