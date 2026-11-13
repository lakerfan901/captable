import type { Metadata } from "next";
import { notFound } from "next/navigation";
import {
  MarkReportViewed,
  PublicReportDocuments,
} from "@/components/governance/report-attachments";
import { ReportView } from "@/components/governance/report-view";
import { SharePageLayout } from "@/components/share/page-layout";
import { api } from "@/trpc/server";

// Public member report page (03-governance.md G13): what a Member (or, for a
// Schedule K-1, a holder) opens from the emailed link, without logging in.
// The token in the path is the only credential. It is passed to
// `memberReportView.view` (server side, read-only) and to the client pieces,
// which call `markViewed` and `attachmentUrl` from the browser. It is never
// logged or rendered. `no-referrer` keeps it out of the Referer of every
// request this page makes. Every public report procedure is a mutation, so
// the token is never put in a URL by a tRPC call. Only the files `view`
// returned (shared, or private to this holder) are listed.

export const metadata: Metadata = {
  title: "Member report",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

function formatInstant(at: Date | string | null, timeZone: string): string {
  if (at === null) return "—";
  const d = typeof at === "string" ? new Date(at) : at;
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    dateStyle: "long",
  }).format(d);
}

export default async function MemberReportPage(props: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await props.params;
  const data = await api.memberReportView.view({ token }).catch(() => null);
  if (!data) return notFound();

  if (data.state === "REPLACED") {
    return (
      <SharePageLayout
        medium="member-report"
        company={data.company}
        title={
          <h1 className="text-2xl font-semibold tracking-tight">
            Member report
          </h1>
        }
      >
        <p className="text-base">
          This link has been replaced. Please use the most recent email from{" "}
          {data.company.name}, or contact the Manager.
        </p>
      </SharePageLayout>
    );
  }

  const { report } = data;
  return (
    <SharePageLayout
      medium="member-report"
      company={data.company}
      title={
        <p className="text-sm text-muted-foreground">
          For {data.recipient.name}
        </p>
      }
    >
      <MarkReportViewed token={token} />
      <ReportView
        companyName={data.company.name}
        title={report.title}
        type={report.type}
        noticeKind={report.noticeKind}
        periodStart={report.periodStart}
        periodEnd={report.periodEnd}
        sentText={formatInstant(report.sentAt, data.timeZone)}
        figures={report.figures}
        doc={report.doc}
      >
        <PublicReportDocuments token={token} attachments={data.attachments} />
      </ReportView>
    </SharePageLayout>
  );
}
