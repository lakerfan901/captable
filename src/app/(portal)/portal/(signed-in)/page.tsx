import { TRPCError } from "@trpc/server";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { AuthCard, SignOutButton } from "@/components/portal/auth-card";
import { PortalShell } from "@/components/portal/portal-shell";
import { api } from "@/trpc/server";

// /portal (04-investor-portal.md 6.1; package P2b, finished by P8): the
// signed-in landing. The holders come from `portal.me` (ACTIVE accesses of
// LLC companies whose holder row exists). None: "Your access has been turned
// off." (P9). One or more: a card per holder.
//
// P8 replaces the cards with the plan's behaviour: one holder redirects to
// `/portal/[access]`, several become a chooser linking there. Those pages do
// not exist yet, so the cards link nowhere in this package.

export const metadata: Metadata = {
  title: { absolute: "Investor portal" },
  robots: { index: false, follow: false },
};

export default async function PortalHomePage() {
  // Per request only (it reads the portal cookie); also keeps the build from
  // trying to prerender it.
  await connection();
  // The layout already required a session; a session that ended between the
  // two reads (UNAUTHORIZED) goes back to sign-in.
  const me = await api.portal.me().catch((error: unknown) => {
    if (error instanceof TRPCError && error.code === "UNAUTHORIZED")
      return null;
    throw error;
  });
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

  return (
    <PortalShell email={me.email}>
      <div className="flex flex-col gap-y-3">
        <h1 className="text-2xl font-semibold tracking-tight">
          {me.holders.length > 1 ? "Choose a holder" : "Your access"}
        </h1>
        <p className="text-sm text-muted-foreground">
          {me.holders.length > 1
            ? "You have access to more than one holder."
            : "You have access to this holder."}
        </p>
        <ul className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2" id="holders">
          {me.holders.map((holder) => (
            <li
              key={holder.access}
              className="rounded-xl border bg-card p-6 text-card-foreground shadow-sm"
            >
              <span className="block text-base font-semibold">
                {holder.holderName} — {holder.companyName}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </PortalShell>
  );
}
