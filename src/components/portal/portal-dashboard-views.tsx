"use client";

import Link from "next/link";
import { type ReactNode, useMemo } from "react";
import { formatDate, formatMoney } from "@/components/charts/chart-format";
import { ChartGrid } from "@/components/charts/chart-frame";
import {
  NoPeriods,
  PeriodHeading,
  ThroughLine,
} from "@/components/financials/dashboard-header";
import {
  FUND_TILES,
  HOLDER_TILES,
  tileViews,
} from "@/components/financials/dashboard-model";
import { exportRequestOf } from "@/components/financials/export-request";
import { FundDashboard } from "@/components/financials/fund-dashboard";
import { InvestmentDashboard } from "@/components/financials/investment-dashboard";
import { KpiGrid, KpiTile } from "@/components/financials/kpi-tile";
import { MyDistributionsChart } from "@/components/financials/my-distributions-chart";
import {
  DEFAULT_PERIOD_STATE,
  resolveView,
} from "@/components/financials/period-state";
import { RevenueChart } from "@/components/financials/revenue-chart";
import { usePeriodState } from "@/components/financials/use-period-state";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { IsoDate } from "@/lib/llc/dates";
import {
  type MonthKey,
  monthEnd,
  periodLabel,
} from "@/lib/llc/financial-periods";
import {
  aggregate,
  aggregateHolder,
  type FundMonth,
  fundComparison,
  fundMonthFromJson,
  type HolderMonth,
  holderComparison,
  holderMonthFromJson,
} from "@/lib/llc/financial-series";
import {
  contributionRows,
  distributionRows,
  financialsHref,
  latestPeriodReport,
  type PeriodReportRow,
  type ReportSummary,
  reportsForPeriod,
} from "@/lib/portal/portal-dashboard";
import { PortalDashboardExport } from "./portal-dashboard-export";
import type { DocumentSummary, PortalFinancials } from "./portal-financials";

// The investor's dashboard pages (04-investor-portal.md 6.3; package P15):
// Overview body, Financials and My investment, built from the P14
// components over `portal.financials.get` (the holder's snapshots through its
// published-through date, P33, P34). The server pages pass the procedure's
// JSON records as they came; they are converted here (bigint cents) and
// aggregated in the browser, so switching grain or period needs no request
// (5.9). Every figure on these pages comes from that one answer.

const THROUGH_NOTE =
  "Figures run through the latest period the Manager has released. Later periods appear when they are released.";

interface Series {
  fund: FundMonth[];
  mine: HolderMonth[];
  inception: MonthKey;
  last: MonthKey;
}

function useSeries(data: PortalFinancials): Series | null {
  return useMemo(() => {
    const fund = data.fundMonths
      .map(fundMonthFromJson)
      .sort((a, b) => (a.month < b.month ? -1 : a.month > b.month ? 1 : 0));
    const first = fund[0];
    const last = fund[fund.length - 1];
    if (data.publishedThrough === null || !first || !last) return null;
    return {
      fund,
      mine: data.holderMonths.map(holderMonthFromJson),
      inception: data.inceptionMonth ?? first.month,
      last: last.month,
    };
  }, [data]);
}

function PageHead({
  title,
  description,
  publishedThrough,
}: {
  title: string;
  description: string;
  publishedThrough: IsoDate | null;
}) {
  return (
    <div className="flex flex-col gap-3">
      <div>
        <h2 className="text-xl font-semibold tracking-tight">{title}</h2>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
      {publishedThrough ? (
        <ThroughLine publishedThrough={publishedThrough} note={THROUGH_NOTE} />
      ) : null}
    </div>
  );
}

function restatedIn(
  restatements: readonly { month: MonthKey; at: IsoDate }[],
  months: readonly MonthKey[],
): string[] {
  return [
    ...new Set(
      restatements.filter((r) => months.includes(r.month)).map((r) => r.at),
    ),
  ];
}

// ---------------------------------------------------------------------------
// Reports of a period

function ReportRows({ rows }: { rows: PeriodReportRow[] }) {
  return (
    <ul className="flex flex-col gap-3">
      {rows.map((r) => (
        <li
          key={r.key}
          className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-4"
          data-testid="period-report"
          data-period={r.key}
        >
          <div className="min-w-0">
            <p className="font-medium">{r.title ?? `${r.label} report`}</p>
            <p className="text-xs text-muted-foreground">
              {r.grain === "quarter" ? "Quarterly report" : "Annual report"} ·{" "}
              {r.label}
              {r.releasedOn ? ` · released ${formatDate(r.releasedOn)}` : ""}
            </p>
          </div>
          <Button asChild size="sm">
            <Link href={r.href}>Read the report</Link>
          </Button>
        </li>
      ))}
    </ul>
  );
}

function PeriodReportsCard({
  label,
  rows,
}: {
  label: string;
  rows: PeriodReportRow[];
}) {
  // Absent, not empty, when no report of this period is visible.
  if (rows.length === 0) return null;
  return (
    <Card data-testid="period-reports">
      <CardHeader>
        <CardTitle className="text-base font-medium">
          {label} {rows.length > 1 ? "reports" : "report"}
        </CardTitle>
        <CardDescription>
          The Manager’s report for this period, with its text and files.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ReportRows rows={rows} />
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Financials

export function PortalFinancialsView({
  access,
  data,
  reports,
}: {
  access: string;
  data: PortalFinancials;
  reports: ReportSummary[];
}) {
  const series = useSeries(data);
  const [state, setState] = usePeriodState();
  const head = (
    <PageHead
      title="Financials"
      description="Fund performance by month, quarter and year. Fund totals only: no other holder’s figures are shown."
      publishedThrough={series ? data.publishedThrough : null}
    />
  );
  if (!series) {
    return (
      <div className="flex flex-col gap-6">
        {head}
        <NoPeriods />
      </div>
    );
  }
  const span = { inception: series.inception, last: series.last };
  const view = resolveView(state, span);
  const rows = reportsForPeriod(
    access,
    data.periods,
    { start: view.focusRange.from, end: monthEnd(view.focusRange.to) },
    reports,
  );
  return (
    <div className="flex flex-col gap-6" data-portal-wide>
      {head}
      <FundDashboard
        fundMonths={series.fund}
        inceptionMonth={series.inception}
        state={state}
        onStateChange={setState}
        restatements={data.restatements}
        targetSaleDate={data.termClock?.targetSaleDate ?? null}
        actions={
          <PortalDashboardExport
            access={access}
            page="financials"
            request={exportRequestOf(state, span, "fund")}
          />
        }
      />
      <PeriodReportsCard label={periodLabel(view.focus.key)} rows={rows} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// My investment

function MoneyCell({ v, className }: { v: bigint; className?: string }) {
  return (
    <TableCell
      className={`whitespace-nowrap text-right tabular-nums ${className ?? ""}`}
    >
      {formatMoney(v)}
    </TableCell>
  );
}

function RestatedMark({ on }: { on: IsoDate | null }) {
  if (on === null) return null;
  return (
    <span className="ml-2 text-xs text-muted-foreground">
      Restated on {formatDate(on)}
    </span>
  );
}

function HistoryCard({
  id,
  title,
  description,
  children,
}: {
  id: string;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <Card data-testid={id} className="min-w-0">
      <CardHeader>
        <CardTitle className="text-base font-medium">{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="overflow-x-auto">{children}</CardContent>
    </Card>
  );
}

export function MyTables({
  mine,
  restatements,
}: {
  mine: HolderMonth[];
  restatements: readonly { month: MonthKey; at: IsoDate }[];
}) {
  const dist = distributionRows(mine, restatements);
  const contrib = contributionRows(mine, restatements);
  const showOffsets = dist.total.offsets !== 0n;
  const showCredits = contrib.total.credits !== 0n;
  return (
    <>
      {dist.rows.length > 0 ? (
        <HistoryCard
          id="my-distribution-table"
          title="Your distributions"
          description="By month, since you joined, through the published-through date."
        >
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Month</TableHead>
                <TableHead className="text-right">Preferred return</TableHead>
                <TableHead className="text-right">Return of capital</TableHead>
                <TableHead className="text-right">Residual</TableHead>
                <TableHead className="text-right">Total</TableHead>
                {showOffsets ? (
                  <TableHead className="text-right">Offsets</TableHead>
                ) : null}
                <TableHead className="text-right">Net paid</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {dist.rows.map((r) => (
                <TableRow key={r.month} data-month={r.month}>
                  <TableCell className="whitespace-nowrap">
                    {r.label}
                    <RestatedMark on={r.restatedOn} />
                  </TableCell>
                  <MoneyCell v={r.preferredReturn} />
                  <MoneyCell v={r.returnOfCapital} />
                  <MoneyCell v={r.residual} />
                  <MoneyCell v={r.gross} />
                  {showOffsets ? <MoneyCell v={-r.offsets} /> : null}
                  <MoneyCell v={r.net} className="font-medium" />
                </TableRow>
              ))}
            </TableBody>
            <TableFooter>
              <TableRow>
                <TableCell>Total</TableCell>
                <MoneyCell v={dist.total.preferredReturn} />
                <MoneyCell v={dist.total.returnOfCapital} />
                <MoneyCell v={dist.total.residual} />
                <MoneyCell v={dist.total.gross} />
                {showOffsets ? <MoneyCell v={-dist.total.offsets} /> : null}
                <MoneyCell v={dist.total.net} />
              </TableRow>
            </TableFooter>
          </Table>
        </HistoryCard>
      ) : null}
      {contrib.rows.length > 0 ? (
        <HistoryCard
          id="my-contribution-table"
          title="Your contributions"
          description="Capital you paid in, by month."
        >
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Month</TableHead>
                <TableHead className="text-right">Contributed</TableHead>
                {showCredits ? (
                  <TableHead className="text-right">Credited</TableHead>
                ) : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {contrib.rows.map((r) => (
                <TableRow key={r.month} data-month={r.month}>
                  <TableCell className="whitespace-nowrap">
                    {r.label}
                    <RestatedMark on={r.restatedOn} />
                  </TableCell>
                  <MoneyCell v={r.contributions} />
                  {showCredits ? <MoneyCell v={r.credits} /> : null}
                </TableRow>
              ))}
            </TableBody>
            <TableFooter>
              <TableRow>
                <TableCell>Total</TableCell>
                <MoneyCell v={contrib.total.contributions} />
                {showCredits ? <MoneyCell v={contrib.total.credits} /> : null}
              </TableRow>
            </TableFooter>
          </Table>
        </HistoryCard>
      ) : null}
    </>
  );
}

export function PortalInvestmentView({
  access,
  data,
  reports,
}: {
  access: string;
  data: PortalFinancials;
  reports: ReportSummary[];
}) {
  const series = useSeries(data);
  const [state, setState] = usePeriodState();
  const head = (
    <PageHead
      title="My investment"
      description="Your own position, distributions and contributions. Only you see these figures."
      publishedThrough={series ? data.publishedThrough : null}
    />
  );
  if (!series) {
    return (
      <div className="flex flex-col gap-6">
        {head}
        <NoPeriods />
      </div>
    );
  }
  const span = { inception: series.inception, last: series.last };
  const view = resolveView(state, span);
  const rows = reportsForPeriod(
    access,
    data.periods,
    { start: view.focusRange.from, end: monthEnd(view.focusRange.to) },
    reports,
  );
  return (
    <div className="flex flex-col gap-6" data-portal-wide>
      {head}
      <InvestmentDashboard
        holderMonths={series.mine}
        fundMonths={series.fund}
        inceptionMonth={series.inception}
        state={state}
        onStateChange={setState}
        restatements={data.restatements}
        actions={
          <PortalDashboardExport
            access={access}
            page="investment"
            request={exportRequestOf(state, span, "mine")}
          />
        }
      />
      <MyTables mine={series.mine} restatements={data.restatements} />
      <PeriodReportsCard label={periodLabel(view.focus.key)} rows={rows} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Overview

const OVERVIEW_FUND_TILES = [
  "grossRevenue",
  "netOperatingIncome",
  "distributions.gross",
  "cumulativeDistributions",
  "dpiBps",
];
const OVERVIEW_MY_TILES = [
  "paidIn",
  "grossDistributions",
  "unreturnedCapital",
  "dpiBps",
];

function OverviewFigures({
  access,
  series,
  restatements,
}: {
  access: string;
  series: Series;
  restatements: readonly { month: MonthKey; at: IsoDate }[];
}) {
  const opts = { inceptionMonth: series.inception };
  // The latest published quarter, compared with the quarter before (6.3).
  const view = resolveView(DEFAULT_PERIOD_STATE, {
    inception: series.inception,
    last: series.last,
  });
  const fundTrend = aggregate(
    series.fund,
    view.trendGrain,
    view.trendRange,
    opts,
  );
  const fundFocus = aggregate(
    series.fund,
    view.focus.grain,
    view.focusRange,
    opts,
  )[0];
  const myTrend = aggregateHolder(
    series.mine,
    series.fund,
    view.trendGrain,
    view.trendRange,
    opts,
  );
  const myFocus = aggregateHolder(
    series.mine,
    series.fund,
    view.focus.grain,
    view.focusRange,
    opts,
  )[0];
  if (!fundFocus) return null;
  const comparisonLabel = view.comparison
    ? periodLabel(view.comparison.key)
    : null;
  const fundTiles = tileViews(
    FUND_TILES.filter((d) => OVERVIEW_FUND_TILES.includes(d.key)),
    fundFocus,
    view.comparison
      ? fundComparison(series.fund, view.focus, "previous", opts)
      : null,
    comparisonLabel,
    fundTrend,
  );
  const hasOwn = series.mine.length > 0 && myFocus?.values;
  const myTiles =
    hasOwn && myFocus
      ? tileViews(
          HOLDER_TILES.filter((d) => OVERVIEW_MY_TILES.includes(d.key)),
          myFocus,
          view.comparison
            ? holderComparison(
                series.mine,
                series.fund,
                view.focus,
                "previous",
                opts,
              )
            : null,
          comparisonLabel,
          myTrend,
        )
      : [];
  const restatedOn = restatedIn(restatements, fundFocus.presentMonths);
  const focusPeriod = { grain: view.focus.grain, key: view.focus.key };
  const focusLink = financialsHref(access, focusPeriod);
  const myLink = financialsHref(access, focusPeriod, "investment");

  return (
    <div className="flex flex-col gap-6">
      <PeriodHeading period={fundFocus} restatedOn={restatedOn} />
      <section
        aria-labelledby="overview-fund"
        className="flex flex-col gap-3"
        data-testid="overview-fund"
      >
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 id="overview-fund" className="text-base font-medium sm:text-base">
            The fund
          </h3>
          <Link
            href={focusLink}
            className="rounded-sm text-sm font-medium underline-offset-4 hover:underline focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
          >
            All figures in Financials
          </Link>
        </div>
        <KpiGrid columns={5}>
          {fundTiles.map((t) => (
            <KpiTile key={t.key} tile={t} />
          ))}
        </KpiGrid>
      </section>
      {myTiles.length > 0 ? (
        <section
          aria-labelledby="overview-mine"
          className="flex flex-col gap-3"
          data-testid="overview-mine"
        >
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h3
              id="overview-mine"
              className="text-base font-medium sm:text-base"
            >
              Your investment
            </h3>
            <Link
              href={myLink}
              className="rounded-sm text-sm font-medium underline-offset-4 hover:underline focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
            >
              More in My investment
            </Link>
          </div>
          <KpiGrid columns={4}>
            {myTiles.map((t) => (
              <KpiTile key={t.key} tile={t} />
            ))}
          </KpiGrid>
        </section>
      ) : null}
      <ChartGrid>
        <RevenueChart
          periods={fundTrend}
          highlightKey={view.highlightKey}
          span={myTiles.length > 0 ? "half" : "full"}
        />
        {myTiles.length > 0 ? (
          <MyDistributionsChart
            periods={myTrend}
            highlightKey={view.highlightKey}
            span="half"
          />
        ) : null}
      </ChartGrid>
    </div>
  );
}

export function PortalOverview({
  access,
  data,
  reports,
  documents,
  documentsHref,
}: {
  access: string;
  data: PortalFinancials;
  reports: ReportSummary[];
  documents: DocumentSummary[];
  /** the Documents page, when it exists (nothing is a dead link) */
  documentsHref: string | null;
}) {
  const series = useSeries(data);
  const latest = series
    ? latestPeriodReport(access, data.periods, reports)
    : null;
  return (
    // wide only with figures: the empty state keeps the frame's normal width
    <div
      className="flex flex-col gap-6"
      data-portal-wide={series ? true : undefined}
    >
      {series && data.publishedThrough ? (
        <ThroughLine
          publishedThrough={data.publishedThrough}
          note={THROUGH_NOTE}
        />
      ) : null}
      {series ? (
        <OverviewFigures
          access={access}
          series={series}
          restatements={data.restatements}
        />
      ) : (
        <NoPeriods />
      )}
      {latest ? (
        <Card data-testid="latest-report">
          <CardHeader>
            <CardTitle className="text-base font-medium">
              Latest report
            </CardTitle>
            <CardDescription>
              The Manager’s report for the latest published period.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ReportRows rows={[latest]} />
          </CardContent>
        </Card>
      ) : null}
      {documents.length > 0 ? (
        <Card data-testid="newest-documents">
          <CardHeader className="flex-row items-start justify-between gap-4 space-y-0">
            <div className="space-y-1.5">
              <CardTitle className="text-base font-medium">
                Newest documents
              </CardTitle>
              <CardDescription>Shared with you by the Manager.</CardDescription>
            </div>
            {documentsHref ? (
              <Button asChild variant="ghost" size="sm">
                <Link href={documentsHref}>All documents</Link>
              </Button>
            ) : null}
          </CardHeader>
          <CardContent className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Category</TableHead>
                  <TableHead>Date shared</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {documents.map((d, i) => (
                  // names may repeat; the order is fixed (newest first)
                  // biome-ignore lint/suspicious/noArrayIndexKey: no id leaves the server for these rows
                  <TableRow key={i}>
                    <TableCell className="font-medium">{d.name}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {d.category ?? ""}
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      {formatDate(d.sharedOn)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
