import { firstOfFollowingMonth, utcDateToYmd } from "@/lib/governance/dates";
import {
  admissionErrors,
  completionErrors,
} from "@/lib/governance/transfer-core";
import { withLlcAccessControl } from "@/trpc/api/trpc";
import { ZUnitTransferGetSchema } from "../schema";
import {
  buildCompletionContext,
  companyTodayFor,
  completionAsOf,
  stakeholderNames,
  toTransferState,
  transferNotFound,
  unitsHeld,
} from "./shared";

// unitTransfer.get (03-governance.md G16): the transfer with its names, the
// computed completion and admission checklists, its compliance deadlines,
// the notice-copy report and the transferor's units.
//
// `completionErrors` is computed exactly as `complete` (G16b) will compute
// it: the transferor's units are read as of the effective date when the
// written notice of transfer is recorded (earlier completed transfers
// deducted), else as of today. `fromUnitsToday` is the transferor's holding
// of the class today.

export const getProcedure = withLlcAccessControl
  .meta({ policies: { governance: { allow: ["read"] } } })
  .input(ZUnitTransferGetSchema)
  .query(async ({ ctx, input }) => {
    const companyId = ctx.membership.companyId;
    const today = companyTodayFor(ctx.company, new Date());

    const row = await ctx.db.unitTransfer.findFirst({
      where: { publicId: input.publicId, companyId },
    });
    if (!row) transferNotFound();

    const state = toTransferState(row);
    const asOf = completionAsOf(state, today);
    const completionContext = await buildCompletionContext(
      ctx.db,
      companyId,
      row,
      today,
      asOf,
    );
    const fromUnitsToday = await unitsHeld(
      ctx.db,
      companyId,
      row.fromStakeholderId,
      row.unitClassId,
      today,
    );

    const names = await stakeholderNames(ctx.db, companyId, [
      row.fromStakeholderId,
      row.toStakeholderId,
    ]);

    const [deadlines, report, resolution, unitClass] = await Promise.all([
      ctx.db.complianceDeadline.findMany({
        where: { companyId, sourceType: "UNIT_TRANSFER", sourceId: row.id },
        orderBy: [{ dueOn: "asc" }, { ruleKey: "asc" }],
        select: {
          id: true,
          ruleKey: true,
          title: true,
          section: true,
          dueOn: true,
          status: true,
          completedAt: true,
          note: true,
        },
      }),
      row.noticeCopyReportId === null
        ? Promise.resolve(null)
        : ctx.db.memberReport.findFirst({
            where: { id: row.noticeCopyReportId, companyId },
            select: { publicId: true, status: true, sentAt: true },
          }),
      row.requiredResolutionId === null
        ? Promise.resolve(null)
        : ctx.db.resolution.findFirst({
            where: { id: row.requiredResolutionId, companyId },
            select: {
              publicId: true,
              title: true,
              referenceCode: true,
              status: true,
              matterKey: true,
            },
          }),
      ctx.db.unitClass.findFirst({
        where: { id: row.unitClassId, companyId },
        select: { id: true, name: true, kind: true },
      }),
    ]);

    const effectiveOnIfCompleted =
      state.transferNoticeOn === null
        ? null
        : firstOfFollowingMonth(state.transferNoticeOn);

    return {
      publicId: row.publicId,
      ...state,
      unitClassId: row.unitClassId,
      unitClassName: unitClass?.name ?? null,
      fromName: names.get(row.fromStakeholderId) ?? "",
      toName:
        row.toStakeholderId === null
          ? null
          : (names.get(row.toStakeholderId) ?? ""),
      toMemberStatus: completionContext.toMemberStatus,
      proposedPriceCents:
        row.proposedPriceCents === null ? null : Number(row.proposedPriceCents),
      terms: row.terms,
      bonaFideOffer: row.bonaFideOffer,
      managerConsentOn: row.managerConsentOn
        ? utcDateToYmd(row.managerConsentOn)
        : null,
      managerConsentNote: row.managerConsentNote,
      requiredResolution: resolution
        ? {
            publicId: resolution.publicId,
            title: resolution.title,
            referenceCode: resolution.referenceCode,
            status: resolution.status,
            matterKey: resolution.matterKey,
          }
        : null,
      completedAt: row.completedAt,
      cancelledAt: row.cancelledAt,
      cancelReason: row.cancelReason,
      notes: row.notes,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      today,
      effectiveOnIfCompleted,
      /** Transferor's units of the class as of `completionUnitsAsOf` (6 dp). */
      fromUnits: completionContext.fromUnits,
      completionUnitsAsOf: asOf,
      /** Transferor's units of the class today (6 dp). */
      fromUnitsToday,
      completionErrors: completionErrors(state, completionContext),
      admissionErrors: admissionErrors(state),
      deadlines: deadlines.map((d) => ({
        id: d.id,
        ruleKey: d.ruleKey,
        title: d.title,
        section: d.section,
        dueOn: utcDateToYmd(d.dueOn),
        status: d.status,
        completedAt: d.completedAt,
        note: d.note,
      })),
      // A deleted draft leaves the id behind: shown as "not prepared yet".
      noticeCopyReport: report
        ? {
            publicId: report.publicId,
            status: report.status,
            sentAt: report.sentAt,
          }
        : null,
    };
  });
