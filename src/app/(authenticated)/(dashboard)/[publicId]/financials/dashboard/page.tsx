import type { Metadata } from "next";
import { Suspense } from "react";
import { UnAuthorizedState } from "@/components/ui/un-authorized-state";
import { serverAccessControl } from "@/lib/rbac/access-control";
import { requireLlc } from "@/server/entity";
import { previewHolders } from "./components/preview-holders";
import { TeamDashboard } from "./components/team-dashboard";

export const metadata: Metadata = { title: "Financials dashboard" };

// Team financial dashboard (04-investor-portal.md 6.3 "Team side", P39;
// package P16). Needs `llc-financials: read`. "Preview as investor" needs
// `portal: read` as well (the holder list is loaded only then, so it never
// reaches a browser without it); Restate needs `llc-financials: update` and
// `governance: update`. What a role may not do is absent, never greyed.

export default async function FinancialDashboardPage() {
  const entity = await requireLlc();
  const { allow } = await serverAccessControl();
  if (!allow(true, ["llc-financials", "read"], false)) {
    return <UnAuthorizedState />;
  }
  const canPreview = allow(true, ["portal", "read"], false);
  const canRestate =
    allow(true, ["llc-financials", "update"], false) &&
    allow(true, ["governance", "update"], false);
  const holders = canPreview ? await previewHolders(entity.id) : [];

  return (
    <Suspense
      fallback={
        <div className="h-96 animate-pulse rounded-lg bg-muted" aria-hidden />
      }
    >
      <TeamDashboard
        canPreview={canPreview}
        canRestate={canRestate}
        holders={holders}
      />
    </Suspense>
  );
}
