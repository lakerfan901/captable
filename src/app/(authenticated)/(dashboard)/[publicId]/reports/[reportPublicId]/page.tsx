import { TRPCError } from "@trpc/server";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { K1CoverageCard } from "@/components/governance/k1-coverage-card";
import {
  FiledDocumentButton,
  ReportAttachments,
} from "@/components/governance/report-attachments";
import { ReportEditor } from "@/components/governance/report-editor";
import { ReportExportButton } from "@/components/governance/report-export-button";
import { ReportPublishPanel } from "@/components/governance/report-publish-panel";
import { ReportRecipientTable } from "@/components/governance/report-recipient-table";
import { ReportStatusBadge } from "@/components/governance/report-table";
import { ReportView } from "@/components/governance/report-view";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { UnAuthorizedState } from "@/components/ui/un-authorized-state";
import { formatInstant } from "@/lib/company-time";
import { GOVERNANCE_TIME_ZONE, todayInZone } from "@/lib/governance/dates";
import {
  type PickerHolder,
  pickerCandidates,
  publishState,
  releasedLine,
} from "@/lib/governance/release-view";
import { serverAccessControl } from "@/lib/rbac/access-control";
import { requireLlc } from "@/server/entity";
import { api } from "@/trpc/server";

export const metadata: Metadata = { title: "Report" };

// Member report (03-governance.md G13 page 2; 04-investor-portal.md 6.2). A
// DRAFT shows the editor and "Release…"; a released (SENT) report shows the
// frozen content, the attachments, the "Investor portal" panel (with
// `portal: read`), the recipients and the filed PDF. `sentAt` is the release
// time; each recipient's `emailedAt` is its email.

export default async function ReportPage({
  params,
}: {
  params: Promise<{ publicId: string; reportPublicId: string }>;
}) {
  const entity = await requireLlc();
  const { reportPublicId } = await params;
  const { allow } = await serverAccessControl();
  if (!allow(true, ["governance", "read"], false)) {
    return <UnAuthorizedState />;
  }

  let data: Awaited<ReturnType<typeof api.memberReport.get>>;
  try {
    data = await api.memberReport.get({ publicId: reportPublicId });
  } catch (e) {
    if (e instanceof TRPCError && e.code === "NOT_FOUND") notFound();
    throw e;
  }

  const base = `/${entity.publicId}/reports`;
  const timeZone = entity.timezone || GOVERNANCE_TIME_ZONE;
  const canUpdate = allow(true, ["governance", "update"], false);
  // Anything the role may not do is absent (04-investor-portal.md P29).
  const showPortal = allow(true, ["portal", "read"], false);
  const mayInvite = allow(true, ["portal", "create"], false);
  const { report } = data;

  // Excel export of the figures (04-investor-portal.md 5.7).
  const exportable = report.type === "QUARTERLY" || report.type === "ANNUAL";

  if (report.status === "DRAFT") {
    return (
      <div className="flex flex-col gap-3">
        {exportable ? (
          <div className="flex justify-end">
            <ReportExportButton mode="team" publicId={report.publicId} />
          </div>
        ) : null}
        <ReportEditor
          data={data}
          base={base}
          companyPublicId={entity.publicId}
          today={todayInZone(new Date(), timeZone)}
          canUpdate={canUpdate}
          canDelete={allow(true, ["governance", "delete"], false)}
          timeZone={timeZone}
          mayInvite={mayInvite}
          showPortal={showPortal}
        />
      </div>
    );
  }

  const state = publishState(report);
  const emailedCount = data.recipients.filter(
    (r) => r.emailedAt !== null,
  ).length;
  // "Add recipients…": the holders that can still be added, and the notice
  // addresses on file (the replace-link dialog counts its notices with them).
  let addable = 0;
  const noticeEmails: Record<string, string> = {};
  if (canUpdate) {
    const options = await api.memberReport.audienceOptions({
      publicId: report.publicId,
    });
    for (const h of options.holders)
      noticeEmails[h.stakeholderId] = h.noticeEmail;
    addable = pickerCandidates(
      options.type,
      options.holders.map((h) => ({
        ...h,
        memberStatus: h.memberStatus as PickerHolder["memberStatus"],
      })),
      "ADD",
    ).length;
  }

  // The filed PDF is a Document of the company; `get` returns its id.
  let filedDocumentPublicId: string | null = null;
  if (report.filedDocumentId && allow(true, ["documents", "read"], false)) {
    const documents = await api.document.getAll();
    filedDocumentPublicId =
      documents.find((d) => d.id === report.filedDocumentId)?.publicId ?? null;
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <Link href={base} className="text-sm text-muted-foreground">
          ← Reports
        </Link>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <ReportStatusBadge
              status={report.status}
              unpublishedAt={report.unpublishedAt}
            />
            <span className="text-sm text-muted-foreground">
              {releasedLine(
                formatInstant(report.sentAt, timeZone),
                emailedCount,
                data.recipients.length,
              )}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {exportable ? (
              <ReportExportButton mode="team" publicId={report.publicId} />
            ) : null}
            {filedDocumentPublicId ? (
              <FiledDocumentButton documentPublicId={filedDocumentPublicId} />
            ) : report.filedDocumentId ? null : (
              <span className="text-sm text-muted-foreground">
                The PDF is being filed in Documents.
              </span>
            )}
          </div>
        </div>
      </div>

      <Card>
        <CardContent className="pt-6">
          <ReportView
            companyName={entity.name}
            title={report.title}
            type={report.type}
            noticeKind={report.noticeKind}
            periodStart={report.periodStart}
            periodEnd={report.periodEnd}
            fiscalYear={report.fiscalYear}
            fiscalQuarter={report.fiscalQuarter}
            figures={report.figures}
            doc={report.doc}
          />
        </CardContent>
      </Card>

      {data.k1Coverage ? (
        <K1CoverageCard coverage={data.k1Coverage} status={report.status} />
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            {report.type === "TAX_K1" ? "Schedules K-1" : "Attachments"}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <ReportAttachments
            publicId={report.publicId}
            companyPublicId={entity.publicId}
            type={report.type}
            status={report.status}
            attachments={data.attachments}
            candidates={[]}
            // Files are added while DRAFT only from this page (the backend
            // also accepts late additions; the filed PDF would not list them).
            canUpdate={false}
          />
        </CardContent>
      </Card>

      {showPortal ? (
        <ReportPublishPanel
          publicId={report.publicId}
          state={state}
          publishedAt={report.publishedAt}
          unpublishedAt={report.unpublishedAt}
          recipientCount={data.recipients.length}
          timeZone={timeZone}
          canUpdate={canUpdate}
        />
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            Recipients ({data.recipients.length})
          </CardTitle>
        </CardHeader>
        <CardContent>
          <ReportRecipientTable
            publicId={report.publicId}
            title={report.title}
            noticeKind={report.noticeKind}
            recipients={data.recipients}
            timeZone={timeZone}
            canUpdate={canUpdate}
            showPortal={showPortal}
            mayInvite={mayInvite}
            state={state}
            addable={addable}
            noticeEmails={noticeEmails}
          />
        </CardContent>
      </Card>
    </div>
  );
}
