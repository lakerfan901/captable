import Link from "next/link";
import type { ReactNode } from "react";
import { SignOutButton } from "./auth-card";

// The signed-in portal frame (04-investor-portal.md 6.1; approved
// prototype): a company-neutral header "Investor portal", the signed-in
// address and "Sign out"; no sidebar and no link to the team app. Server
// component. "Change password" (`/portal/account`) and the tab row under
// `/portal/[access]` are package P8.

export function PortalShell(props: { email: string; children: ReactNode }) {
  return (
    <div className="min-h-screen bg-gray-50">
      <div className="sticky top-0 z-50 w-full border-b">
        <header className="flex h-14 items-center bg-gray-50 px-5">
          <div className="mx-auto flex w-full max-w-5xl items-center justify-between gap-3">
            <Link href="/portal" className="text-base font-semibold">
              Investor portal
            </Link>
            <div className="flex min-w-0 items-center gap-2">
              <span
                className="hidden truncate text-sm text-muted-foreground sm:inline"
                id="signed-in-as"
              >
                {props.email}
              </span>
              <SignOutButton size="sm" />
            </div>
          </div>
        </header>
      </div>
      <div className="mx-auto w-full max-w-5xl px-5 py-10">
        {props.children}
      </div>
    </div>
  );
}
