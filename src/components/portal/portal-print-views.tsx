"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { useMemo } from "react";
import { formatDate } from "@/components/charts/chart-format";
import { NoPeriods } from "@/components/financials/dashboard-header";
import { backFromPrint } from "@/components/financials/export-request";
import { FundDashboard } from "@/components/financials/fund-dashboard";
import { InvestmentDashboard } from "@/components/financials/investment-dashboard";
import { resolveView } from "@/components/financials/period-state";
import { PrintLayout } from "@/components/financials/print-layout";
import { usePeriodState } from "@/components/financials/use-period-state";
import { periodKey, periodLabel } from "@/lib/llc/financial-periods";
import {
  fundMonthFromJson,
  holderMonthFromJson,
} from "@/lib/llc/financial-series";
import { MyTables } from "./portal-dashboard-views";
import type { PortalFinancials } from "./portal-financials";

// The print layouts of the investor's Financials and My investment pages
// (04-investor-portal.md 5.9 "PDF", 6.3 `/financials/print`,
// `/investment/print`; package P17): the same components over the same
// answer (`portal.financials.get`) and the same view (the page's query),
// in print mode.

export function PortalDashboardPrint({
  page,
  data,
  companyName,
}: {
  page: "financials" | "investment";
  data: PortalFinancials;
  companyName: string;
}) {
  const pathname = usePathname();
  const params = useSearchParams();
  // computed once: the layout drops `autoprint` from the address later
  // biome-ignore lint/correctness/useExhaustiveDependencies: the first address is the one to go back to
  const backHref = useMemo(
    () => backFromPrint(pathname, params.toString()),
    [pathname],
  );
  const [state, setState] = usePeriodState();
  const series = useMemo(() => {
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
  const title = page === "financials" ? "Financials" : "My investment";
  if (!series || data.publishedThrough === null) {
    return (
      <PrintLayout
        company={companyName}
        title={title}
        lines={[]}
        ready
        backHref={backHref}
      >
        <NoPeriods />
      </PrintLayout>
    );
  }
  const view = resolveView(state, {
    inception: series.inception,
    last: series.last,
  });
  const fromKey = periodKey(view.trendRange.from, view.trendGrain);
  const toKey = periodKey(view.trendRange.to, view.trendGrain);
  const lines = [
    `Figures published through ${formatDate(data.publishedThrough)}. ${
      page === "financials"
        ? "Fund totals only: no other holder’s figures are shown."
        : "Your own figures only."
    }`,
    `Charts: ${
      fromKey === toKey
        ? periodLabel(fromKey)
        : `${periodLabel(fromKey)} – ${periodLabel(toKey)}`
    }, by ${view.trendGrain}.`,
  ];
  return (
    <PrintLayout
      company={companyName}
      title={title}
      lines={lines}
      ready
      backHref={backHref}
    >
      {page === "financials" ? (
        <FundDashboard
          fundMonths={series.fund}
          inceptionMonth={series.inception}
          state={state}
          onStateChange={setState}
          restatements={data.restatements}
          targetSaleDate={data.termClock?.targetSaleDate ?? null}
        />
      ) : (
        <>
          <InvestmentDashboard
            holderMonths={series.mine}
            fundMonths={series.fund}
            inceptionMonth={series.inception}
            state={state}
            onStateChange={setState}
            restatements={data.restatements}
          />
          <div className="flex break-before-page flex-col gap-6 [&>*]:break-inside-avoid">
            <MyTables mine={series.mine} restatements={data.restatements} />
          </div>
        </>
      )}
    </PrintLayout>
  );
}
