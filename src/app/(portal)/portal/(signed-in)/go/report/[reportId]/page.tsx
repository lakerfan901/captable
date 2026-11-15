import { TRPCError } from "@trpc/server";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { AuthCard } from "@/components/portal/auth-card";
import { PortalShell } from "@/components/portal/portal-shell";
import { Button } from "@/components/ui/button";
import { DEFAULT_NEXT_PATH, safeNextPath } from "@/lib/portal/next-path";
import { api } from "@/trpc/server";

// /portal/go/report/[reportId] (04-investor-portal.md 6.1, P25, P26; package
// P5b): the landing after an emailed report link, sign-in or password
// set-up. Addressed by the report's public id, never by the emailed token.
//
// Under the signed-in layout: without a portal session the browser is sent
// to `/portal/sign-in?next=/portal/go/report/{reportId}` first.
// `portal.findReport` lists the signed-in user's accesses whose holder may
// see the report (P11): one redirects to that holder's report page
// (`/portal/[access]/reports/[reportId]`, package P8b), several show a
// chooser, none shows "This report is not available to this account." (an
// unknown, unpublished or foreign report looks the same). Every target goes
// through `safeNextPath`.

export const metadata: Metadata = {
  title: { absolute: "Investor portal" },
  robots: { index: false, follow: false },
};

/** The portal report page of one holder, or null when it would not be a safe path. */
function reportPageOf(access: string, reportId: string): string | null {
  const path = safeNextPath(`/portal/${access}/reports/${reportId}`);
  return path === DEFAULT_NEXT_PATH ? null : path;
}

export default async function PortalGoReportPage(props: {
  params: Promise<{ reportId: string }>;
}) {
  await connection();
  const { reportId } = await props.params;
  const found = await api.portal
    .findReport({ reportId })
    .catch((error: unknown) => {
      if (error instanceof TRPCError && error.code === "UNAUTHORIZED") {
        return null;
      }
      // A malformed id is the same answer as an invisible report.
      if (error instanceof TRPCError && error.code === "BAD_REQUEST") {
        return { matches: [] };
      }
      throw error;
    });
  if (found === null) {
    const next = safeNextPath(`/portal/go/report/${reportId}`);
    redirect(
      next === DEFAULT_NEXT_PATH
        ? "/portal/sign-in"
        : `/portal/sign-in?next=${encodeURIComponent(next)}`,
    );
  }

  const matches = found.matches
    .map((m) => ({ ...m, href: reportPageOf(m.access, reportId) }))
    .filter((m): m is typeof m & { href: string } => m.href !== null);

  if (matches.length === 1 && matches[0]) redirect(matches[0].href);

  if (matches.length === 0) {
    return (
      <AuthCard title="Report not available">
        <p className="text-center text-sm" id="go-none">
          This report is not available to this account.
        </p>
        <Button asChild variant="outline">
          <Link href="/portal">Go to the portal</Link>
        </Button>
      </AuthCard>
    );
  }

  const me = await api.portal.me().catch(() => null);
  return (
    <PortalShell email={me?.email ?? ""}>
      <div className="flex flex-col gap-y-3">
        <h1 className="text-2xl font-semibold tracking-tight">
          Open this report as
        </h1>
        <p className="text-sm text-muted-foreground">
          This report was released to more than one holder you have access to.
          Choose one.
        </p>
        <ul className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2" id="chooser">
          {matches.map((m) => (
            <li key={m.access}>
              <Link
                href={m.href}
                className="block rounded-xl border bg-card p-6 text-card-foreground shadow-sm hover:bg-muted"
              >
                <span className="block text-base font-semibold">
                  {m.holderName}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </PortalShell>
  );
}
