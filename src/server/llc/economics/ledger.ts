import "server-only";

import { TRPCError } from "@trpc/server";
import { toDateOnly } from "@/lib/date-only";
import type { LlcEconomicsConfig } from "@/lib/llc/config";
import { compareIso, type IsoDate } from "@/lib/llc/dates";
import {
  type Cents,
  type MicroUnits,
  microUnitsFromDecimal,
} from "@/lib/llc/money";
import {
  computePositions,
  type LedgerEvent,
  type PositionOptions,
  type PositionsResult,
} from "@/lib/llc/positions";
import type { WaterfallHolder } from "@/lib/llc/waterfall";
import type { TPrismaOrTransaction } from "@/server/db";
import { getMemberPositions } from "@/server/llc/positions";
import { unitsToWire } from "@/server/llc/serialize";
import {
  buildLedgerEvents,
  buildWaterfallHolders,
  findLedgerMismatches,
  type LedgerReceipt,
  netAllocations,
  type RawLedgerItem,
  receiptsToEvents,
} from "./ledger.logic";
import { notFound, ruleViolation } from "./scope";
import { getEconomicsContext } from "./term";
import { loadCompletedTransfers } from "./transfers";

type Tx = TPrismaOrTransaction;

export interface LoadedLedger {
  events: LedgerEvent[]; // Preferred class only, seq assigned
  holders: Map<
    string,
    {
      stakeholderId: string;
      name: string;
      isInsider: boolean;
      memberStatus: string;
      noticeEmail: string | null;
    }
  >;
  commonUnits: Map<string, MicroUnits>; // stakeholderId → Common Units as of the requested date; set by getPositions from getMemberPositions (kind COMMON), never summed from receipts here
  cashCapital: { on: IsoDate; amount: Cents }[]; // appliedCents of non-void INITIAL / BALANCE / REPLACEMENT receipts (cash that became capital)
  lastEventOn: IsoDate | null;
}

const CASH_KINDS = new Set(["INITIAL", "BALANCE", "REPLACEMENT"]);

/**
 * Database rows → library events (Preferred class only). `commonUnits` is
 * left empty: `getPositions` fills it from `getMemberPositions`.
 */
export async function loadLedger(
  tx: Tx,
  companyId: string,
  _config: LlcEconomicsConfig,
): Promise<LoadedLedger> {
  const stakeholders = await tx.stakeholder.findMany({
    where: { companyId },
    select: {
      id: true,
      name: true,
      institutionName: true,
      isInsider: true,
      memberStatus: true,
      noticeEmail: true,
      email: true,
    },
  });
  const preferred = await tx.unitClass.findFirst({
    where: { companyId, kind: "PREFERRED" },
    select: { id: true },
  });
  if (!preferred) {
    ruleViolation("The company has no Preferred unit class.");
  }
  const receipts = await tx.capitalReceipt.findMany({
    where: {
      companyId,
      unitClassId: preferred.id,
      voidedAt: null,
      appliedOn: { not: null },
    },
    orderBy: [{ appliedOn: "asc" }, { createdAt: "asc" }],
    select: {
      id: true,
      stakeholderId: true,
      kind: true,
      receivedOn: true,
      appliedOn: true,
      appliedCents: true,
      unitsIssued: true,
      prefReturnStartDate: true,
      createdAt: true,
    },
  });
  const allocations = await tx.callNoticeAllocation.findMany({
    where: { companyId },
    select: {
      capitalReceiptId: true,
      amountCents: true,
      prefReturnStartOn: true,
    },
  });
  const distributions = await tx.distribution.findMany({
    where: { companyId, status: "FINALIZED", isReversal: false },
    select: {
      id: true,
      number: true,
      paymentDate: true,
      createdAt: true,
      lines: {
        select: {
          id: true,
          stakeholderId: true,
          tierCCents: true,
          tierDCents: true,
        },
      },
    },
  });
  const transfers = await loadCompletedTransfers(tx, companyId);
  const offsets = await tx.memberDefaultPayment.findMany({
    where: {
      companyId,
      source: "DISTRIBUTION_OFFSET",
      capitalReceiptId: { not: null },
    },
    select: { capitalReceiptId: true, distributionLineId: true },
  });

  // Receipts created by a distribution's §4.9(iii) offset.
  const distributionOfLine = new Map<string, string>();
  for (const d of distributions) {
    for (const line of d.lines) distributionOfLine.set(line.id, d.id);
  }
  const offsetReceiptDistribution = new Map<string, string>();
  for (const o of offsets) {
    if (o.capitalReceiptId === null || o.distributionLineId === null) continue;
    const distributionId = distributionOfLine.get(o.distributionLineId);
    if (distributionId) {
      offsetReceiptDistribution.set(o.capitalReceiptId, distributionId);
    }
  }

  const ledgerReceipts: LedgerReceipt[] = [];
  const cashCapital: { on: IsoDate; amount: Cents }[] = [];
  for (const r of receipts) {
    if (r.appliedOn === null) continue; // filtered above
    const appliedOn = toDateOnly(r.appliedOn);
    ledgerReceipts.push({
      id: r.id,
      stakeholderId: r.stakeholderId,
      kind: r.kind,
      receivedOn: toDateOnly(r.receivedOn),
      appliedOn,
      appliedCents: r.appliedCents,
      unitsIssued: microUnitsFromDecimal(unitsToWire(r.unitsIssued)),
      prefReturnStartDate:
        r.prefReturnStartDate === null
          ? null
          : toDateOnly(r.prefReturnStartDate),
      createdAt: r.createdAt,
    });
    if (CASH_KINDS.has(r.kind) && r.appliedCents > 0n) {
      cashCapital.push({ on: appliedOn, amount: r.appliedCents });
    }
  }

  const raw: RawLedgerItem[] = receiptsToEvents(
    ledgerReceipts,
    offsetReceiptDistribution,
  );
  for (const d of distributions) {
    raw.push({
      type: "DISTRIBUTION",
      id: d.id,
      on: toDateOnly(d.paymentDate),
      createdAt: d.createdAt,
      number: d.number ?? 0,
      lines: d.lines
        .filter((l) => l.tierCCents !== 0n || l.tierDCents !== 0n)
        .map((l) => ({
          holderId: l.stakeholderId,
          tierC: l.tierCCents,
          tierD: l.tierDCents,
        })),
    });
  }
  for (const t of transfers) {
    raw.push({
      type: "TRANSFER",
      id: t.id,
      on: t.effectiveOn,
      createdAt: t.createdAt,
      fromHolderId: t.fromStakeholderId,
      toHolderId: t.toStakeholderId,
      units: t.units,
    });
  }

  const events = buildLedgerEvents(
    raw,
    netAllocations(
      allocations.map((a) => ({
        capitalReceiptId: a.capitalReceiptId,
        amountCents: a.amountCents,
        prefReturnStartOn: toDateOnly(a.prefReturnStartOn),
      })),
    ),
  );

  let lastEventOn: IsoDate | null = null;
  for (const e of events) {
    if (lastEventOn === null || compareIso(e.on, lastEventOn) > 0) {
      lastEventOn = e.on;
    }
  }

  return {
    events,
    holders: new Map(
      stakeholders.map((s) => [
        s.id,
        {
          stakeholderId: s.id,
          name: s.name,
          isInsider: s.isInsider,
          memberStatus: s.memberStatus,
          noticeEmail: s.noticeEmail ?? s.email,
        },
      ]),
    ),
    commonUnits: new Map(),
    cashCapital,
    lastEventOn,
  };
}

/** R8 windows, used when `accrueOnDefaulterCapital` is false: one per non-voided default. */
async function loadAccrualPauses(
  tx: Tx,
  companyId: string,
): Promise<NonNullable<PositionOptions["accrualPauses"]>> {
  const defaults = await tx.memberDefault.findMany({
    where: { companyId, status: { not: "VOIDED" } },
    select: { stakeholderId: true, dueOn: true, curedOn: true },
  });
  return defaults.map((d) => ({
    holderId: d.stakeholderId,
    from: toDateOnly(d.dueOn),
    to: d.curedOn === null ? null : toDateOnly(d.curedOn),
  }));
}

/**
 * Balances as of any date. With `untilSeq`, events on `asOf` with
 * `seq >= untilSeq` are excluded and the FOUNDATION cross-check is skipped.
 */
export async function getPositions(
  tx: Tx,
  companyId: string,
  asOf: IsoDate,
  opts?: { untilSeq?: number },
): Promise<{
  ledger: LoadedLedger;
  positions: PositionsResult;
  waterfallHolders: WaterfallHolder[];
  config: LlcEconomicsConfig;
}> {
  const company = await tx.company.findFirst({
    where: { id: companyId },
    select: { id: true, timezone: true },
  });
  if (!company) notFound("Company");
  const { config } = await getEconomicsContext(tx, company);
  const ledger = await loadLedger(tx, companyId, config);

  const memberPositions = await getMemberPositions(tx, companyId, { asOf });
  for (const row of memberPositions) {
    if (row.kind !== "COMMON") continue;
    ledger.commonUnits.set(
      row.stakeholderId,
      (ledger.commonUnits.get(row.stakeholderId) ?? 0n) +
        microUnitsFromDecimal(row.units),
    );
  }

  const accrualPauses = config.accrueOnDefaulterCapital
    ? []
    : await loadAccrualPauses(tx, companyId);
  const positions = computePositions(ledger.events, asOf, config, {
    untilSeq: opts?.untilSeq,
    accrualPauses,
  });

  if (opts?.untilSeq === undefined) {
    const mismatches = findLedgerMismatches(
      positions,
      memberPositions
        .filter((row) => row.kind === "PREFERRED")
        .map((row) => ({
          stakeholderId: row.stakeholderId,
          units: microUnitsFromDecimal(row.units),
          capitalCents: row.capitalCents,
        })),
    );
    if (mismatches.length > 0) {
      const names = mismatches.map((id) => ledger.holders.get(id)?.name ?? id);
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: `Ledger mismatch for ${names.join(", ")}`,
      });
    }
  }

  return {
    ledger,
    positions,
    waterfallHolders: buildWaterfallHolders(positions, ledger.commonUnits),
    config,
  };
}
