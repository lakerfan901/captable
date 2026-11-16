import { Suspense } from "react";
import { PortalInvestmentView } from "@/components/portal/portal-dashboard-views";
import {
  loadPortalFinancials,
  loadPortalReportSummaries,
} from "@/components/portal/portal-financials";
import { requirePortalHolder } from "@/components/portal/portal-me";

// /portal/[access]/investment (04-investor-portal.md 6.3; package P15): the
// holder's own view. The same period control, "my" KPI tiles, charts M1 and
// M2, and the holder's distributions and contributions by month. Only this
// holder's records reach the page: `portal.financials.get` reads them by the
// resolved holder and nothing else (P36).

export default async function PortalInvestmentPage(props: {
  params: Promise<{ access: string }>;
}) {
  const { access } = await props.params;
  await requirePortalHolder(access);
  const [data, reports] = await Promise.all([
    loadPortalFinancials(access),
    loadPortalReportSummaries(access),
  ]);
  return (
    <Suspense fallback={null}>
      <PortalInvestmentView access={access} data={data} reports={reports} />
    </Suspense>
  );
}
