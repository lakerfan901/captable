import "server-only";

import { TRPCError } from "@trpc/server";
import { fromDateOnly, toDateOnly } from "@/lib/date-only";
import { compareIso, type IsoDate } from "@/lib/llc/dates";
import { dashboardPeriods, driftOf } from "@/lib/llc/financial-dashboard-core";
import {
  type MonthKey,
  monthEnd,
  monthOf,
  monthsBetween,
} from "@/lib/llc/financial-periods";
import {
  type FundMonth,
  type FundMonthJson,
  fundMonthToJson,
  type HolderMonth,
  holderMonthFromJson,
} from "@/lib/llc/financial-series";
import { buildSeries } from "@/lib/llc/financial-series-build";
import { LlcMathError } from "@/lib/llc/money";
import type { TPrismaOrTransaction } from "@/server/db";
import {
  firstSnapshotMonth,
  latestSnapshotMonth,
  readFundMonths,
} from "@/server/portal/financial-snapshots";
import {
  emptyView,
  type FinancialView,
  readTermClock,
  releasedPeriodReports,
  zoneOf,
} from "@/server/portal/financial-view";
import { loadSeriesBase, withFacts } from "./series-input";

// The team's live dashboard and the drift status (04-investor-portal.md 5.9
// "Procedures": `financialDashboard.live` and `.status`, P39; package P13b).
// Both compute month records from the ledger with the same loader
// (`series-input`) and builder (`buildSeries`) that write the snapshots at
// release, so "live" for a past month is what Release or Restate would store
// for it now. Team side only: no portal procedure imports this file (S26).

type Tx = TPrismaOrTransaction;

function build(
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

/**
 * P39 Live: every month from the ledger's inception through the month of
 * `through` (default: the economics "today"; a later date is cut to today),
 * computed now. "Today" stays the economics today whatever `through` is: a
 * past month is shown whole (to its month end) and the current month is
 * marked in progress (`inProgress`, figures as of today). No holder records
 * and no restatements: the live view has neither.
 */
export async function liveFinancialView(
  tx: Tx,
  companyId: string,
  company: { timezone: string | null },
  opts: { through?: IsoDate } = {},
): Promise<FinancialView> {
  const timeZone = zoneOf(company);
  const base = await loadSeriesBase(tx, companyId);
  const termClock = await readTermClock(tx, companyId);
  const limit =
    opts.through !== undefined && compareIso(opts.through, base.today) < 0
      ? opts.through
      : base.today;
  const inception = base.inception;
  const to = monthOf(limit);
  if (inception === null || compareIso(to, inception) < 0) {
    return { ...emptyView(timeZone), inceptionMonth: inception, termClock };
  }
  const range = { from: inception, to };
  const built = build(await withFacts(tx, base, range), range);
  const reports = await releasedPeriodReports(tx, companyId);
  const last = built.fundMonths.at(-1) as FundMonth;
  // A month in progress has not ended: its quarter is not a whole period yet.
  const ended = built.fundMonths.filter((m) => !m.inProgress);
  return {
    publishedThrough: last.asOf,
    inceptionMonth: inception,
    timeZone,
    fundMonths: built.fundMonths.map(fundMonthToJson),
    holderMonths: [],
    periods: dashboardPeriods(
      ended.map((m) => m.month),
      reports,
    ),
    restatements: [],
    termClock,
  };
}

export interface StatusDriftHolder {
  stakeholderId: string;
  name: string;
  /** holder fields that differ, or ["*"] when the record appeared or disappeared */
  fields: string[];
}

export interface StatusDrift {
  month: MonthKey;
  /** fund fields that differ (dotted paths), or ["*"] when the month has no snapshot yet */
  fields: string[];
  /** holders whose own record differs (team side: ids and names) */
  holders: StatusDriftHolder[];
  /** the published record (null: none) and the ledger's record today, for the Restate dialog */
  published: FundMonthJson | null;
  ledger: FundMonthJson;
}

export interface FinancialStatus {
  /** last day of the latest snapshot month, or null before the first release */
  snapshotThrough: IsoDate | null;
  booksClosedThrough: IsoDate | null;
  /**
   * Months whose current snapshots differ from the ledger today: exactly the
   * months a Restate of [first, latest] would rewrite (fund records and every
   * holder record; months between the ledger's inception and the first
   * snapshot count when the ledger now has figures there).
   */
  drift: StatusDrift[];
}

/** P39 status line and the drift that feeds "Review and restate". */
export async function financialStatus(
  tx: Tx,
  companyId: string,
): Promise<FinancialStatus> {
  const term = await tx.llcTerm.findUnique({
    where: { companyId },
    select: { booksClosedThrough: true },
  });
  const booksClosedThrough =
    term?.booksClosedThrough != null
      ? toDateOnly(term.booksClosedThrough)
      : null;
  const [latest, first] = await Promise.all([
    latestSnapshotMonth(tx, companyId),
    firstSnapshotMonth(tx, companyId),
  ]);
  if (latest === null || first === null) {
    return { snapshotThrough: null, booksClosedThrough, drift: [] };
  }
  const base = await loadSeriesBase(tx, companyId);
  const from =
    base.inception !== null && compareIso(base.inception, first) < 0
      ? base.inception
      : first;
  const range = { from, to: latest };
  const months = monthsBetween(from, latest);
  const built = build(await withFacts(tx, base, range), range);

  const dates = months.map((m) => fromDateOnly(m));
  const [storedFund, holderRows, names] = await Promise.all([
    readFundMonths(tx, companyId, { through: monthEnd(latest) }),
    tx.holderFinancialSnapshot.findMany({
      where: { companyId, supersededAt: null, month: { in: dates } },
      select: { id: true, month: true, stakeholderId: true, data: true },
    }),
    tx.stakeholder.findMany({
      where: { companyId },
      select: { id: true, name: true },
    }),
  ]);
  const storedHolders: HolderMonth[] = holderRows.map((r) => {
    const h = holderMonthFromJson(r.data);
    if (h.holderId !== r.stakeholderId || h.month !== toDateOnly(r.month)) {
      throw new Error(`Holder snapshot ${r.id} does not match its row`);
    }
    return h;
  });
  const drift = driftOf({
    months,
    stored: { fund: storedFund, holders: storedHolders },
    ledger: { fund: built.fundMonths, holders: built.holderMonths },
  });
  const nameOf = new Map(names.map((s) => [s.id, s.name]));
  return {
    snapshotThrough: monthEnd(latest),
    booksClosedThrough,
    drift: drift.map((d) => {
      const published = storedFund.find((m) => m.month === d.month);
      const ledger = built.fundMonths.find((m) => m.month === d.month);
      if (!ledger) throw new Error(`No ledger record for ${d.month}`);
      return {
        month: d.month,
        fields: d.fields,
        holders: d.holders.map((h) => ({
          stakeholderId: h.holderId,
          name: nameOf.get(h.holderId) ?? "(deleted holder)",
          fields: h.fields,
        })),
        published: published ? fundMonthToJson(published) : null,
        ledger: fundMonthToJson(ledger),
      };
    }),
  };
}
