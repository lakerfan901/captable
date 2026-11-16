"use client";

// The print layout of the team's financial dashboard (04-investor-portal.md
// 5.9 "PDF"; package P17): the source of the page's query (Live, Published
// or Preview, with the previewed holder and section) and its period view,
// drawn by the same components in print mode.

import { usePathname, useSearchParams } from "next/navigation";
import { useMemo } from "react";
import { formatDate } from "@/components/charts/chart-format";
import { backFromPrint } from "@/components/financials/export-request";
import { FundDashboard } from "@/components/financials/fund-dashboard";
import { InvestmentDashboard } from "@/components/financials/investment-dashboard";
import { PrintLayout } from "@/components/financials/print-layout";
import { usePeriodState } from "@/components/financials/use-period-state";
import {
  fundMonthFromJson,
  holderMonthFromJson,
} from "@/lib/llc/financial-series";
import { type PreviewHolder, useTeamDashboardSource } from "./team-dashboard";

export function TeamDashboardPrint({
  companyName,
  canPreview,
  holders,
}: {
  companyName: string;
  canPreview: boolean;
  holders: PreviewHolder[];
}) {
  const pathname = usePathname();
  const params = useSearchParams();
  // biome-ignore lint/correctness/useExhaustiveDependencies: the first address is the one to go back to
  const backHref = useMemo(
    () => backFromPrint(pathname, params.toString()),
    [pathname],
  );
  const { src, query, holderName } = useTeamDashboardSource({
    canPreview,
    holders,
  });
  const [period, setPeriod] = usePeriodState();
  const data = query.data;
  const fundMonths = useMemo(
    () => (data ? data.fundMonths.map(fundMonthFromJson) : []),
    [data],
  );
  const holderMonths = useMemo(
    () => (data ? data.holderMonths.map(holderMonthFromJson) : []),
    [data],
  );
  const mine = src.source === "preview" && src.section === "mine";
  const title = mine ? "My investment" : "Financials";
  const through = data?.publishedThrough ?? null;
  const lines =
    through === null
      ? []
      : src.source === "live"
        ? [
            `Live from the ledger, figures as of ${formatDate(through)}, including periods not yet released to investors.`,
          ]
        : src.source === "published"
          ? [
              `Published to investors through ${formatDate(through)}, as stored at release.`,
            ]
          : [
              `Preview: what ${holderName} sees in the investor portal. Figures published through ${formatDate(through)}.`,
            ];
  const ready = query.data !== undefined || query.error !== null;
  return (
    <PrintLayout
      company={companyName}
      title={title}
      lines={lines}
      ready={ready && !query.isFetching}
      backHref={backHref}
    >
      {query.error ? (
        <p className="text-sm text-destructive">{query.error.message}</p>
      ) : !data ? (
        <div className="h-96 animate-pulse rounded-lg bg-muted" aria-hidden />
      ) : fundMonths.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="print-empty">
          No figures to print for this view.
        </p>
      ) : mine ? (
        <InvestmentDashboard
          holderMonths={holderMonths}
          fundMonths={fundMonths}
          inceptionMonth={data.inceptionMonth ?? undefined}
          state={period}
          onStateChange={setPeriod}
          restatements={data.restatements}
        />
      ) : (
        <FundDashboard
          fundMonths={fundMonths}
          inceptionMonth={data.inceptionMonth ?? undefined}
          state={period}
          onStateChange={setPeriod}
          restatements={data.restatements}
          targetSaleDate={data.termClock?.targetSaleDate ?? null}
        />
      )}
    </PrintLayout>
  );
}
