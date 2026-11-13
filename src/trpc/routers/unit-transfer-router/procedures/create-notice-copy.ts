import { TRPCError } from "@trpc/server";
import { generatePublicId } from "@/common/id";
import { formatDateOnly } from "@/lib/date-only";
import { utcDateToYmd } from "@/lib/governance/dates";
import {
  defaultReportTitle,
  EMPTY_FIGURES,
} from "@/lib/governance/report-figures";
import { displayUnits } from "@/lib/governance/transfer-core";
import { formatCents } from "@/lib/money";
import { Audit } from "@/server/audit";
import { guardedWrite } from "@/server/governance/guarded";
import { withLlcAccessControl } from "@/trpc/api/trpc";
import { ZUnitTransferCreateNoticeCopySchema } from "../schema";
import {
  auditContext,
  badRequest,
  loadLockedTransfer,
  stakeholderNames,
  upsertTransferDeadline,
  userName,
} from "./shared";

// unitTransfer.createNoticeCopy (03-governance.md G16): prepares the copy of
// the Transfer Notice (7.1) or of the notice of an Involuntary Transfer (7.2)
// that the Manager delivers to the other Preferred Members within 5 business
// days.
//
// Creates a DRAFT `MemberReport` of type NOTICE linked to the transfer's
// TRANSFER_NOTICE_COPY deadline, with the commentary prefilled, and stores it
// as the transfer's `noticeCopyReportId`. The Manager user attaches the notice
// and sends the report from the report page; `memberReport.send` restricts
// the recipients to the other Preferred Members and marks the deadline DONE
// (G12). A draft deleted on the report page leaves its id behind; that is
// treated as "not prepared yet", so the copy can be prepared again.

function paragraph(text: string) {
  return {
    type: "paragraph",
    props: {},
    content: [{ type: "text", text, styles: {} }],
    children: [],
  };
}

export const createNoticeCopyProcedure = withLlcAccessControl
  .meta({ policies: { governance: { allow: ["create"] } } })
  .input(ZUnitTransferCreateNoticeCopySchema)
  .mutation(async ({ ctx, input }) => {
    const companyId = ctx.membership.companyId;

    return await ctx.db.$transaction(async (tx) => {
      const row = await loadLockedTransfer(tx, companyId, input.publicId);
      if (row.kind !== "VOLUNTARY" && row.kind !== "INVOLUNTARY") {
        badRequest(
          "Only a voluntary or involuntary transfer is copied to the other Preferred Members (Sections 7.1, 7.2).",
        );
      }
      if (row.status !== "OPEN") badRequest("This transfer is closed.");
      const previousReportId = row.noticeCopyReportId;
      if (previousReportId !== null) {
        const existing = await tx.memberReport.findFirst({
          where: { id: previousReportId, companyId },
          select: { id: true },
        });
        if (existing) badRequest("The copy has already been prepared.");
      }

      const involuntary = row.kind === "INVOLUNTARY";
      const noticeKind = involuntary
        ? "INVOLUNTARY_TRANSFER"
        : "TRANSFER_NOTICE_COPY";
      const names = await stakeholderNames(tx, companyId, [
        row.fromStakeholderId,
        row.toStakeholderId,
      ]);
      const fromName = names.get(row.fromStakeholderId) ?? "";
      const toName =
        row.toStakeholderId === null
          ? "not named"
          : (names.get(row.toStakeholderId) ?? "not named");

      // The deadline the report satisfies (created by `create`; recreated
      // here if it is missing, which is idempotent).
      if (row.noticeCopyDueOn === null || row.managerRofrEndsOn === null) {
        badRequest("This transfer has no notice-copy period.");
      }
      const deadlineId = await upsertTransferDeadline(tx, {
        companyId,
        transferId: row.id,
        kind: row.kind,
        fromName,
        rule: "TRANSFER_NOTICE_COPY",
        dueOn: utcDateToYmd(row.noticeCopyDueOn),
      });

      const price =
        row.proposedPriceCents === null
          ? null
          : formatCents(row.proposedPriceCents);
      // The sentence supplies its own full stop.
      const terms = row.terms?.trim().replace(/[.\s]+$/, "") || null;
      const priceAndTerms =
        price !== null && terms !== null
          ? `${price}; ${terms}`
          : (price ?? terms ?? "see attached");
      const classWord = row.unitClassKind === "COMMON" ? "Common" : "Preferred";
      const memberRofrEndsOn = row.memberRofrEndsOn
        ? formatDateOnly(utcDateToYmd(row.memberRofrEndsOn))
        : "";
      const commentary = [
        paragraph(
          `Under Section ${involuntary ? "7.2" : "7.1"} of the Operating Agreement the Manager delivers this copy of a ${involuntary ? "notice of an Involuntary Transfer" : "Transfer Notice"} received on ${formatDateOnly(utcDateToYmd(row.noticeReceivedOn))}.`,
        ),
        paragraph(
          `Transferring Member: ${fromName}. Units: ${displayUnits(row.units.toFixed(6))} ${classWord} Units. Proposed transferee: ${toName}. Proposed price and terms: ${priceAndTerms}.`,
        ),
        paragraph(
          `The Manager (or its designee) may ${involuntary ? "exercise a purchase option" : "exercise a right of first refusal"} until ${formatDateOnly(utcDateToYmd(row.managerRofrEndsOn))}; if it does not, the other Preferred Members may do so, in proportion to their Preferred Units, until ${memberRofrEndsOn}.`,
        ),
      ];

      const title = defaultReportTitle({ type: "NOTICE", noticeKind });
      const report = await tx.memberReport.create({
        data: {
          publicId: generatePublicId(),
          companyId,
          type: "NOTICE",
          status: "DRAFT",
          title,
          noticeKind,
          relatedType: "COMPLIANCE_DEADLINE",
          relatedId: deadlineId,
          figures: EMPTY_FIGURES as object,
          commentary,
          authorId: ctx.membership.memberId,
        },
        select: { id: true, publicId: true },
      });

      const linked = await guardedWrite(() =>
        tx.unitTransfer.update({
          where: {
            id: row.id,
            companyId,
            status: "OPEN",
            noticeCopyReportId: previousReportId,
          },
          data: { noticeCopyReportId: report.id },
          select: { id: true },
        }),
      );
      if (!linked) {
        // Throwing rolls the report back with it.
        throw new TRPCError({
          code: "CONFLICT",
          message: "This transfer was changed at the same time. Reload it.",
        });
      }

      await Audit.create(
        {
          action: "unitTransfer.updated",
          companyId,
          actor: { type: "user", id: ctx.session.user.id },
          context: auditContext(ctx),
          target: [
            { type: "unitTransfer", id: row.id },
            { type: "memberReport", id: report.id },
          ],
          summary: `${userName(ctx)} prepared the draft "${title}" for the transfer by ${fromName}`,
        },
        tx,
      );
      return { reportPublicId: report.publicId };
    });
  });
