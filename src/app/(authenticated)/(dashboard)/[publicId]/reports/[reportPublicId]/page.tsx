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
import { ReportRecipientTable } from "@/components/governance/report-recipient-table";
import { ReportStatusBadge } from "@/components/governance/report-table";
import { ReportView } from "@/components/governance/report-view";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { UnAuthorizedState } from "@/components/ui/un-authorized-state";
import { GOVERNANCE_TIME_ZONE, todayInZone } from "@/lib/governance/dates";
import { serverAccessControl } from "@/lib/rbac/access-control";
import { requireLlc } from "@/server/entity";
import { api } from "@/trpc/server";

export const metadata: Metadata = { title: "Report" };

// Member report (03-governance.md G13 page 2). A DRAFT shows the editor; a
// SENT report shows the frozen content, the recipients, the attachments and
// the filed PDF.

function formatInstant(at: Date | string | null, timeZone: string): string {
  if (at === null) return "—";
  const d = typeof at === "string" ? new Date(at) : at;
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    dateStyle: "long",
    timeStyle: "short",
  }).format(d);
}

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
  const { report } = data;

  if (report.status === "DRAFT") {
    return (
      <ReportEditor
        data={data}
        base={base}
        companyPublicId={entity.publicId}
        today={todayInZone(new Date(), timeZone)}
        canUpdate={canUpdate}
        canDelete={allow(true, ["governance", "delete"], false)}
        timeZone={timeZone}
      />
    );
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
            <ReportStatusBadge status={report.status} />
            <span className="text-sm text-muted-foreground">
              Sent {formatInstant(report.sentAt, timeZone)}
            </span>
          </div>
          {filedDocumentPublicId ? (
            <FiledDocumentButton documentPublicId={filedDocumentPublicId} />
          ) : report.filedDocumentId ? null : (
            <span className="text-sm text-muted-foreground">
              The PDF is being filed in Documents.
            </span>
          )}
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

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            Recipients ({data.recipients.length})
          </CardTitle>
        </CardHeader>
        <CardContent>
          <ReportRecipientTable
            publicId={report.publicId}
            recipients={data.recipients}
            timeZone={timeZone}
            canUpdate={canUpdate}
          />
        </CardContent>
      </Card>
    </div>
  );
}
