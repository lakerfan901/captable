import { TRPCError } from "@trpc/server";
import { mapExhibitBAnswers } from "@/lib/admission/exhibit-b-answers";
import type { PacketStage } from "@/lib/admission/packet-stage";
import { centsToNumber } from "@/lib/money";
import states from "@/lib/states";
import type {
  PrismaTransactionalClient,
  TPrismaOrTransaction,
} from "@/server/db";
import {
  INVESTOR_ROLE,
  lockTemplate,
  MANAGER_ROLE,
  packetStageOf,
} from "@/server/llc/admission";
import { economicsToday } from "@/server/llc/economics/clock";
import { lockCompanyLedgerAndUnitClasses } from "@/server/llc/economics/scope";
import { sumUnits } from "@/server/llc/receipt-rules";
import { dateToWire, unitsToWire } from "@/server/llc/serialize";
import { type CommitmentDTO, toCommitmentDTO } from "../commitment-router/dto";
import type { MemberDTO } from "../stakeholder-router/member-schema";
import { toMemberDTO } from "../stakeholder-router/procedures/get-member";
import type { UnitClassDTO } from "../unit-class-router/schema";

// Shared by the F13 procedures (01-foundation.md F13): loading a packet,
// locking it for a change, and the confirmation screen's view of it.

export const SUBSCRIPTION_NOT_FOUND = "Subscription not found.";

export type PacketCompany = { id: string; timezone: string };

/** Unlocked lookup by public id, scoped to the company; NOT_FOUND otherwise. */
export async function findPacketId(
  db: TPrismaOrTransaction,
  companyId: string,
  publicId: string,
): Promise<string> {
  const found = await db.template.findFirst({
    where: { publicId, companyId, workflow: "SUBSCRIPTION", isMaster: false },
    select: { id: true },
  });
  if (!found) {
    throw new TRPCError({ code: "NOT_FOUND", message: SUBSCRIPTION_NOT_FOUND });
  }
  return found.id;
}

const lockedPacketSelect = {
  id: true,
  publicId: true,
  name: true,
  status: true,
  stakeholderId: true,
  commitmentId: true,
  commitment: { select: { status: true } },
  eSignRecipient: {
    select: {
      id: true,
      role: true,
      status: true,
      memberId: true,
      name: true,
      email: true,
    },
  },
} as const;

/**
 * Finds the packet, takes the locks in the one order used everywhere
 * (company ledger advisory lock and the unit-class rows when `ledger` is set,
 * then the template row) and re-reads the packet under them. Every F13
 * mutation goes through here, so the stage it checks is the stage it
 * changes.
 */
export async function lockPacket(
  tx: PrismaTransactionalClient,
  companyId: string,
  publicId: string,
  opts: { ledger: boolean },
) {
  const id = await findPacketId(tx, companyId, publicId);
  if (opts.ledger) await lockCompanyLedgerAndUnitClasses(tx, companyId);
  await lockTemplate(tx, id);
  const packet = await tx.template.findFirst({
    where: { id, companyId },
    select: lockedPacketSelect,
  });
  if (!packet) {
    throw new TRPCError({ code: "NOT_FOUND", message: SUBSCRIPTION_NOT_FOUND });
  }
  const investor =
    packet.eSignRecipient.find((r) => r.role === INVESTOR_ROLE) ?? null;
  const manager =
    packet.eSignRecipient.find((r) => r.role === MANAGER_ROLE) ?? null;
  return { packet, stage: packetStageOf(packet), investor, manager };
}

export const STAGE_LABEL: Record<PacketStage, string> = {
  AWAITING_INVESTOR: "waiting for the investor to sign",
  AWAITING_REVIEW: "waiting for review",
  AWAITING_COUNTERSIGN: "waiting for the countersignature",
  FINALISING: "countersigned; the signed document is being generated",
  COMPLETE: "complete",
  CANCELLED: "cancelled",
  REJECTED: "rejected",
};

export function wrongStage(action: string, stage: PacketStage): TRPCError {
  return new TRPCError({
    code: "BAD_REQUEST",
    message: `${action} This subscription is ${STAGE_LABEL[stage]}.`,
  });
}

/** Contribution received and units issued on the commitment, from the ledger. */
export async function ledgerFigures(
  db: TPrismaOrTransaction,
  companyId: string,
  commitmentId: string,
): Promise<{ receivedCents: bigint; units: string }> {
  const receipts = await db.capitalReceipt.findMany({
    where: { companyId, commitmentId, voidedAt: null },
    select: { appliedCents: true, unitsIssued: true },
  });
  return {
    receivedCents: receipts.reduce((sum, r) => sum + r.appliedCents, 0n),
    units: sumUnits(receipts.map((r) => unitsToWire(r.unitsIssued))),
  };
}

// ---------------------------------------------------------------------------
// The confirmation screen's view (`admission.get`)

export type AdmissionPacketView = {
  packet: {
    publicId: string;
    name: string;
    stage: PacketStage;
    createdAt: string;
    sourceMasterName: string | null;
    /** Where the signing link was sent (the investor recipient's email). */
    investorEmail: string | null;
  };
  stakeholder: MemberDTO;
  /** Version of the member record; send it back as `expected.stakeholderVersion`. */
  stakeholderVersion: string;
  answers: ReturnType<typeof mapExhibitBAnswers> | null;
  commitment: CommitmentDTO | null;
  w9Documents: {
    id: string;
    name: string;
    createdAt: string;
    bucketKey: string;
  }[];
  manager: {
    memberId: string | null;
    name: string | null;
    email: string | null;
    status: "PENDING" | "SENT" | "SIGNED" | null;
    isCurrentUser: boolean;
  };
  /**
   * What `prepareCountersign` will print on the Manager's lines (from the
   * ledger), once the commitment is accepted; null otherwise.
   */
  countersign: {
    receivedCents: number;
    units: string;
    managerSignDate: string | null;
  } | null;
  signedDocument: { id: string; name: string; bucketKey: string } | null;
  classTerms: UnitClassDTO;
  /** Σ accepted of the class's other ACCEPTED / REDUCED commitments (the cap check). */
  otherAcceptedCents: number;
  today: string;
};

const commitmentInclude = {
  stakeholder: { select: { name: true } },
  unitClass: {
    select: { initialInstallmentBps: true, finalClosingDate: true },
  },
  packet: { select: { publicId: true } },
  receipts: true,
} as const;

const centsOrNull = (b: bigint | null) =>
  b === null ? null : centsToNumber(b);

async function preferredClassDTO(
  db: TPrismaOrTransaction,
  companyId: string,
): Promise<UnitClassDTO> {
  const c = await db.unitClass.findFirst({
    where: { companyId, kind: "PREFERRED" },
  });
  if (!c) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "The company has no Preferred unit class.",
    });
  }
  // Sequential, not Promise.all: this also runs inside interactive
  // transactions (one connection).
  const issued = await db.capitalReceipt.aggregate({
    where: { companyId, unitClassId: c.id, voidedAt: null },
    _sum: { unitsIssued: true },
  });
  const active = await db.commitment.count({
    where: {
      companyId,
      unitClassId: c.id,
      status: { in: ["ACCEPTED", "REDUCED"] },
    },
  });
  const issuing = await db.capitalReceipt.count({
    where: {
      companyId,
      unitClassId: c.id,
      voidedAt: null,
      unitsIssued: { not: 0 },
    },
  });
  return {
    id: c.id,
    name: c.name,
    kind: c.kind,
    pricePerUnitCents: centsOrNull(c.pricePerUnitCents),
    authorizedUnits: c.authorizedUnits ? unitsToWire(c.authorizedUnits) : null,
    issuedUnits: unitsToWire(issued._sum.unitsIssued),
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
    termsLocked: active > 0 || issuing > 0,
  };
}

const STATE_NAMES = states.map((s) => ({ code: s.abbreviation, name: s.name }));

export async function loadPacketView(
  db: TPrismaOrTransaction,
  company: PacketCompany,
  publicId: string,
  currentMemberId: string,
): Promise<AdmissionPacketView> {
  const companyId = company.id;
  const template = await db.template.findFirst({
    where: { publicId, companyId, workflow: "SUBSCRIPTION", isMaster: false },
    select: {
      id: true,
      publicId: true,
      name: true,
      status: true,
      createdAt: true,
      sourceTemplateId: true,
      stakeholderId: true,
      commitmentId: true,
      signedDocumentId: true,
      commitment: { select: { status: true } },
      eSignRecipient: {
        select: {
          id: true,
          role: true,
          status: true,
          memberId: true,
          name: true,
          email: true,
        },
      },
      fields: {
        select: { semanticKey: true, prefilledValue: true, recipientId: true },
        orderBy: [{ page: "asc" }, { top: "asc" }, { left: "asc" }],
      },
    },
  });
  if (!template) {
    throw new TRPCError({ code: "NOT_FOUND", message: SUBSCRIPTION_NOT_FOUND });
  }
  const stage = packetStageOf(template);
  const stakeholder = template.stakeholderId
    ? await db.stakeholder.findFirst({
        where: { id: template.stakeholderId, companyId },
      })
    : null;
  if (!stakeholder) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "The subscription's member was not found.",
    });
  }

  const classTerms = await preferredClassDTO(db, companyId);
  const roleOf = new Map(template.eSignRecipient.map((r) => [r.id, r.role]));
  const investor =
    template.eSignRecipient.find((r) => r.role === INVESTOR_ROLE) ?? null;
  const manager =
    template.eSignRecipient.find((r) => r.role === MANAGER_ROLE) ?? null;

  const answers =
    investor?.status === "SIGNED"
      ? mapExhibitBAnswers(
          template.fields.map((f) => ({
            semanticKey: f.semanticKey,
            prefilledValue: f.prefilledValue,
            role: roleOf.get(f.recipientId) ?? null,
          })),
          STATE_NAMES,
          {
            minCommitmentCents: classTerms.minCommitmentCents,
            initialInstallmentBps: classTerms.initialInstallmentBps,
          },
        )
      : null;

  const today = economicsToday(company.timezone);
  const commitmentRow = template.commitmentId
    ? await db.commitment.findFirst({
        where: { id: template.commitmentId, companyId },
        include: commitmentInclude,
      })
    : null;
  const commitment = commitmentRow
    ? toCommitmentDTO(commitmentRow, today)
    : null;

  const others = await db.commitment.aggregate({
    where: {
      companyId,
      unitClassId: classTerms.id,
      status: { in: ["ACCEPTED", "REDUCED"] },
      ...(template.commitmentId ? { id: { not: template.commitmentId } } : {}),
    },
    _sum: { acceptedCents: true },
  });

  const w9Documents = await db.document.findMany({
    where: { companyId, stakeholderId: stakeholder.id, kind: "w9" },
    select: {
      id: true,
      name: true,
      createdAt: true,
      bucket: { select: { key: true } },
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  const signedDocument = template.signedDocumentId
    ? await db.document.findFirst({
        where: { id: template.signedDocumentId, companyId },
        select: { id: true, name: true, bucket: { select: { key: true } } },
      })
    : null;
  const master = template.sourceTemplateId
    ? await db.template.findFirst({
        where: { id: template.sourceTemplateId, companyId },
        select: { name: true },
      })
    : null;

  const decided =
    commitmentRow !== null &&
    (commitmentRow.status === "ACCEPTED" || commitmentRow.status === "REDUCED");
  const figures = decided
    ? await ledgerFigures(db, companyId, commitmentRow.id)
    : null;

  return {
    packet: {
      publicId: template.publicId,
      name: template.name,
      stage,
      createdAt: template.createdAt.toISOString(),
      sourceMasterName: master?.name ?? null,
      investorEmail: investor?.email ?? null,
    },
    stakeholder: toMemberDTO(stakeholder),
    stakeholderVersion: stakeholder.updatedAt.toISOString(),
    answers,
    commitment,
    w9Documents: w9Documents.map((d) => ({
      id: d.id,
      name: d.name,
      createdAt: d.createdAt.toISOString(),
      bucketKey: d.bucket.key,
    })),
    manager: {
      memberId: manager?.memberId ?? null,
      name: manager?.name ?? null,
      email: manager?.email ?? null,
      status: manager?.status ?? null,
      isCurrentUser:
        manager?.memberId !== null &&
        manager?.memberId !== undefined &&
        manager.memberId === currentMemberId,
    },
    countersign:
      figures && commitmentRow
        ? {
            receivedCents: centsToNumber(figures.receivedCents),
            units: figures.units,
            managerSignDate: dateToWire(commitmentRow.acceptedOn),
          }
        : null,
    signedDocument: signedDocument
      ? {
          id: signedDocument.id,
          name: signedDocument.name,
          bucketKey: signedDocument.bucket.key,
        }
      : null,
    classTerms,
    otherAcceptedCents: centsToNumber(others._sum.acceptedCents ?? 0n),
    today,
  };
}
