import { PortalOverview } from "@/components/portal/portal-dashboard-views";
import {
  loadPortalDocumentSummaries,
  loadPortalFinancials,
  loadPortalReportSummaries,
} from "@/components/portal/portal-financials";
import { requirePortalHolder } from "@/components/portal/portal-me";
import { newestDocuments } from "@/lib/portal/portal-dashboard";
import { accessBasePath, PORTAL_SECTIONS } from "@/lib/portal/portal-nav";

// /portal/[access], the Overview of one holder (04-investor-portal.md 6.3;
// package P15): "Published through {date}", the fund's and the holder's own
// KPI tiles for the latest published quarter with the change against the
// quarter before, charts F1 and M1, the latest report and the three newest
// documents. With no published period: "No financial periods have been
// published yet." and nothing else of the dashboard (P33). The frame
// (holder header, switcher, tab row) is the layout.

export default async function PortalAccessOverviewPage(props: {
  params: Promise<{ access: string }>;
}) {
  const { access } = await props.params;
  // The gate again: the layout is not re-run on every navigation.
  await requirePortalHolder(access);
  const [data, reports, documents] = await Promise.all([
    loadPortalFinancials(access),
    loadPortalReportSummaries(access),
    loadPortalDocumentSummaries(access),
  ]);
  const documentsBuilt = PORTAL_SECTIONS.some(
    (s) => s.key === "documents" && s.built,
  );
  return (
    <PortalOverview
      access={access}
      data={data}
      reports={reports}
      documents={newestDocuments(documents).map((d) => d.doc)}
      documentsHref={
        documentsBuilt ? `${accessBasePath(access)}/documents` : null
      }
    />
  );
}
