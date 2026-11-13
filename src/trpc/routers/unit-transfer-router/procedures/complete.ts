import { TRPCError } from "@trpc/server";
import {
  firstOfFollowingMonth,
  utcDateToYmd,
  type Ymd,
  ymdToUtcDate,
} from "@/lib/governance/dates";
import { completionErrors, displayUnits } from "@/lib/governance/transfer-core";
import { Audit } from "@/server/audit";
import type { PrismaTransactionalClient } from "@/server/db";
import { closeSourceDeadlines } from "@/server/governance/compliance";
import { guardedWrite } from "@/server/governance/guarded";
import { applyUnitTransfer, getPositions } from "@/server/llc/economics";
import { lockCompanyLedgerAndUnitClasses } from "@/server/llc/economics/scope";
import { getSuspendedUnits } from "@/server/llc/economics/suspension";
import {
  getMemberPositions,
  TransferIntegrityError,
} from "@/server/llc/positions";
import { withLlcAccessControl } from "@/trpc/api/trpc";
import { ZUnitTransferCompleteSchema } from "../schema";
import {
  auditContext,
  badRequest,
  buildCompletionContext,
  companyTodayFor,
  loadLockedTransfer,
  stakeholderNames,
  type TransferRow,
  toTransferState,
  userName,
} from "./shared";

// unitTransfer.complete (03-governance.md G16, session b).
//
// One transaction. Locks: ECONOMICS' company ledger lock and the unit-class
// row locks first (`lockCompanyLedgerAndUnitClasses`: no receipt, void,
// admission, distribution or other transfer can commit in between), then the
// transfer's row lock; the row is re-read after the lock.
//
// 1. `effectiveOn = firstOfFollowingMonth(transferNoticeOn)` (R35).
// 2. The completion rules (`completionErrors`) with the transferor's units as
//    of `effectiveOn`, earlier completed transfers deducted.
// 3. Open processes the transfer would break are refused (see
//    `openProcessErrors`).
// 4. ECONOMICS `applyUnitTransfer` (validation only: finalized distribution
//    on or after `effectiveOn`, closed books, units held as of `effectiveOn`).
// 5. Transferee PROSPECT → FINANCIAL_INTEREST_ONLY (R37); an existing Member
//    (checklist guaranteed by rule 8) gets the transfer's `admittedOn` today.
// 6. One single-row guarded update OPEN → COMPLETED. From this commit both
//    position functions fold the transfer in for dates on or after
//    `effectiveOn`: nobody writes ledger rows for a transfer.
// 7. Both readers are re-run on the new state (FOUNDATION positions through
//    the latest completed transfer of the class, ECONOMICS positions with its
//    cross-check for a Preferred transfer); any failure rolls the completion
//    back instead of leaving a ledger every page refuses to read.
// 8. The transfer's deadlines close as NOT_APPLICABLE ("Transfer completed"),
//    except TRANSFER_NOTICE_COPY (the copy is still owed).

type Tx = PrismaTransactionalClient;

export const completeProcedure = withLlcAccessControl
  .meta({ policies: { governance: { allow: ["update"] } } })
  .input(ZUnitTransferCompleteSchema)
  .mutation(async ({ ctx, input }) => {
    const companyId = ctx.membership.companyId;
    const now = new Date();
    const today = companyTodayFor(ctx.company, now);

    return await ctx.db.$transaction(
      async (tx) => {
        await lockCompanyLedgerAndUnitClasses(tx, companyId);
        const row = await loadLockedTransfer(tx, companyId, input.publicId);
        if (row.status !== "OPEN") badRequest("This transfer is closed.");

        // 1–2.
        const state = toTransferState(row);
        const effectiveOn =
          state.transferNoticeOn === null
            ? null
            : firstOfFollowingMonth(state.transferNoticeOn);
        const context = await buildCompletionContext(
          tx,
          companyId,
          row,
          today,
          effectiveOn ?? today,
        );
        const errors = completionErrors({ ...state, effectiveOn }, context);
        const toStakeholderId = row.toStakeholderId;
        if (
          errors.length > 0 ||
          effectiveOn === null ||
          toStakeholderId === null
        ) {
          badRequest(errors.join("\n"));
        }

        // 3.
        const blocked = await openProcessErrors(
          tx,
          companyId,
          row,
          toStakeholderId,
          effectiveOn,
          today,
        );
        if (blocked.length > 0) badRequest(blocked.join("\n"));

        // 4.
        await applyUnitTransfer(tx, {
          companyId,
          unitTransferId: row.id,
          fromStakeholderId: row.fromStakeholderId,
          toStakeholderId,
          unitClassId: row.unitClassId,
          units: state.units,
          effectiveOn: ymdToUtcDate(effectiveOn),
        });

        // 5.
        const transferee = await tx.stakeholder.findFirst({
          where: { id: toStakeholderId, companyId },
          select: { id: true, name: true, memberStatus: true },
        });
        if (!transferee) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Transferee not found.",
          });
        }
        if (transferee.memberStatus === "PROSPECT") {
          const changed = await guardedWrite(() =>
            tx.stakeholder.update({
              where: {
                id: transferee.id,
                companyId,
                memberStatus: "PROSPECT",
              },
              data: { memberStatus: "FINANCIAL_INTEREST_ONLY" },
              select: { id: true },
            }),
          );
          if (!changed) {
            throw new TRPCError({
              code: "CONFLICT",
              message: "The transferee was changed at the same time. Reload.",
            });
          }
          await Audit.create(
            {
              action: "stakeholder.updated",
              companyId,
              actor: { type: "user", id: ctx.session.user.id },
              context: auditContext(ctx),
              target: [{ type: "stakeholder", id: transferee.id }],
              summary: `${userName(ctx)} recorded ${transferee.name} as holder of a Financial Interest only (Section 7.9.2) on completing a unit transfer`,
            },
            tx,
          );
        }
        const admittedOn =
          transferee.memberStatus === "MEMBER" ? ymdToUtcDate(today) : null;

        // 6.
        const completed = await guardedWrite(() =>
          tx.unitTransfer.update({
            where: { id: row.id, companyId, status: "OPEN" },
            data: {
              status: "COMPLETED",
              effectiveOn: ymdToUtcDate(effectiveOn),
              completedAt: now,
              completedById: ctx.membership.memberId,
              ...(admittedOn === null ? {} : { admittedOn }),
            },
            select: { id: true },
          }),
        );
        if (!completed) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "This transfer was changed at the same time. Reload it.",
          });
        }

        // 7.
        await recheckLedger(tx, companyId, row, effectiveOn, today);

        // 8.
        await closeSourceDeadlines(tx, {
          companyId,
          sourceType: "UNIT_TRANSFER",
          sourceId: row.id,
          status: "NOT_APPLICABLE",
          note: "Transfer completed",
          exceptRuleKeys: ["TRANSFER_NOTICE_COPY"],
          completedById: ctx.membership.memberId,
          now,
        });

        const names = await stakeholderNames(tx, companyId, [
          row.fromStakeholderId,
        ]);
        await Audit.create(
          {
            action: "unitTransfer.completed",
            companyId,
            actor: { type: "user", id: ctx.session.user.id },
            context: auditContext(ctx),
            target: [
              { type: "unitTransfer", id: row.id },
              { type: "stakeholder", id: transferee.id },
            ],
            summary: `${userName(ctx)} completed the transfer of ${displayUnits(state.units)} ${row.unitClassKind === "COMMON" ? "Common" : "Preferred"} Units from ${names.get(row.fromStakeholderId) ?? "the transferor"} to ${transferee.name}, effective ${effectiveOn}`,
          },
          tx,
        );

        return {
          success: true as const,
          effectiveOn,
          transfereeStatus:
            transferee.memberStatus === "PROSPECT"
              ? ("FINANCIAL_INTEREST_ONLY" as const)
              : transferee.memberStatus,
          admittedOn: admittedOn === null ? null : today,
        };
      },
      { maxWait: 10_000, timeout: 30_000 },
    );
  });

/**
 * Open processes a completed transfer would break. The plan is silent on
 * them; each is refused with a message naming the Section:
 * - an OPEN default of either party (Section 4.9: forfeiture and credit are
 *   computed on the Defaulting Member's own units and capital);
 * - an overdue Balance of either party with no declared default (the
 *   default to be declared would be computed on units already moved);
 * - a SENT resolution whose record date is on or after `effectiveOn` (its
 *   register was frozen at sending with the transferor holding the units).
 * Closed books and finalized distributions on or after `effectiveOn` are
 * refused by `applyUnitTransfer`. A DRAFT distribution is not refused: it
 * stores only its inputs, and finalizing recomputes from the ledger and
 * refuses figures that changed since review (CONFLICT), so its holders are
 * those of the payment date, the transfer included.
 */
async function openProcessErrors(
  tx: Tx,
  companyId: string,
  row: TransferRow,
  toStakeholderId: string,
  effectiveOn: Ymd,
  today: Ymd,
): Promise<string[]> {
  const parties = [row.fromStakeholderId, toStakeholderId];
  const names = await stakeholderNames(tx, companyId, parties);
  const nameOf = (id: string) => names.get(id) ?? "A party";
  const errors: string[] = [];

  const defaults = await tx.memberDefault.findMany({
    where: { companyId, status: "OPEN", stakeholderId: { in: parties } },
    select: { stakeholderId: true, dueOn: true },
    orderBy: [{ dueOn: "asc" }, { id: "asc" }],
  });
  for (const d of defaults) {
    errors.push(
      `${nameOf(d.stakeholderId)} is in default on the Balance due ${utcDateToYmd(d.dueOn)} (Section 4.9). Cure or void the default before completing the transfer.`,
    );
  }

  const { undeclaredOverdue } = await getSuspendedUnits(tx, companyId, today);
  for (const w of undeclaredOverdue) {
    if (!parties.includes(w.stakeholderId)) continue;
    errors.push(
      `${nameOf(w.stakeholderId)} has an overdue Balance (due ${w.dueOn}) with no declared default. Declare the default (Section 4.9) or record the payment before completing the transfer.`,
    );
  }

  const resolutions = await tx.resolution.findMany({
    where: {
      companyId,
      status: "SENT",
      recordDate: { gte: ymdToUtcDate(effectiveOn) },
    },
    select: { title: true, recordDate: true },
    orderBy: [{ recordDate: "asc" }, { id: "asc" }],
  });
  for (const r of resolutions) {
    if (r.recordDate === null) continue;
    errors.push(
      `The resolution "${r.title}" is out for consent with record date ${utcDateToYmd(r.recordDate)}, on or after this transfer's effective date ${effectiveOn} (Section 7.9.1); its register of holders was fixed when it was sent. Complete the transfer after that resolution has closed.`,
    );
  }

  return [...new Set(errors)];
}

/**
 * Re-runs both holdings readers on the state that now includes the transfer:
 * FOUNDATION `getMemberPositions` for the class through the latest completed
 * transfer of the class (it throws when an already completed transfer no
 * longer finds its units, e.g. one completed earlier with a later effective
 * date), and for a Preferred transfer ECONOMICS `getPositions` with its
 * FOUNDATION cross-check. Errors propagate and roll the completion back.
 */
async function recheckLedger(
  tx: Tx,
  companyId: string,
  row: TransferRow,
  effectiveOn: Ymd,
  today: Ymd,
): Promise<void> {
  const latest = await tx.unitTransfer.findFirst({
    where: {
      companyId,
      unitClassId: row.unitClassId,
      status: "COMPLETED",
      effectiveOn: { not: null },
    },
    orderBy: { effectiveOn: "desc" },
    select: { effectiveOn: true },
  });
  const latestOn =
    latest?.effectiveOn == null
      ? effectiveOn
      : utcDateToYmd(latest.effectiveOn);
  const dates = [...new Set([effectiveOn, today, latestOn])]
    .filter((d) => d >= effectiveOn)
    .sort();
  for (const asOf of dates) {
    try {
      await getMemberPositions(tx, companyId, {
        asOf,
        unitClassId: row.unitClassId,
      });
    } catch (error) {
      // Only the fold-in's own integrity error becomes a refusal; anything
      // else (a database error) propagates as it is.
      if (error instanceof TransferIntegrityError) {
        const other = error.transfer;
        const names = await stakeholderNames(tx, companyId, [
          other?.fromStakeholderId ?? null,
          other?.toStakeholderId ?? null,
        ]);
        badRequest(
          other
            ? `Completing this transfer would leave ${names.get(other.fromStakeholderId) ?? "the transferor"} without the ${displayUnits(other.units)} units already transferred to ${names.get(other.toStakeholderId) ?? "another holder"} effective ${other.effectiveOn} (Section 7.9.1).`
            : "Completing this transfer would leave a holder with fewer units than its completed transfers moved (Section 7.9.1).",
        );
      }
      throw error;
    }
    if (row.unitClassKind === "PREFERRED") {
      await getPositions(tx, companyId, asOf);
    }
  }
}
