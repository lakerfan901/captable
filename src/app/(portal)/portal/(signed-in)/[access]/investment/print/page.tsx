import { Suspense } from "react";
import { loadPortalFinancials } from "@/components/portal/portal-financials";
import { requirePortalHolder } from "@/components/portal/portal-me";
import { PortalDashboardPrint } from "@/components/portal/portal-print-views";

// /portal/[access]/investment/print (04-investor-portal.md 5.9 "PDF", 6.3;
// package P17): the print layout of the My investment page: the holder's
// own tiles, charts M1 and M2 with their tables, and the distribution and
// contribution tables. Only this holder's records (P36).

export default async function PortalInvestmentPrintPage(props: {
  params: Promise<{ access: string }>;
}) {
  const { access } = await props.params;
  const { holder } = await requirePortalHolder(access);
  const data = await loadPortalFinancials(access);
  return (
    <Suspense fallback={null}>
      <PortalDashboardPrint
        page="investment"
        data={data}
        companyName={holder.companyName}
      />
    </Suspense>
  );
}
