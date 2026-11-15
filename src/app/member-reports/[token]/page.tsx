import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import {
  MarkReportViewed,
  PublicReportDocuments,
} from "@/components/governance/report-attachments";
import { ReportLinkInterstitial } from "@/components/governance/report-link-interstitial";
import { ReportView } from "@/components/governance/report-view";
import { SharePageLayout } from "@/components/share/page-layout";
import { DEFAULT_NEXT_PATH, safeNextPath } from "@/lib/portal/next-path";
import { db } from "@/server/db";
import { loadPortalSession } from "@/server/portal/session";
import { reportLandingPath } from "@/trpc/routers/member-report-view-router/access";
import { api } from "@/trpc/server";

// Public member report page (03-governance.md G13; 04-investor-portal.md
// P25, P26, 6.1): what a holder opens from the emailed link. The token in
// the path is the only credential. It is passed to `memberReportView.route`
// and `view` (server side) and to the client pieces, which call `markViewed`,
// `attachmentUrl` and `requestSetup` from the browser. It is never logged or
// rendered, and never put in another URL: the sign-in link and every
// redirect carry only `/portal/go/report/{report public id}` (through
// `safeNextPath`). `no-referrer` (here and in next.config.js) keeps it out of
// the Referer of every request this page makes. Every public report
// procedure is a mutation, so the token is never put in a URL by a tRPC call.
//
// `route` first decides which row of P25 applies, from the recipient row on
// the server (never from anything the visitor sends):
// - LEGACY: today's read-only page (`view`), with only the files `view`
//   returned (shared, or private to this holder). When the report is in the
//   portal (published, addressee never invited at this address) a "Sign in
//   to the portal" link is added for a reader who has an account; a report
//   sent before the portal renders exactly as before.
// - PORTAL: a browser already signed in to the portal with access to that
//   report goes straight to it (`portal.findReport`, the portal cookie
//   only); otherwise the interstitial with Sign in and, when needed, "Email
//   me my set-up link".
// - WITHDRAWN, ACCESS_OFF: a message and no content.
// - REPLACED: the "link replaced" page as today.
// Anything else (invalid, expired, foreign token): not found.

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

/** The portal page of the report, through `safeNextPath` (never the token). */
function landingOf(reportId: string): string | null {
  const path = safeNextPath(reportLandingPath(reportId));
  return path === DEFAULT_NEXT_PATH ? null : path;
}

function signInHref(landing: string | null): string {
  return landing === null
    ? "/portal/sign-in"
    : `/portal/sign-in?next=${encodeURIComponent(landing)}`;
}

/** P25 "a browser already signed in with access to that holder goes straight to the report". */
async function signedInMatch(reportId: string): Promise<boolean> {
  const session = await loadPortalSession(db, (await headers()).get("cookie"));
  if (session === null) return false;
  const found = await api.portal
    .findReport({ reportId })
    .catch(() => ({ matches: [] }));
  return found.matches.length > 0;
}

export default async function MemberReportPage(props: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await props.params;
  const link = await api.memberReportView.route({ token }).catch(() => null);
  if (!link) return notFound();

  if (link.state === "REPLACED") {
    return (
      <SharePageLayout
        medium="member-report"
        company={link.company}
        title={
          <h1 className="text-2xl font-semibold tracking-tight">
            Member report
          </h1>
        }
      >
        <p className="text-base">
          This link has been replaced. Please use the most recent email from{" "}
          {link.company.name}, or contact the Manager.
        </p>
      </SharePageLayout>
    );
  }

  if (link.state === "WITHDRAWN" || link.state === "ACCESS_OFF") {
    return (
      <ReportLinkInterstitial
        state={link.state}
        companyName={link.company.name}
      />
    );
  }

  if (link.state === "PORTAL") {
    const landing = link.reportId === null ? null : landingOf(link.reportId);
    if (
      landing !== null &&
      link.reportId !== null &&
      (await signedInMatch(link.reportId))
    ) {
      redirect(landing);
    }
    return (
      <ReportLinkInterstitial
        state="PORTAL"
        companyName={link.company.name}
        signInHref={signInHref(landing)}
        setupNeeded={link.setupNeeded}
        token={token}
      />
    );
  }

  // LEGACY: the read-only page.
  const data = await api.memberReportView.view({ token }).catch(() => null);
  if (data?.state !== "OK") return notFound();
  const landing = link.reportId === null ? null : landingOf(link.reportId);

  const { report } = data;
  return (
    <SharePageLayout
      medium="member-report"
      company={data.company}
      title={
        landing === null ? (
          <p className="text-sm text-muted-foreground">
            For {data.recipient.name}
          </p>
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-muted-foreground">
              For {data.recipient.name}
            </p>
            <a
              href={signInHref(landing)}
              className="text-sm font-medium underline underline-offset-4"
              id="link-signin"
            >
              Sign in to the portal
            </a>
          </div>
        )
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
