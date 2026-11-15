import Link from "next/link";
import { redirect } from "next/navigation";
import { AuthCard, SignOutButton } from "@/components/portal/auth-card";
import { loadPortalMe } from "@/components/portal/portal-me";
import { PortalShell } from "@/components/portal/portal-shell";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { accessBasePath, companyInitials } from "@/lib/portal/portal-nav";

// /portal (04-investor-portal.md 6.1; packages P2b, P8a): the signed-in
// landing. The holders come from `portal.me` (ACTIVE accesses of LLC
// companies whose holder row exists). None: "Your access has been turned
// off." (P9). One: straight to that holder. Several: a chooser of cards
// "{holder name} — {company name}", each linking to `/portal/[access]`.

export default async function PortalHomePage() {
  // The layout already required a session; a session that ended between the
  // two reads goes back to sign-in.
  const me = await loadPortalMe();
  if (me === null) redirect("/portal/sign-in");

  if (me.holders.length === 0) {
    return (
      <AuthCard title="Access turned off">
        <p className="text-center text-sm" id="turned-off">
          Your access has been turned off. Please contact the Manager.
        </p>
        <SignOutButton className="w-full" />
      </AuthCard>
    );
  }

  const only = me.holders.length === 1 ? me.holders[0] : undefined;
  if (only) redirect(accessBasePath(only.access));

  return (
    <PortalShell email={me.email}>
      <div className="flex flex-col gap-y-3">
        <h1 className="text-2xl font-semibold tracking-tight">
          Choose a holder
        </h1>
        <p className="text-sm text-muted-foreground">
          You have access to more than one holder.
        </p>
        <ul className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2" id="holders">
          {me.holders.map((holder) => (
            <li key={holder.access}>
              <Link
                href={accessBasePath(holder.access)}
                className="flex h-full items-center gap-4 rounded-lg border bg-card p-6 text-card-foreground shadow-xs transition-colors hover:bg-muted/50 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                data-testid="holder-card"
              >
                <Avatar className="h-10 w-10 rounded">
                  {holder.companyLogo ? (
                    <AvatarImage src={holder.companyLogo} alt="" />
                  ) : null}
                  <AvatarFallback className="rounded bg-indigo-100 text-sm font-medium text-indigo-700">
                    {companyInitials(holder.companyName)}
                  </AvatarFallback>
                </Avatar>
                <span className="min-w-0 text-base font-semibold">
                  {holder.holderName} — {holder.companyName}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </PortalShell>
  );
}
