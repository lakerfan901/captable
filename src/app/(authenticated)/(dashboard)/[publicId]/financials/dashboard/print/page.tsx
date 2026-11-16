import type { Metadata } from "next";
import { Suspense } from "react";
import { UnAuthorizedState } from "@/components/ui/un-authorized-state";
import { serverAccessControl } from "@/lib/rbac/access-control";
import { requireLlc } from "@/server/entity";
import { previewHolders } from "../components/preview-holders";
import { TeamDashboardPrint } from "../components/team-dashboard-print";

export const metadata: Metadata = { title: "Financials dashboard (print)" };

// /[publicId]/financials/dashboard/print (04-investor-portal.md 5.9 "PDF";
// package P17): the print layout of the team's dashboard, for every source
// of the page (Live, Published, and Preview with its Fund performance and
// My investment sections, from the same `source`, `holder` and `section`
// query keys). The same permissions as the page: `llc-financials: read`;
// Preview only with `portal: read` (otherwise the URL falls back to Live).

export default async function FinancialDashboardPrintPage() {
  const entity = await requireLlc();
  const { allow } = await serverAccessControl();
  if (!allow(true, ["llc-financials", "read"], false)) {
    return <UnAuthorizedState />;
  }
  const canPreview = allow(true, ["portal", "read"], false);
  const holders = canPreview ? await previewHolders(entity.id) : [];
  return (
    <Suspense fallback={null}>
      <TeamDashboardPrint
        companyName={entity.name}
        canPreview={canPreview}
        holders={holders}
      />
    </Suspense>
  );
}
