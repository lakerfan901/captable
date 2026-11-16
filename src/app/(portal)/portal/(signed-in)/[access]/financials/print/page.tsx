import { Suspense } from "react";
import { loadPortalFinancials } from "@/components/portal/portal-financials";
import { requirePortalHolder } from "@/components/portal/portal-me";
import { PortalDashboardPrint } from "@/components/portal/portal-print-views";

// /portal/[access]/financials/print (04-investor-portal.md 5.9 "PDF", 6.3;
// package P17): the print layout of the Financials page, the same answer
// (`portal.financials.get`) and the same view (the query). The export menu
// opens it in a new tab with `?autoprint=1`, which calls the print dialog.

export default async function PortalFinancialsPrintPage(props: {
  params: Promise<{ access: string }>;
}) {
  const { access } = await props.params;
  const { holder } = await requirePortalHolder(access);
  const data = await loadPortalFinancials(access);
  return (
    <Suspense fallback={null}>
      <PortalDashboardPrint
        page="financials"
        data={data}
        companyName={holder.companyName}
      />
    </Suspense>
  );
}
