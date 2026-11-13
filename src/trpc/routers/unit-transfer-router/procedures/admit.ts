import { TRPCError } from "@trpc/server";
import { ymdToUtcDate } from "@/lib/governance/dates";
import { admissionErrors } from "@/lib/governance/transfer-core";
import { Audit } from "@/server/audit";
import { guardedWrite } from "@/server/governance/guarded";
import { admitStakeholder } from "@/server/llc/commitments";
import {
  actorFrom,
  lockCompanyLedgerAndUnitClasses,
} from "@/server/llc/economics/scope";
import { withLlcAccessControl } from "@/trpc/api/trpc";
import { ZUnitTransferAdmitSchema } from "../schema";
import {
  auditContext,
  badRequest,
  companyTodayFor,
  loadLockedTransfer,
  stakeholderNames,
  toTransferState,
  userName,
} from "./shared";

// unitTransfer.admit (03-governance.md G16, session b): admits the transferee
// of a COMPLETED transfer as a Substitute Member (Section 7.8, R36), a
// Manager action (6.16(g) carves out Section 7). Requires the admission
// checklist (`admissionErrors` empty), no earlier admission recorded on the
// transfer, and `effectiveOn <= admittedOn <= today`. FOUNDATION
// `admitStakeholder` sets `memberStatus = MEMBER` and `admittedOn` (an
// earlier stored admission date is kept) with its own audit row; the
// transfer stores `admittedOn` by one single-row guarded update. From then on
// the transferee's units are outstanding for new record dates (R2); frozen
// snapshots are not affected (R13).
//
// Locks: the company ledger and unit-class locks first (admissions and
// snapshots serialise on them, G6), then the transfer's row lock.

export const admitProcedure = withLlcAccessControl
  .meta({ policies: { governance: { allow: ["update"] } } })
  .input(ZUnitTransferAdmitSchema)
  .mutation(async ({ ctx, input }) => {
    const companyId = ctx.membership.companyId;
    const today = companyTodayFor(ctx.company, new Date());

    return await ctx.db.$transaction(async (tx) => {
      await lockCompanyLedgerAndUnitClasses(tx, companyId);
      const row = await loadLockedTransfer(tx, companyId, input.publicId);
      if (row.status !== "COMPLETED") {
        badRequest(
          "Only the transferee of a completed transfer can be admitted (Section 7.8).",
        );
      }
      if (row.admittedOn !== null) {
        badRequest("The transferee has already been admitted.");
      }
      const state = toTransferState(row);
      const errors = admissionErrors(state);
      if (errors.length > 0) badRequest(errors.join("\n"));
      const toStakeholderId = row.toStakeholderId;
      const effectiveOn = state.effectiveOn;
      if (toStakeholderId === null || effectiveOn === null) {
        // A COMPLETED transfer always has both (complete sets them).
        throw new Error(`Completed transfer ${row.id} lacks its transferee.`);
      }
      if (input.admittedOn < effectiveOn) {
        badRequest(
          `The admission date cannot be before the transfer took effect (${effectiveOn}, Section 7.9.1).`,
        );
      }
      if (input.admittedOn > today) {
        badRequest("The admission date cannot be in the future.");
      }

      await admitStakeholder(
        tx,
        {
          companyId,
          stakeholderId: toStakeholderId,
          admittedOn: input.admittedOn,
        },
        actorFrom(ctx),
      );

      const written = await guardedWrite(() =>
        tx.unitTransfer.update({
          where: {
            id: row.id,
            companyId,
            status: "COMPLETED",
            admittedOn: null,
          },
          data: { admittedOn: ymdToUtcDate(input.admittedOn) },
          select: { id: true },
        }),
      );
      if (!written) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "This transfer was changed at the same time. Reload it.",
        });
      }

      const names = await stakeholderNames(tx, companyId, [toStakeholderId]);
      await Audit.create(
        {
          action: "unitTransfer.admitted",
          companyId,
          actor: { type: "user", id: ctx.session.user.id },
          context: auditContext(ctx),
          target: [
            { type: "unitTransfer", id: row.id },
            { type: "stakeholder", id: toStakeholderId },
          ],
          summary: `${userName(ctx)} admitted ${names.get(toStakeholderId) ?? "the transferee"} as a Substitute Member effective ${input.admittedOn} (Section 7.8)`,
        },
        tx,
      );
      return { success: true as const, admittedOn: input.admittedOn };
    });
  });
