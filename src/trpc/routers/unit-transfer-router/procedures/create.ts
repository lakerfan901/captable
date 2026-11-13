import { TRPCError } from "@trpc/server";
import { generatePublicId } from "@/common/id";
import { computeTransferDates, ymdToUtcDate } from "@/lib/governance/dates";
import { displayUnits, initialFlags } from "@/lib/governance/transfer-core";
import { fromMicro, toMicro } from "@/lib/llc/voting";
import { Audit } from "@/server/audit";
import { assertCompanyOwns } from "@/server/tenant-ownership";
import { withLlcAccessControl } from "@/trpc/api/trpc";
import { ZUnitTransferCreateSchema } from "../schema";
import {
  auditContext,
  badRequest,
  companyBusinessDays,
  companyTodayFor,
  initialDeadlines,
  stakeholderNames,
  unitsHeld,
  upsertTransferDeadline,
  userName,
} from "./shared";

// unitTransfer.create (03-governance.md G16): records a transfer under
// Section 7 when its notice is received.
//
// Both parties must already be Stakeholders of the company (the transferee
// is added as a prospect on the Members page first; this package never
// creates Stakeholders, and the company itself can never be named, R40).
// The unit class is the company's own and its kind is copied. The units may
// not exceed what the transferor holds of that class today; `complete`
// (G16b) checks the holding again as of the effective date. Dates come from
// `computeTransferDates` with the company's business days; the ROFR outcome
// and Manager consent start from `initialFlags`. VOLUNTARY and INVOLUNTARY
// transfers push the copy and refusal deadlines, VOLUNTARY also the 180-day
// close-by deadline (G14 table).

export const createProcedure = withLlcAccessControl
  .meta({ policies: { governance: { allow: ["create"] } } })
  .input(ZUnitTransferCreateSchema)
  .mutation(async ({ ctx, input }) => {
    const companyId = ctx.membership.companyId;
    const today = companyTodayFor(ctx.company, new Date());

    if (input.noticeReceivedOn > today) {
      badRequest("The date the notice was received cannot be in the future.");
    }
    if (input.toStakeholderId === input.fromStakeholderId) {
      badRequest("Transferor and transferee must differ.");
    }
    const units = toMicro(input.units);
    if (units <= 0n) badRequest("Enter more than zero units.");

    return await ctx.db.$transaction(async (tx) => {
      await assertCompanyOwns(tx, companyId, {
        stakeholderIds: [
          input.fromStakeholderId,
          ...(input.toStakeholderId ? [input.toStakeholderId] : []),
        ],
      });
      const unitClass = await tx.unitClass.findFirst({
        where: { id: input.unitClassId, companyId },
        select: { id: true, kind: true },
      });
      if (!unitClass) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Unit class not found.",
        });
      }

      const held = toMicro(
        await unitsHeld(
          tx,
          companyId,
          input.fromStakeholderId,
          unitClass.id,
          today,
        ),
      );
      if (units > held) {
        badRequest(
          `The transferor holds only ${displayUnits(fromMicro(held))} ${unitClass.kind === "COMMON" ? "Common" : "Preferred"} Units (Section 7).`,
        );
      }

      const dates = computeTransferDates(
        {
          kind: input.kind,
          noticeReceivedOn: input.noticeReceivedOn,
          transferNoticeOn: null,
          priceEstablishedOn: null,
        },
        await companyBusinessDays(tx, companyId),
      );
      const flags = initialFlags(input.kind);

      const transfer = await tx.unitTransfer.create({
        data: {
          publicId: generatePublicId(),
          companyId,
          kind: input.kind,
          status: "OPEN",
          fromStakeholderId: input.fromStakeholderId,
          toStakeholderId: input.toStakeholderId ?? null,
          unitClassId: unitClass.id,
          unitClassKind: unitClass.kind,
          units: fromMicro(units),
          noticeReceivedOn: ymdToUtcDate(input.noticeReceivedOn),
          proposedPriceCents:
            input.proposedPriceCents === undefined
              ? null
              : BigInt(input.proposedPriceCents),
          terms: input.terms || null,
          bonaFideOffer: input.bonaFideOffer ?? false,
          noticeCopyDueOn: dates.noticeCopyDueOn
            ? ymdToUtcDate(dates.noticeCopyDueOn)
            : null,
          managerRofrEndsOn: dates.managerRofrEndsOn
            ? ymdToUtcDate(dates.managerRofrEndsOn)
            : null,
          memberRofrEndsOn: dates.memberRofrEndsOn
            ? ymdToUtcDate(dates.memberRofrEndsOn)
            : null,
          closeByOn: dates.closeByOn ? ymdToUtcDate(dates.closeByOn) : null,
          rofrOutcome: flags.rofrOutcome,
          managerConsent: flags.managerConsent,
          notes: input.notes || null,
          authorId: ctx.membership.memberId,
        },
        select: { id: true, publicId: true },
      });

      const names = await stakeholderNames(tx, companyId, [
        input.fromStakeholderId,
        input.toStakeholderId ?? null,
      ]);
      const fromName = names.get(input.fromStakeholderId) ?? "";
      for (const d of initialDeadlines(dates)) {
        await upsertTransferDeadline(tx, {
          companyId,
          transferId: transfer.id,
          kind: input.kind,
          fromName,
          rule: d.rule,
          dueOn: d.dueOn,
        });
      }

      await Audit.create(
        {
          action: "unitTransfer.created",
          companyId,
          actor: { type: "user", id: ctx.session.user.id },
          context: auditContext(ctx),
          target: [{ type: "unitTransfer", id: transfer.id }],
          summary: `${userName(ctx)} recorded a transfer of ${displayUnits(fromMicro(units))} ${unitClass.kind === "COMMON" ? "Common" : "Preferred"} Units by ${fromName} (${input.kind}, notice received ${input.noticeReceivedOn})`,
        },
        tx,
      );
      return { publicId: transfer.publicId };
    });
  });
