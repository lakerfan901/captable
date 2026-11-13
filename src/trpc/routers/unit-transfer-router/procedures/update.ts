import { TRPCError } from "@trpc/server";
import { computeTransferDates, ymdToUtcDate } from "@/lib/governance/dates";
import {
  hasRofr,
  type RofrOutcome,
  TRANSFER_DEADLINE_RULES,
} from "@/lib/governance/transfer-core";
import { Audit } from "@/server/audit";
import { closeSourceDeadlines } from "@/server/governance/compliance";
import { guardedWrite } from "@/server/governance/guarded";
import { assertCompanyOwns } from "@/server/tenant-ownership";
import { withLlcAccessControl } from "@/trpc/api/trpc";
import { ADMISSION_FIELDS, ZUnitTransferUpdateSchema } from "../schema";
import {
  auditContext,
  badRequest,
  companyBusinessDays,
  loadLockedTransfer,
  stakeholderNames,
  toTransferState,
  upsertTransferDeadline,
  userName,
} from "./shared";

// unitTransfer.update (03-governance.md G16).
//
// OPEN transfers only, except that the four admission checklist fields may
// also be changed while COMPLETED and not yet admitted (C3.8). The kind, the
// transferor, the class, the units and the notice date are immutable (cancel
// and re-create instead): the input has no such fields. Absent fields are
// unchanged; `null` clears a nullable field. Row lock, re-read, status check,
// then one single-row guarded update.
//
// Derived: `purchaseCloseByOn` and `effectiveOn` are recomputed with
// `computeTransferDates`. A price-established date upserts the
// TRANSFER_PURCHASE_CLOSE deadline (it can be moved, not cleared). An ROFR
// outcome leaving PENDING marks the two ROFR deadlines DONE with the outcome
// as the note. The Manager consent of Section 7.1 exists for VOLUNTARY only;
// the ROFR / purchase option for VOLUNTARY and INVOLUNTARY only.

const ROFR_LABEL: Record<RofrOutcome, string> = {
  NOT_APPLICABLE: "Not applicable",
  PENDING: "Pending",
  NOT_EXERCISED: "Not exercised",
  EXERCISED_BY_MANAGER: "Exercised by the Manager",
  EXERCISED_BY_MEMBERS: "Exercised by the Preferred Members",
};

const ROFR_RULES = ["TRANSFER_ROFR_MANAGER", "TRANSFER_ROFR_MEMBERS"];

export const updateProcedure = withLlcAccessControl
  .meta({ policies: { governance: { allow: ["update"] } } })
  .input(ZUnitTransferUpdateSchema)
  .mutation(async ({ ctx, input }) => {
    const companyId = ctx.membership.companyId;
    const now = new Date();
    const { publicId, ...fields } = input;
    const changed = Object.entries(fields)
      .filter(([, v]) => v !== undefined)
      .map(([k]) => k);
    if (changed.length === 0) badRequest("Nothing to change.");
    const admissionOnly = changed.every((k) =>
      (ADMISSION_FIELDS as readonly string[]).includes(k),
    );

    return await ctx.db.$transaction(async (tx) => {
      const row = await loadLockedTransfer(tx, companyId, publicId);
      if (row.status === "CANCELLED") {
        badRequest("This transfer was cancelled and can no longer be changed.");
      }
      if (row.status === "COMPLETED") {
        if (!admissionOnly) {
          badRequest(
            "This transfer is completed: only the admission checklist can still be changed (Section 7.8).",
          );
        }
        if (row.admittedOn !== null) {
          badRequest("The transferee has already been admitted.");
        }
      }

      // Kind rules.
      if (fields.managerConsent !== undefined && row.kind !== "VOLUNTARY") {
        badRequest(
          "The Manager's consent under Section 7.1 applies to a voluntary transfer only.",
        );
      }
      if (fields.rofrOutcome !== undefined && !hasRofr(row.kind)) {
        badRequest(
          "This kind of transfer has no right of first refusal or purchase option (Sections 7.1, 7.2).",
        );
      }

      // Client-supplied references.
      if (fields.toStakeholderId) {
        if (fields.toStakeholderId === row.fromStakeholderId) {
          badRequest("Transferor and transferee must differ.");
        }
        await assertCompanyOwns(tx, companyId, {
          stakeholderIds: [fields.toStakeholderId],
        });
      }
      let requiredResolutionId: string | null | undefined;
      if (fields.requiredResolutionPublicId === null) {
        requiredResolutionId = null;
      } else if (fields.requiredResolutionPublicId !== undefined) {
        const resolution = await tx.resolution.findFirst({
          where: { publicId: fields.requiredResolutionPublicId, companyId },
          select: { id: true },
        });
        if (!resolution) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Resolution not found.",
          });
        }
        requiredResolutionId = resolution.id;
      }

      // Recompute the derived dates from the merged inputs.
      const state = toTransferState(row);
      const transferNoticeOn =
        fields.transferNoticeOn === undefined
          ? state.transferNoticeOn
          : fields.transferNoticeOn;
      const priceEstablishedOn =
        fields.priceEstablishedOn ?? state.priceEstablishedOn;
      const dates = computeTransferDates(
        {
          kind: state.kind,
          noticeReceivedOn: state.noticeReceivedOn,
          transferNoticeOn,
          priceEstablishedOn,
        },
        await companyBusinessDays(tx, companyId),
      );

      const ymdOrNull = (v: string | null | undefined) =>
        v === undefined ? undefined : v === null ? null : ymdToUtcDate(v);
      const text = (v: string | null | undefined) =>
        v === undefined ? undefined : v === null || v === "" ? null : v;

      const data = {
        toStakeholderId: fields.toStakeholderId,
        proposedPriceCents:
          fields.proposedPriceCents === undefined
            ? undefined
            : fields.proposedPriceCents === null
              ? null
              : BigInt(fields.proposedPriceCents),
        terms: text(fields.terms),
        bonaFideOffer: fields.bonaFideOffer,
        rofrOutcome: fields.rofrOutcome,
        rofrDecidedOn: ymdOrNull(fields.rofrDecidedOn),
        rofrNote: text(fields.rofrNote),
        managerConsent: fields.managerConsent,
        managerConsentOn: ymdOrNull(fields.managerConsentOn),
        managerConsentNote: text(fields.managerConsentNote),
        securitiesOpinion: fields.securitiesOpinion,
        priceEstablishedOn: ymdOrNull(fields.priceEstablishedOn),
        transferNoticeOn: ymdOrNull(fields.transferNoticeOn),
        requiredResolutionId,
        exemptUnder71: fields.exemptUnder71,
        exemptNote: text(fields.exemptNote),
        admissionSignaturePage: fields.admissionSignaturePage,
        admissionExpensesPaid: fields.admissionExpensesPaid,
        admissionQualified: fields.admissionQualified,
        admissionManagerConsent: fields.admissionManagerConsent,
        notes: text(fields.notes),
        ...(row.status === "OPEN"
          ? {
              purchaseCloseByOn: ymdOrNull(dates.purchaseCloseByOn),
              effectiveOn: ymdOrNull(dates.effectiveOn),
            }
          : {}),
      };

      const written = await guardedWrite(() =>
        tx.unitTransfer.update({
          where: {
            id: row.id,
            companyId,
            status: row.status,
            ...(row.status === "COMPLETED" ? { admittedOn: null } : {}),
          },
          data,
          select: { id: true },
        }),
      );
      if (!written) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "This transfer was changed at the same time. Reload it.",
        });
      }

      // Deadlines (OPEN transfers only reach these fields).
      if (
        fields.priceEstablishedOn !== undefined &&
        dates.purchaseCloseByOn !== null
      ) {
        const names = await stakeholderNames(tx, companyId, [
          row.fromStakeholderId,
        ]);
        await upsertTransferDeadline(tx, {
          companyId,
          transferId: row.id,
          kind: state.kind,
          fromName: names.get(row.fromStakeholderId) ?? "",
          rule: "TRANSFER_PURCHASE_CLOSE",
          dueOn: dates.purchaseCloseByOn,
        });
      }
      if (
        fields.rofrOutcome !== undefined &&
        row.rofrOutcome === "PENDING" &&
        fields.rofrOutcome !== "PENDING"
      ) {
        await closeSourceDeadlines(tx, {
          companyId,
          sourceType: "UNIT_TRANSFER",
          sourceId: row.id,
          status: "DONE",
          note: ROFR_LABEL[fields.rofrOutcome],
          exceptRuleKeys: TRANSFER_DEADLINE_RULES.filter(
            (r) => !ROFR_RULES.includes(r),
          ),
          satisfiedBy: { type: "MANUAL", id: null },
          completedById: ctx.membership.memberId,
          now,
        });
      }

      await Audit.create(
        {
          action: "unitTransfer.updated",
          companyId,
          actor: { type: "user", id: ctx.session.user.id },
          context: auditContext(ctx),
          target: [{ type: "unitTransfer", id: row.id }],
          summary: `${userName(ctx)} updated a unit transfer (${changed.join(", ")})`,
        },
        tx,
      );
      return { success: true as const };
    });
  });
