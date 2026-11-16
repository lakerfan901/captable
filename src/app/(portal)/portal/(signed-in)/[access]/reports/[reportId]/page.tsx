import { RiArrowLeftLine, RiArrowRightLine } from "@remixicon/react";
import Link from "next/link";
import { ReportExportButton } from "@/components/governance/report-export-button";
import { ReportView } from "@/components/governance/report-view";
import { MarkReportViewed } from "@/components/portal/mark-viewed";
import { portalPageCall } from "@/components/portal/portal-call";
import { loadPortalFinancials } from "@/components/portal/portal-financials";
import { requirePortalHolder } from "@/components/portal/portal-me";
import { PortalReportFiles } from "@/components/portal/report-files";
import { Card } from "@/components/ui/card";
import {
  dashboardPeriodOfReport,
  financialsHref,
} from "@/lib/portal/portal-dashboard";
import { formatDay } from "@/lib/portal/portal-files-view";
import { accessBasePath } from "@/lib/portal/portal-nav";
import { api } from "@/trpc/server";

// /portal/[access]/reports/[reportId] (04-investor-portal.md 6.1, P11, P12;
// package P8b). The landing of an emailed link (`/portal/go/report/…`, P5b)
// redirects here. `portal.reports.get` returns the content frozen at release
// and the files this holder may see; a report that is not visible to this
// holder (never released to it, unpublished, another company's, an unknown
// id) is the portal's 404, the same for every reason (S3). The body is the
// same `ReportView` as the emailed token page, so both read identically.
//
// From the browser: `markViewed` once (the log row carries the client's
// address), the file buttons and the Excel button (shown only when the
// report is `exportable`). Each of them re-renders the page when the report
// has gone in the meantime, which then shows "not available".
//
// "See this period in Financials" (6.3) sits beside "All reports" when the
// report covers one dashboard period (a whole quarter or year) and the
// holder has published financials (the tab row's own test).

export default async function PortalReportPage(props: {
  params: Promise<{ access: string; reportId: string }>;
}) {
  const { access, reportId } = await props.params;
  await requirePortalHolder(access);
  const data = await portalPageCall(() =>
    api.portal.reports.get({ access, reportId }),
  );
  const { report } = data;
  const period = dashboardPeriodOfReport(report);
  const financials = period ? await loadPortalFinancials(access) : null;
  const periodHref =
    period && financials?.publishedThrough != null
      ? financialsHref(access, period)
      : null;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <Link
          href={`${accessBasePath(access)}/reports`}
          className="inline-flex items-center gap-1 rounded-sm text-sm text-muted-foreground hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          <RiArrowLeftLine className="h-4 w-4" aria-hidden />
          All reports
        </Link>
        {periodHref ? (
          <Link
            href={periodHref}
            className="inline-flex items-center gap-1 rounded-sm text-sm text-muted-foreground hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            data-testid="report-financials-link"
          >
            See this period in Financials
            <RiArrowRightLine className="h-4 w-4" aria-hidden />
          </Link>
        ) : null}
      </div>
      <Card className="p-5 sm:p-10" data-testid="portal-report">
        <MarkReportViewed access={access} reportId={report.id} />
        <ReportView
          companyName={data.company.name}
          title={report.title}
          type={report.type}
          noticeKind={report.noticeKind}
          periodStart={report.periodStart}
          periodEnd={report.periodEnd}
          releasedText={
            formatDay(report.releasedAt, data.timeZone, "long") || null
          }
          figures={report.figures}
          doc={report.doc}
        >
          <PortalReportFiles
            access={access}
            reportId={report.id}
            files={data.attachments.map((a) => ({
              id: a.id,
              name: a.name,
              private: a.private,
              inline: a.inline,
            }))}
          />
          {data.exportable ? (
            <div>
              <ReportExportButton
                mode="portal"
                access={access}
                reportId={report.id}
              />
            </div>
          ) : null}
        </ReportView>
      </Card>
    </div>
  );
}
