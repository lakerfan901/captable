import "server-only";

import { TRPCError } from "@trpc/server";
import { fromDateOnly, toDateOnly } from "@/lib/date-only";
import type { IsoDate } from "@/lib/llc/dates";
import {
  type MonthKey,
  monthsBetween,
  periodKey,
  periodLabel,
} from "@/lib/llc/financial-periods";
import {
  canonicalJson,
  compareFundMonths,
  compareHolderMonths,
  type FundMonth,
  fundMonthFromJson,
  fundMonthToJson,
  type HolderMonth,
  holderMonthFromJson,
  holderMonthToJson,
} from "@/lib/llc/financial-series";
import { buildSeries } from "@/lib/llc/financial-series-build";
import {
  monthsToSnapshot,
  nextVersion,
  restateRangeProblem,
} from "@/lib/llc/financial-snapshot-core";
import { LlcMathError } from "@/lib/llc/money";
import { Audit } from "@/server/audit";
import type { PrismaTransactionalClient } from "@/server/db";
import { guardedWrite } from "@/server/governance/guarded";
import { sha256Hex } from "@/server/governance/hash";
import { lockCompanyLedgerAndUnitClasses } from "@/server/llc/economics/scope";
import {
  loadSeriesBase,
  type SeriesBase,
  withFacts,
} from "@/server/llc/economics/series-input";
import { firstSnapshotMonth, latestSnapshotMonth } from "./financial-snapshots";

// Writing the financial snapshots (04-investor-portal.md P34, P35, 5.9
// "Writing snapshots"; package P13a).
//
// Lock order, the same as `memberReport.release`: the company ledger lock
// (`lockCompanyLedger`, an advisory lock every economics write takes first),
// then the unit-class row locks, then (release only) the report row lock.
// Every writer of snapshot rows holds the ledger lock, so two releases, two
// restatements, or a release and a restatement of one company run one after
// the other and see each other's rows; that is what keeps "one current row
// per month" true (the unique key is (company, month, version), not
// (company, month)). Rows are only ever inserted, or marked superseded by a
// single-row guarded update; never deleted.

type Tx = PrismaTransactionalClient;

function series(
  input: Parameters<typeof buildSeries>[0],
  range: { from: MonthKey; to: MonthKey },
) {
  try {
    return buildSeries(input, range);
  } catch (error) {
    if (error instanceof LlcMathError) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `The monthly figures could not be computed: ${error.message} (${error.code}).`,
      });
    }
    throw error;
  }
}

function fundRow(m: FundMonth) {
  if (m.inProgress) {
    // Never store a month that has not ended (its figures are not final).
    throw new Error(`Refusing to snapshot the month in progress ${m.month}`);
  }
  const json = fundMonthToJson(m);
  return { json, dataHash: sha256Hex(canonicalJson(json)) };
}

/** The highest version of any row (fund or holder) per month of the company. */
async function versionsByMonth(
  tx: Tx,
  companyId: string,
  months: readonly MonthKey[],
): Promise<Map<MonthKey, number[]>> {
  const dates = months.map((m) => fromDateOnly(m));
  const [fund, holder] = await Promise.all([
    tx.financialSnapshot.groupBy({
      by: ["month"],
      where: { companyId, month: { in: dates } },
      _max: { version: true },
    }),
    tx.holderFinancialSnapshot.groupBy({
      by: ["month"],
      where: { companyId, month: { in: dates } },
      _max: { version: true },
    }),
  ]);
  const out = new Map<MonthKey, number[]>();
  for (const r of [...fund, ...holder]) {
    const key = toDateOnly(r.month);
    const list = out.get(key) ?? [];
    if (r._max.version !== null) list.push(r._max.version);
    out.set(key, list);
  }
  return out;
}

async function insertMonths(
  tx: Tx,
  args: {
    companyId: string;
    fundMonths: readonly FundMonth[];
    holderMonths: readonly HolderMonth[];
    version: (month: MonthKey) => number;
    sourceReportId: string | null;
    restateReason: string | null;
    frozenById: string;
    now: Date;
  },
): Promise<number> {
  const months = new Set(args.fundMonths.map((m) => m.month));
  await tx.financialSnapshot.createMany({
    data: args.fundMonths.map((m) => {
      const { json, dataHash } = fundRow(m);
      return {
        companyId: args.companyId,
        month: fromDateOnly(m.month),
        version: args.version(m.month),
        sourceReportId: args.sourceReportId,
        restateReason: args.restateReason,
        data: json,
        dataHash,
        frozenAt: args.now,
        frozenById: args.frozenById,
      };
    }),
  });
  const holders = args.holderMonths.filter((h) => months.has(h.month));
  if (holders.length > 0) {
    await tx.holderFinancialSnapshot.createMany({
      data: holders.map((h) => {
        if (h.inProgress) {
          throw new Error(
            `Refusing to snapshot the month in progress ${h.month}`,
          );
        }
        return {
          companyId: args.companyId,
          stakeholderId: h.holderId,
          month: fromDateOnly(h.month),
          version: args.version(h.month),
          data: holderMonthToJson(h),
          frozenAt: args.now,
        };
      }),
    });
  }
  return holders.length;
}

export interface SnapshotWriteResult {
  /** the months written (empty when the period was already covered or the ledger has no row) */
  months: MonthKey[];
  holderRows: number;
}

/**
 * P34: at the release of a quarterly or annual report, one fund row per
 * month and one row per holder with a position or a movement in the month,
 * for every month after the latest current snapshot (from inception when
 * there is none) through the last whole month of `periodEnd`. A month that
 * already has a current row is never overwritten.
 *
 * The CALLER holds the company ledger lock (release: inside its transaction,
 * after the books are closed). `today` is the release's "today": every month
 * written ends before it.
 */
export async function writeSnapshotsThrough(
  tx: Tx,
  companyId: string,
  periodEnd: IsoDate,
  opts: { reportId: string; memberId: string; today: IsoDate; now: Date },
): Promise<SnapshotWriteResult> {
  const latest = await latestSnapshotMonth(tx, companyId);
  let base: SeriesBase | null = null;
  let months: MonthKey[];
  if (latest !== null) {
    // Cheap exit (an annual report after Q4): no ledger read.
    months = monthsToSnapshot({
      latestSnapshotMonth: latest,
      inception: null,
      periodEnd,
    });
  } else {
    base = await loadSeriesBase(tx, companyId, { today: opts.today });
    months = monthsToSnapshot({
      latestSnapshotMonth: null,
      inception: base.inception,
      periodEnd,
    });
  }
  if (months.length === 0) return { months: [], holderRows: 0 };
  base ??= await loadSeriesBase(tx, companyId, { today: opts.today });

  const range = { from: months[0] as MonthKey, to: months.at(-1) as MonthKey };
  const built = series(await withFacts(tx, base, range), range);
  const versions = await versionsByMonth(tx, companyId, months);
  const holderRows = await insertMonths(tx, {
    companyId,
    fundMonths: built.fundMonths,
    holderMonths: built.holderMonths,
    version: (m) => nextVersion(versions.get(m) ?? []),
    sourceReportId: opts.reportId,
    restateReason: null,
    frozenById: opts.memberId,
    now: opts.now,
  });
  return { months, holderRows };
}

export interface RestateActor {
  userId: string;
  userName: string;
  memberId: string;
  requestIp: string;
  userAgent: string;
}

export interface RestatedMonth {
  month: MonthKey;
  /** the version now current */
  version: number;
  /** fund fields that changed (dotted paths, `compareFundMonths`) */
  fundFields: string[];
  /** holders whose record changed, appeared or disappeared */
  holdersChanged: number;
}

export interface RestateResult {
  months: RestatedMonth[];
  /** months of the range whose snapshots already equal the ledger (left as they are) */
  unchanged: MonthKey[];
}

export const RESTATE_REASON_MIN = 10;
export const RESTATE_REASON_MAX = 500;

const monthLabel = (m: MonthKey) => periodLabel(periodKey(m, "month"));

function badRequest(message: string): never {
  throw new TRPCError({ code: "BAD_REQUEST", message });
}

/**
 * P35: Restate. Takes the company ledger lock and the unit-class locks,
 * recomputes [fromMonth, toMonth] from the ledger and, for each month whose
 * fund or holder records differ from the current snapshot, marks the current
 * rows superseded (kept) and writes version + 1. Months that already equal
 * the ledger are left alone, so investors see "Restated on" only where a
 * figure changed; a range in which nothing changed is refused. Refuses months
 * after the latest current snapshot, months before the earlier of the first
 * snapshot and inception, a back-dated range before the first snapshot that
 * does not reach it, and months that have not ended (`restateRangeProblem`).
 * Writes the audit row `financials.restated` in the same transaction.
 *
 * Takes its own locks: call it first in a transaction opened with release's
 * bounds (`{ maxWait: 10_000, timeout: 60_000 }`); Prisma's default 5-second
 * timeout is too short for a range of many months.
 */
export async function restateSnapshots(
  tx: Tx,
  args: {
    companyId: string;
    fromMonth: string;
    toMonth: string;
    reason: string;
    actor: RestateActor;
    now?: Date;
  },
): Promise<RestateResult> {
  const { companyId } = args;
  const reason = args.reason.trim();
  if (
    reason.length < RESTATE_REASON_MIN ||
    reason.length > RESTATE_REASON_MAX
  ) {
    badRequest(
      `The reason must be ${RESTATE_REASON_MIN} to ${RESTATE_REASON_MAX} characters.`,
    );
  }
  const now = args.now ?? new Date();

  await lockCompanyLedgerAndUnitClasses(tx, companyId);
  const latest = await latestSnapshotMonth(tx, companyId);
  const first = await firstSnapshotMonth(tx, companyId);
  const base = await loadSeriesBase(tx, companyId);
  const problem = restateRangeProblem({
    fromMonth: args.fromMonth,
    toMonth: args.toMonth,
    firstSnapshotMonth: first,
    latestSnapshotMonth: latest,
    inception: base.inception,
    today: base.today,
  });
  if (problem !== null) badRequest(problem);
  const range = { from: args.fromMonth, to: args.toMonth };
  const months = monthsBetween(range.from, range.to);
  const built = series(await withFacts(tx, base, range), range);

  const dates = months.map((m) => fromDateOnly(m));
  const [fundRows, holderRows] = await Promise.all([
    tx.financialSnapshot.findMany({
      where: { companyId, supersededAt: null, month: { in: dates } },
      select: { id: true, month: true, data: true },
    }),
    tx.holderFinancialSnapshot.findMany({
      where: { companyId, supersededAt: null, month: { in: dates } },
      select: { id: true, month: true, stakeholderId: true, data: true },
    }),
  ]);
  const fundByMonth = new Map(fundRows.map((r) => [toDateOnly(r.month), r]));

  const changed: {
    month: MonthKey;
    fundFields: string[];
    holdersChanged: number;
  }[] = [];
  const unchanged: MonthKey[] = [];
  for (const month of months) {
    const next = built.fundMonths.find((m) => m.month === month);
    if (!next) throw new Error(`No computed record for ${month}`);
    const current = fundByMonth.get(month);
    const fundFields = current
      ? compareFundMonths(fundMonthFromJson(current.data), next)
      : ["*"];
    const oldHolders = new Map(
      holderRows
        .filter((r) => toDateOnly(r.month) === month)
        .map((r) => [r.stakeholderId, holderMonthFromJson(r.data)]),
    );
    const newHolders = new Map(
      built.holderMonths
        .filter((h) => h.month === month)
        .map((h) => [h.holderId, h]),
    );
    let holdersChanged = 0;
    for (const id of new Set([...oldHolders.keys(), ...newHolders.keys()])) {
      const a = oldHolders.get(id);
      const b = newHolders.get(id);
      if (!a || !b || compareHolderMonths(a, b).length > 0) holdersChanged++;
    }
    if (fundFields.length === 0 && holdersChanged === 0) unchanged.push(month);
    else changed.push({ month, fundFields, holdersChanged });
  }
  if (changed.length === 0) {
    badRequest(
      "Nothing to restate: the published figures of these months equal the ledger.",
    );
  }

  // Supersede the current rows of the changed months (single-row guarded
  // updates; under the ledger lock nobody else writes them).
  const changedSet = new Set(changed.map((c) => c.month));
  const conflict = () => {
    throw new TRPCError({
      code: "CONFLICT",
      message: "The snapshots changed while restating. Try again.",
    });
  };
  for (const r of fundRows) {
    if (!changedSet.has(toDateOnly(r.month))) continue;
    const ok = await guardedWrite(() =>
      tx.financialSnapshot.update({
        where: { id: r.id, supersededAt: null },
        data: { supersededAt: now },
        select: { id: true },
      }),
    );
    if (!ok) conflict();
  }
  for (const r of holderRows) {
    if (!changedSet.has(toDateOnly(r.month))) continue;
    const ok = await guardedWrite(() =>
      tx.holderFinancialSnapshot.update({
        where: { id: r.id, supersededAt: null },
        data: { supersededAt: now },
        select: { id: true },
      }),
    );
    if (!ok) conflict();
  }

  const versions = await versionsByMonth(tx, companyId, [...changedSet]);
  const versionOf = new Map(
    [...changedSet].map((m) => [m, nextVersion(versions.get(m) ?? [])]),
  );
  await insertMonths(tx, {
    companyId,
    fundMonths: built.fundMonths.filter((m) => changedSet.has(m.month)),
    holderMonths: built.holderMonths.filter((h) => changedSet.has(h.month)),
    version: (m) => versionOf.get(m) ?? 1,
    sourceReportId: null,
    restateReason: reason,
    frozenById: args.actor.memberId,
    now,
  });

  const labels = changed.map((c) => monthLabel(c.month)).join(", ");
  await Audit.create(
    {
      action: "financials.restated",
      companyId,
      actor: { type: "user", id: args.actor.userId },
      context: {
        requestIp: args.actor.requestIp,
        userAgent: args.actor.userAgent,
      },
      target: [{ type: "company", id: companyId }],
      summary: `${args.actor.userName} restated the published financial figures of ${labels}${
        unchanged.length > 0
          ? ` (unchanged: ${unchanged.map(monthLabel).join(", ")})`
          : ""
      }. Reason: ${reason}`,
    },
    tx,
  );

  return {
    months: changed.map((c) => ({
      month: c.month,
      version: versionOf.get(c.month) ?? 1,
      fundFields: c.fundFields,
      holdersChanged: c.holdersChanged,
    })),
    unchanged,
  };
}
