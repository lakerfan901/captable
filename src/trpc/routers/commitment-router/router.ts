import { TRPCError } from "@trpc/server";
import { todayInTimeZone } from "@/lib/date-only";
import type { TPrismaOrTransaction } from "@/server/db";
import {
  createCommitment,
  decideCommitment,
  issueCommonUnits,
  type LedgerActor,
  recordCapitalReceipt,
  recordRefund,
  updatePendingCommitment,
  voidCapitalReceipt,
} from "@/server/llc/commitments";
import { createTRPCRouter, withLlcAccessControl } from "@/trpc/api/trpc";
import {
  type CommitmentDTO,
  type ReceiptDTO,
  toCommitmentDTO,
  toReceiptDTO,
} from "./dto";
import {
  ZodAcceptCommitmentSchema,
  ZodCreateCommitmentSchema,
  ZodGetCommitmentSchema,
  ZodIssueCommonUnitsSchema,
  ZodListCommitmentsSchema,
  ZodListReceiptsSchema,
  ZodRecordReceiptSchema,
  ZodRecordRefundSchema,
  ZodRejectCommitmentSchema,
  ZodUpdateCommitmentSchema,
  ZodVoidReceiptSchema,
} from "./schema";

type LlcCtx = {
  session: { user: { id: string; name?: string | null } };
  membership: { companyId: string; memberId: string };
  requestIp: string;
  userAgent: string;
};

function actorOf(ctx: LlcCtx): LedgerActor {
  return {
    userId: ctx.session.user.id,
    memberId: ctx.membership.memberId,
    name: ctx.session.user.name ?? "A team member",
    requestIp: ctx.requestIp,
    userAgent: ctx.userAgent,
  };
}

const commitmentInclude = {
  stakeholder: { select: { name: true } },
  unitClass: {
    select: { initialInstallmentBps: true, finalClosingDate: true },
  },
  packet: { select: { publicId: true } },
  receipts: true,
} as const;

async function assertStakeholder(
  db: TPrismaOrTransaction,
  companyId: string,
  stakeholderId: string,
): Promise<void> {
  const found = await db.stakeholder.findFirst({
    where: { id: stakeholderId, companyId },
    select: { id: true },
  });
  if (!found) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Member not found." });
  }
}

async function loadCommitmentDTO(
  db: TPrismaOrTransaction,
  companyId: string,
  id: string,
  today: string,
): Promise<CommitmentDTO> {
  const row = await db.commitment.findFirst({
    where: { id, companyId },
    include: commitmentInclude,
  });
  if (!row) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "Commitment not found.",
    });
  }
  return toCommitmentDTO(row, today);
}

export const commitmentRouter = createTRPCRouter({
  list: withLlcAccessControl
    .meta({ policies: { commitments: { allow: ["read"] } } })
    .input(ZodListCommitmentsSchema)
    .query(async ({ ctx, input }) => {
      const companyId = ctx.membership.companyId;
      if (input.stakeholderId) {
        await assertStakeholder(ctx.db, companyId, input.stakeholderId);
      }
      const rows = await ctx.db.commitment.findMany({
        where: {
          companyId,
          ...(input.stakeholderId
            ? { stakeholderId: input.stakeholderId }
            : {}),
          ...(input.status ? { status: input.status } : {}),
        },
        include: commitmentInclude,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      });
      const today = todayInTimeZone(ctx.company.timezone);
      return rows.map((row) => toCommitmentDTO(row, today));
    }),

  get: withLlcAccessControl
    .meta({ policies: { commitments: { allow: ["read"] } } })
    .input(ZodGetCommitmentSchema)
    .query(({ ctx, input }) =>
      loadCommitmentDTO(
        ctx.db,
        ctx.membership.companyId,
        input.id,
        todayInTimeZone(ctx.company.timezone),
      ),
    ),

  receipts: withLlcAccessControl
    .meta({ policies: { commitments: { allow: ["read"] } } })
    .input(ZodListReceiptsSchema)
    .query(
      async ({
        ctx,
        input,
      }): Promise<(ReceiptDTO & { stakeholderName: string })[]> => {
        const companyId = ctx.membership.companyId;
        if (input.stakeholderId) {
          await assertStakeholder(ctx.db, companyId, input.stakeholderId);
        }
        const rows = await ctx.db.capitalReceipt.findMany({
          where: {
            companyId,
            ...(input.stakeholderId
              ? { stakeholderId: input.stakeholderId }
              : {}),
            ...(input.includeVoided ? {} : { voidedAt: null }),
          },
          include: { stakeholder: { select: { name: true } } },
          orderBy: [{ receivedOn: "desc" }, { createdAt: "desc" }],
        });
        return rows.map((r) => ({
          ...toReceiptDTO(r),
          stakeholderName: r.stakeholder.name,
        }));
      },
    ),

  create: withLlcAccessControl
    .meta({ policies: { commitments: { allow: ["create"] } } })
    .input(ZodCreateCommitmentSchema)
    .mutation(({ ctx, input }) => {
      const companyId = ctx.membership.companyId;
      const actor = actorOf(ctx);
      const today = todayInTimeZone(ctx.company.timezone);
      return ctx.db.$transaction(async (tx) => {
        const preferred = await tx.unitClass.findFirst({
          where: { companyId, kind: "PREFERRED" },
          select: { id: true },
        });
        if (!preferred) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "The company has no Preferred unit class.",
          });
        }
        const created = await createCommitment(
          tx,
          {
            companyId,
            stakeholderId: input.stakeholderId,
            unitClassId: preferred.id,
            committedCents: BigInt(input.committedCents),
            signedOn: input.signedOn,
            investmentSummaryDate: input.investmentSummaryDate,
            accreditationBasis: input.accreditationBasis,
            notes: input.notes,
          },
          actor,
        );
        return loadCommitmentDTO(tx, companyId, created.id, today);
      });
    }),

  update: withLlcAccessControl
    .meta({ policies: { commitments: { allow: ["update"] } } })
    .input(ZodUpdateCommitmentSchema)
    .mutation(({ ctx, input }) => {
      const companyId = ctx.membership.companyId;
      const actor = actorOf(ctx);
      const today = todayInTimeZone(ctx.company.timezone);
      return ctx.db.$transaction(async (tx) => {
        await updatePendingCommitment(
          tx,
          {
            companyId,
            commitmentId: input.id,
            committedCents:
              input.committedCents === undefined
                ? undefined
                : BigInt(input.committedCents),
            signedOn: input.signedOn,
            investmentSummaryDate: input.investmentSummaryDate,
            accreditationBasis: input.accreditationBasis,
            notes: input.notes,
          },
          actor,
        );
        return loadCommitmentDTO(tx, companyId, input.id, today);
      });
    }),

  accept: withLlcAccessControl
    .meta({ policies: { commitments: { allow: ["update"] } } })
    .input(ZodAcceptCommitmentSchema)
    .mutation(({ ctx, input }) => {
      const companyId = ctx.membership.companyId;
      const actor = actorOf(ctx);
      const today = todayInTimeZone(ctx.company.timezone);
      return ctx.db.$transaction(async (tx) => {
        await decideCommitment(
          tx,
          {
            companyId,
            commitmentId: input.id,
            decision: "ACCEPT",
            acceptedOn: input.acceptedOn,
            acceptedCents:
              input.acceptedCents === undefined
                ? undefined
                : BigInt(input.acceptedCents),
            keepCents:
              input.keepCents === undefined
                ? undefined
                : BigInt(input.keepCents),
            minimumWaived: input.minimumWaived,
            minimumWaiverNote: input.minimumWaiverNote,
          },
          actor,
        );
        return loadCommitmentDTO(tx, companyId, input.id, today);
      });
    }),

  reject: withLlcAccessControl
    .meta({ policies: { commitments: { allow: ["update"] } } })
    .input(ZodRejectCommitmentSchema)
    .mutation(({ ctx, input }) => {
      const companyId = ctx.membership.companyId;
      const actor = actorOf(ctx);
      const today = todayInTimeZone(ctx.company.timezone);
      return ctx.db.$transaction(async (tx) => {
        await decideCommitment(
          tx,
          {
            companyId,
            commitmentId: input.id,
            decision: "REJECT",
            acceptedOn: input.decidedOn,
            rejectionReason: input.reason,
          },
          actor,
        );
        return loadCommitmentDTO(tx, companyId, input.id, today);
      });
    }),

  recordRefund: withLlcAccessControl
    .meta({ policies: { commitments: { allow: ["update"] } } })
    .input(ZodRecordRefundSchema)
    .mutation(({ ctx, input }) => {
      const companyId = ctx.membership.companyId;
      const actor = actorOf(ctx);
      const today = todayInTimeZone(ctx.company.timezone);
      return ctx.db.$transaction(async (tx) => {
        await recordRefund(
          tx,
          {
            companyId,
            commitmentId: input.id,
            paidCents: BigInt(input.paidCents),
            paidOn: input.paidOn,
          },
          actor,
        );
        return loadCommitmentDTO(tx, companyId, input.id, today);
      });
    }),

  recordReceipt: withLlcAccessControl
    .meta({ policies: { commitments: { allow: ["create"] } } })
    .input(ZodRecordReceiptSchema)
    .mutation(({ ctx, input }) => {
      const companyId = ctx.membership.companyId;
      const actor = actorOf(ctx);
      return ctx.db.$transaction(async (tx) => {
        const receipt = await recordCapitalReceipt(
          tx,
          {
            companyId,
            commitmentId: input.commitmentId,
            receivedOn: input.receivedOn,
            amountCents: BigInt(input.amountCents),
            reference: input.reference,
            note: input.note,
          },
          actor,
        );
        return toReceiptDTO(receipt);
      });
    }),

  voidReceipt: withLlcAccessControl
    .meta({ policies: { commitments: { allow: ["delete"] } } })
    .input(ZodVoidReceiptSchema)
    .mutation(({ ctx, input }) => {
      const companyId = ctx.membership.companyId;
      const actor = actorOf(ctx);
      return ctx.db.$transaction(async (tx) => {
        const voided = await voidCapitalReceipt(
          tx,
          { companyId, receiptId: input.receiptId, reason: input.reason },
          actor,
        );
        return { id: voided.id };
      });
    }),

  issueCommonUnits: withLlcAccessControl
    .meta({ policies: { commitments: { allow: ["create"] } } })
    .input(ZodIssueCommonUnitsSchema)
    .mutation(({ ctx, input }) => {
      const companyId = ctx.membership.companyId;
      const actor = actorOf(ctx);
      return ctx.db.$transaction(async (tx) => {
        const receipt = await issueCommonUnits(
          tx,
          {
            companyId,
            stakeholderId: input.stakeholderId,
            units: input.units,
            issuedOn: input.issuedOn,
          },
          actor,
        );
        return toReceiptDTO(receipt);
      });
    }),
});
