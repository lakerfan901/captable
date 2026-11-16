import { RiArrowLeftLine } from "@remixicon/react";
import Link from "next/link";
import { ReportExportButton } from "@/components/governance/report-export-button";
import { ReportView } from "@/components/governance/report-view";
import { MarkReportViewed } from "@/components/portal/mark-viewed";
import { portalPageCall } from "@/components/portal/portal-call";
import { requirePortalHolder } from "@/components/portal/portal-me";
import { PortalReportFiles } from "@/components/portal/report-files";
import { Card } from "@/components/ui/card";
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

export default async function PortalReportPage(props: {
  params: Promise<{ access: string; reportId: string }>;
}) {
  const { access, reportId } = await props.params;
  await requirePortalHolder(access);
  const data = await portalPageCall(() =>
    api.portal.reports.get({ access, reportId }),
  );
  const { report } = data;
  return (
    <div className="flex flex-col gap-4">
      <div>
        <Link
          href={`${accessBasePath(access)}/reports`}
          className="inline-flex items-center gap-1 rounded-sm text-sm text-muted-foreground hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          <RiArrowLeftLine className="h-4 w-4" aria-hidden />
          All reports
        </Link>
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
          sentText={formatDay(report.releasedAt, data.timeZone, "long") || null}
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
