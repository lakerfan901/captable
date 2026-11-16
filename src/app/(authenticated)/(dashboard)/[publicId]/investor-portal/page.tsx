import type { Metadata } from "next";
import { PageLayout } from "@/components/dashboard/page-layout";
import { InvestorPortalAdmin } from "@/components/llc/portal/investor-portal-admin";
import { UnAuthorizedState } from "@/components/ui/un-authorized-state";
import { portalTab } from "@/lib/portal/share-dialog-view";
import { serverAccessControl } from "@/lib/rbac/access-control";
import { requireLlc } from "@/server/entity";

export const metadata: Metadata = {
  title: "Investor portal",
};

// The team's "Investor portal" page (04-investor-portal.md 6.2; package
// P9a): who can sign in, and what they opened. LLC only; needs `portal:
// read` (the sidebar entry is hidden without it, P29).
export default async function InvestorPortalPage(props: {
  searchParams: Promise<{
    tab?: string | string[];
    document?: string | string[];
  }>;
}) {
  const entity = await requireLlc();
  const { allow } = await serverAccessControl();
  if (!allow(true, ["portal", "read"], false)) {
    return <UnAuthorizedState />;
  }
  const search = await props.searchParams;
  const document =
    typeof search.document === "string" &&
    search.document.length > 0 &&
    search.document.length <= 64
      ? search.document
      : null;

  return (
    <PageLayout
      title="Investor portal"
      description="Who can sign in to the investor portal, and what they opened"
    >
      <InvestorPortalAdmin
        companyPublicId={entity.publicId}
        tab={portalTab(search.tab)}
        canUpdate={allow(true, ["portal", "update"], false) === true}
        documentPublicId={document}
      />
    </PageLayout>
  );
}
