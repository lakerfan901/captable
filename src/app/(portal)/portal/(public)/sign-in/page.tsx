import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { AuthCard } from "@/components/portal/auth-card";
import { PortalSignInForm } from "@/components/portal/sign-in-form";
import { safeNextPath } from "@/lib/portal/next-path";
import { db } from "@/server/db";
import { loadPortalSession } from "@/server/portal/session";

// /portal/sign-in (04-investor-portal.md 6.1; package P2b). Email, password,
// "Forgot password?". `?next=` goes through `safeNextPath` here, and again
// in the route handler. A browser that already has a valid portal session is
// sent on at once. Reads only the portal cookie, never a team session.

export const metadata: Metadata = {
  title: { absolute: "Investor portal" },
  robots: { index: false, follow: false },
};

export default async function PortalSignInPage(props: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const searchParams = await props.searchParams;
  const next = safeNextPath(searchParams.next);
  const session = await loadPortalSession(db, (await headers()).get("cookie"));
  if (session !== null) redirect(next);
  return (
    <AuthCard title="Sign in">
      <PortalSignInForm next={next} />
    </AuthCard>
  );
}
