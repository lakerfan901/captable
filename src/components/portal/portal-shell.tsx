import Link from "next/link";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { SignOutButton } from "./auth-card";

// The signed-in portal frame (04-investor-portal.md 6.1; approved
// prototype; packages P2b, P8a): a company-neutral header "Investor portal",
// the signed-in address, "Change password" (`/portal/account`) and "Sign
// out"; no sidebar and no link to the team app. The company and the holder
// are named in the holder header under `/portal/[access]`, not here, because
// one person may hold accesses in several companies. Server component.

export function PortalShell(props: {
  email: string;
  /** Marks the header's own page (the account page) as current. */
  current?: "account";
  children: ReactNode;
}) {
  return (
    // A page that marks itself `data-portal-wide` (the dashboard pages, P15)
    // widens the frame to the dashboard's width, as in the prototype.
    <div className="min-h-screen bg-gray-50 [--portal-max:64rem] has-[[data-portal-wide]]:[--portal-max:77.5rem]">
      <a
        href="#portal-content"
        className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-60 focus:rounded-md focus:bg-background focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:shadow-md focus:outline-hidden focus:ring-2 focus:ring-ring"
      >
        Skip to content
      </a>
      <div className="sticky top-0 z-50 w-full border-b">
        <header className="flex h-14 items-center bg-gray-50 px-4 sm:px-5">
          <div className="mx-auto flex w-full max-w-(--portal-max) items-center justify-between gap-2 sm:gap-3">
            <Link
              href="/portal"
              className="shrink-0 rounded-sm text-base font-semibold focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            >
              Investor portal
            </Link>
            <div className="flex min-w-0 items-center gap-1 sm:gap-2">
              <span
                className="hidden truncate text-sm text-muted-foreground md:inline"
                id="signed-in-as"
              >
                {props.email}
              </span>
              <Button
                asChild
                variant="ghost"
                size="sm"
                className={
                  props.current === "account" ? "bg-accent" : undefined
                }
              >
                <Link
                  href="/portal/account"
                  aria-current={
                    props.current === "account" ? "page" : undefined
                  }
                  id="change-password-link"
                  aria-label="Change password"
                >
                  {/* The narrowest phones (under 360px) get the short label
                      so the three header items fit on one line. */}
                  <span className="min-[360px]:hidden">Password</span>
                  <span className="hidden min-[360px]:inline">
                    Change password
                  </span>
                </Link>
              </Button>
              <SignOutButton size="sm" />
            </div>
          </div>
        </header>
      </div>
      <div
        id="portal-content"
        tabIndex={-1}
        className="mx-auto w-full max-w-(--portal-max) px-4 py-8 outline-hidden sm:px-5 sm:py-10"
      >
        {props.children}
      </div>
    </div>
  );
}
