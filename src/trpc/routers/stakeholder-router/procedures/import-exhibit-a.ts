/**
 * `stakeholder.importExhibitA` (F14): records members admitted on paper from
 * an Exhibit A CSV. The server always parses and validates the uploaded text
 * itself (the client preview is never trusted). A commit runs one
 * transaction: it locks the Preferred class, re-validates everything, then
 * per row creates or updates the stakeholder and goes through the ledger
 * services (`createCommitment` → `recordCapitalReceipt` →
 * `decideCommitment`), so every ledger rule and audit row applies. Any
 * invalid row imports nothing.
 */
import type { Stakeholder, UnitClass } from "@prisma/client";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import {
  heldOnOrBefore,
  type OfferingTerms,
  validateAcceptance,
  validateCashReceipt,
} from "@/lib/admission/commitment-rules";
import {
  type ExhibitARow,
  parseExhibitACsv,
} from "@/lib/admission/exhibit-a-csv";
import { todayInTimeZone } from "@/lib/date-only";
import { microUnitsToDecimalString } from "@/lib/llc/money";
import { microUnitsForAmount } from "@/lib/llc/units";
import { centsToNumber, formatCents } from "@/lib/money";
import { Audit } from "@/server/audit";
import type {
  PrismaTransactionalClient,
  TPrismaOrTransaction,
} from "@/server/db";
import {
  createCommitment,
  decideCommitment,
  type LedgerActor,
  lockUnitClass,
  recordCapitalReceipt,
} from "@/server/llc/commitments";
import { dateToWire } from "@/server/llc/serialize";
import { withLlcAccessControl } from "@/trpc/api/trpc";
import { ZCreateMemberInput } from "../member-schema";
import { DUPLICATE_MEMBER_EMAIL } from "./create-member";
import { isUniqueViolation } from "./get-member";

export const ZImportExhibitAInput = z.object({
  csvText: z.string().max(200_000),
  dryRun: z.boolean(),
});

export type ExhibitAImportRow = {
  line: number;
  name: string;
  email: string;
  committedCents: number;
  paidCents: number;
  units: string;
  admittedOn: string;
  action: "create" | "use-existing";
  /** For "use-existing": the stored fields the import will change. */
  changes: string[];
  errors: string[];
};

export type ExhibitAImportResult = {
  rows: ExhibitAImportRow[];
  fileErrors: { line: number; message: string }[];
  totals: { committedCents: number; paidCents: number; units: string };
  canImport: boolean;
};

type MemberData = {
  name: string;
  email: string;
  holderType?: ExhibitARow["holderType"];
  residenceState?: string;
  accreditationBasis?: ExhibitARow["accreditationBasis"];
  signerName?: string;
  signerTitle?: string;
  streetAddress?: string;
  city?: string;
  state?: string;
  zipcode?: string;
  isInsider?: boolean;
};

type PlannedRow = {
  row: ExhibitARow;
  existing: Stakeholder | null;
  /** Fields written: all of them for a new member, supplied cells only for an existing one. */
  data: MemberData;
  preview: ExhibitAImportRow;
};

type Plan = {
  unitClass: UnitClass;
  result: ExhibitAImportResult;
  planned: PlannedRow[];
};

function termsOf(unitClass: UnitClass): OfferingTerms {
  return {
    minCommitmentCents: unitClass.minCommitmentCents,
    minCommitmentFloorCents: unitClass.minCommitmentFloorCents,
    offeringCapCents: unitClass.offeringCapCents,
    initialInstallmentBps: unitClass.initialInstallmentBps,
    finalClosingDate: dateToWire(unitClass.finalClosingDate),
    balanceOutsideDate: dateToWire(unitClass.balanceOutsideDate),
    acceptanceBusinessDays: unitClass.acceptanceBusinessDays,
    refundBusinessDays: unitClass.refundBusinessDays,
    prefReturnBps: unitClass.prefReturnBps,
    balanceReturnStartRule: unitClass.balanceReturnStartRule,
  };
}

/** Member fields from the file: every field for a new member. */
function memberDataFor(
  row: ExhibitARow,
  existing: Stakeholder | null,
): MemberData {
  const data: MemberData = {
    name: row.name,
    email: row.email,
    residenceState: row.residenceState,
    accreditationBasis: row.accreditationBasis,
    signerName: row.signerName,
    signerTitle: row.signerTitle,
    streetAddress: row.streetAddress,
    city: row.city,
    state: row.state,
    zipcode: row.zipcode,
  };
  if (!existing || row.holderTypeSupplied) data.holderType = row.holderType;
  if (!existing || row.isInsiderSupplied) data.isInsider = row.isInsider;
  // Undefined = not in the file: an existing member keeps the stored value.
  for (const key of Object.keys(data) as (keyof MemberData)[]) {
    if (data[key] === undefined) delete data[key];
  }
  return data;
}

function changesFor(existing: Stakeholder, data: MemberData): string[] {
  const changes: string[] = [];
  for (const [key, value] of Object.entries(data)) {
    if (key === "email") continue;
    const before = existing[key as keyof Stakeholder];
    if (before !== value) {
      changes.push(
        `${key}: ${before === null || before === undefined ? "—" : String(before)} → ${String(value)}`,
      );
    }
  }
  return changes;
}

async function buildPlan(
  db: TPrismaOrTransaction,
  companyId: string,
  timezone: string,
  csvText: string,
): Promise<Plan> {
  const unitClass = await db.unitClass.findFirst({
    where: { companyId, kind: "PREFERRED" },
  });
  if (!unitClass) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "The company has no Preferred unit class.",
    });
  }
  const price = unitClass.pricePerUnitCents;
  if (price === null || price <= 0n) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Set the price per unit of the Preferred class first.",
    });
  }

  const parsed = parseExhibitACsv(csvText, { pricePerUnitCents: price });
  const today = todayInTimeZone(timezone);
  const terms = termsOf(unitClass);

  const existingList = await db.stakeholder.findMany({
    where: { companyId, email: { in: parsed.rows.map((r) => r.email) } },
  });
  const existingByEmail = new Map(existingList.map((s) => [s.email, s]));
  const openCommitments = await db.commitment.findMany({
    where: {
      companyId,
      unitClassId: unitClass.id,
      stakeholderId: { in: existingList.map((s) => s.id) },
      status: { in: ["ACCEPTED", "REDUCED", "PENDING"] },
    },
    select: { stakeholderId: true },
  });
  const withCommitment = new Set(openCommitments.map((c) => c.stakeholderId));
  const accepted = await db.commitment.aggregate({
    where: {
      companyId,
      unitClassId: unitClass.id,
      status: { in: ["ACCEPTED", "REDUCED"] },
    },
    _sum: { acceptedCents: true },
  });
  let otherAcceptedCents = accepted._sum.acceptedCents ?? 0n;

  const planned: PlannedRow[] = [];
  let totalCommitted = 0n;
  let totalPaid = 0n;
  let totalMicro = 0n;

  for (const row of parsed.rows) {
    const errors: string[] = [];
    const existing = existingByEmail.get(row.email) ?? null;
    if (existing && withCommitment.has(existing.id)) {
      errors.push(
        `${existing.name} (${row.email}) already has a commitment in the Preferred class.`,
      );
    }

    // The ledger counts only receipts dated on or before the acceptance
    // date toward the Initial Installment (decideCommitment).
    if (row.receiptDate > row.admittedOn) {
      errors.push(
        `Receipt Date ${row.receiptDate} is after Date Admitted ${row.admittedOn}; only money received on or before the admission date counts toward the Initial Installment. Record later wires afterwards as Balance receipts.`,
      );
    }
    if (row.paidCents > 0n) {
      for (const e of validateCashReceipt({
        status: "PENDING",
        acceptedCents: 0n,
        cashAppliedCents: 0n,
        amountCents: row.paidCents,
        receivedOn: row.receiptDate,
        today,
      })) {
        errors.push(`${e.code}: ${e.message}`);
      }
    }
    const heldCents = heldOnOrBefore(
      row.paidCents > 0n
        ? [{ id: "r", receivedOn: row.receiptDate, amountCents: row.paidCents }]
        : [],
      row.admittedOn,
    );
    for (const e of validateAcceptance({
      terms,
      committedCents: row.committedCents,
      acceptedCents: row.committedCents,
      acceptedOn: row.admittedOn,
      signedOn: null,
      today,
      heldCents,
      keepCents: row.paidCents,
      otherAcceptedCents,
      minimumWaived: row.minimumWaived,
      isReplacement: false,
      skipClosingDateCheck: false,
    })) {
      errors.push(`${e.code}: ${e.message}`);
    }
    otherAcceptedCents += row.committedCents;

    const data = memberDataFor(row, existing);
    const merged = existing
      ? {
          name: data.name,
          email: data.email,
          holderType: data.holderType ?? existing.holderType ?? "INDIVIDUAL",
          signerName: data.signerName ?? existing.signerName ?? undefined,
          isInsider: data.isInsider ?? existing.isInsider,
        }
      : data;
    const member = ZCreateMemberInput.safeParse({
      isInsider: false,
      ...merged,
    });
    if (!member.success) {
      for (const issue of member.error.issues) {
        errors.push(`${issue.path.join(".") || "member"}: ${issue.message}`);
      }
    }

    const micro = microUnitsForAmount(
      row.paidCents,
      price,
      unitClass.fractionalUnitsAllowed,
    );
    totalCommitted += row.committedCents;
    totalPaid += row.paidCents;
    totalMicro += micro;

    planned.push({
      row,
      existing,
      data,
      preview: {
        line: row.line,
        name: row.name,
        email: row.email,
        committedCents: centsToNumber(row.committedCents),
        paidCents: centsToNumber(row.paidCents),
        units: microUnitsToDecimalString(micro),
        admittedOn: row.admittedOn,
        action: existing ? "use-existing" : "create",
        changes: existing ? changesFor(existing, data) : [],
        errors,
      },
    });
  }

  const fileErrors = parsed.errors;
  const rows = planned.map((p) => p.preview);
  return {
    unitClass,
    planned,
    result: {
      rows,
      fileErrors,
      totals: {
        committedCents: centsToNumber(totalCommitted),
        paidCents: centsToNumber(totalPaid),
        units: microUnitsToDecimalString(totalMicro),
      },
      canImport:
        fileErrors.length === 0 &&
        rows.length > 0 &&
        rows.every((r) => r.errors.length === 0),
    },
  };
}

async function importRow(
  tx: PrismaTransactionalClient,
  companyId: string,
  unitClassId: string,
  p: PlannedRow,
  actor: LedgerActor,
): Promise<string> {
  const { row, existing, data } = p;
  let stakeholderId: string;
  if (existing) {
    const updated = await tx.stakeholder.update({
      where: { id: existing.id, companyId },
      data,
    });
    stakeholderId = updated.id;
    await Audit.create(
      {
        action: "stakeholder.updated",
        companyId,
        actor: { type: "user", id: actor.userId },
        context: { userAgent: actor.userAgent, requestIp: actor.requestIp },
        target: [{ type: "stakeholder", id: updated.id }],
        summary: `${actor.name} updated member ${updated.name} from an Exhibit A import${
          p.preview.changes.length > 0
            ? ` (${p.preview.changes.join("; ")})`
            : ""
        }`,
      },
      tx,
    );
  } else {
    const holderType = data.holderType ?? "INDIVIDUAL";
    const created = await tx.stakeholder.create({
      data: {
        ...data,
        holderType,
        isInsider: data.isInsider ?? false,
        companyId,
        currentRelationship: "INVESTOR",
        stakeholderType:
          holderType === "ENTITY" || holderType === "TRUST"
            ? "INSTITUTION"
            : "INDIVIDUAL",
        institutionName: null,
        memberStatus: "PROSPECT",
      },
    });
    stakeholderId = created.id;
    await Audit.create(
      {
        action: "stakeholder.added",
        companyId,
        actor: { type: "user", id: actor.userId },
        context: { userAgent: actor.userAgent, requestIp: actor.requestIp },
        target: [{ type: "stakeholder", id: created.id }],
        summary: `${actor.name} added member ${created.name} from an Exhibit A import`,
      },
      tx,
    );
  }

  const commitment = await createCommitment(
    tx,
    {
      companyId,
      stakeholderId,
      unitClassId,
      committedCents: row.committedCents,
      signedOn: row.admittedOn,
      accreditationBasis: row.accreditationBasis,
    },
    actor,
  );
  if (row.paidCents > 0n) {
    await recordCapitalReceipt(
      tx,
      {
        companyId,
        commitmentId: commitment.id,
        receivedOn: row.receiptDate,
        amountCents: row.paidCents,
        reference: row.wireReference,
      },
      actor,
    );
  }
  await decideCommitment(
    tx,
    {
      companyId,
      commitmentId: commitment.id,
      decision: "ACCEPT",
      acceptedOn: row.admittedOn,
      keepCents: row.paidCents,
      minimumWaived: row.minimumWaived,
    },
    actor,
  );
  return stakeholderId;
}

export const importExhibitAProcedure = withLlcAccessControl
  .meta({
    policies: {
      stakeholder: { allow: ["create"] },
      commitments: { allow: ["create"] },
    },
  })
  .input(ZImportExhibitAInput)
  .mutation(async ({ ctx, input }): Promise<ExhibitAImportResult> => {
    const { db, membership, session, company } = ctx;
    const { companyId } = membership;

    if (input.dryRun) {
      return (await buildPlan(db, companyId, company.timezone, input.csvText))
        .result;
    }

    const actor: LedgerActor = {
      userId: session.user.id,
      memberId: membership.memberId,
      name: session.user.name ?? "A team member",
      requestIp: ctx.requestIp,
      userAgent: ctx.userAgent,
    };

    try {
      return await db.$transaction(
        async (tx) => {
          const ref = await tx.unitClass.findFirst({
            where: { companyId, kind: "PREFERRED" },
            select: { id: true },
          });
          if (ref) await lockUnitClass(tx, companyId, ref.id);
          // Re-validate under the class lock, from the uploaded text.
          const plan = await buildPlan(
            tx,
            companyId,
            company.timezone,
            input.csvText,
          );
          if (!plan.result.canImport) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: "Fix the listed errors first.",
            });
          }
          const ids: string[] = [];
          for (const p of plan.planned) {
            try {
              ids.push(
                await importRow(tx, companyId, plan.unitClass.id, p, actor),
              );
            } catch (error) {
              if (error instanceof TRPCError) {
                throw new TRPCError({
                  code: error.code,
                  message: `Line ${p.row.line} (${p.row.name}): ${error.message}`,
                });
              }
              throw error;
            }
          }
          const { totals } = plan.result;
          await Audit.create(
            {
              action: "stakeholder.imported",
              companyId,
              actor: { type: "user", id: actor.userId },
              context: {
                userAgent: actor.userAgent,
                requestIp: actor.requestIp,
              },
              target: ids.map((id) => ({ type: "stakeholder" as const, id })),
              summary: `${actor.name} imported ${ids.length} members from Exhibit A: ${formatCents(totals.committedCents)} committed, ${formatCents(totals.paidCents)} paid`,
            },
            tx,
          );
          return plan.result;
        },
        { timeout: 60_000 },
      );
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: DUPLICATE_MEMBER_EMAIL,
        });
      }
      throw error;
    }
  });
