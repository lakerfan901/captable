import { Suspense } from "react";
import { PortalFinancialsView } from "@/components/portal/portal-dashboard-views";
import {
  loadPortalFinancials,
  loadPortalReportSummaries,
} from "@/components/portal/portal-financials";
import { requirePortalHolder } from "@/components/portal/portal-me";

// /portal/[access]/financials (04-investor-portal.md 6.3; package P15): the
// fund view. Period control (Month / Quarter / Year / Since inception, the
// period, the comparison; kept in the URL), fund KPI tiles, charts F1–F8,
// and the report of the period on screen. Fund totals only (P36). Figures
// from the snapshots through the holder's published-through date (P33,
// P34); with none, the empty state.

export default async function PortalFinancialsPage(props: {
  params: Promise<{ access: string }>;
}) {
  const { access } = await props.params;
  await requirePortalHolder(access);
  const [data, reports] = await Promise.all([
    loadPortalFinancials(access),
    loadPortalReportSummaries(access),
  ]);
  return (
    // `usePeriodState` reads the query (Next.js requires a Suspense boundary).
    <Suspense fallback={null}>
      <PortalFinancialsView access={access} data={data} reports={reports} />
    </Suspense>
  );
}
