import Link from "next/link";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";

// The card of the portal's signed-out pages (sign-in, forgot password,
// set password, expired link, access turned off): the look of the team's
// login page, with "Investor portal" above the title (approved prototype,
// 04-investor-portal.md 6.1). Server component; the forms inside are client
// components.

export function AuthCard(props: {
  title: string;
  subtitle?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-linear-to-br from-indigo-50 via-white to-cyan-100 px-5">
      <div className="grid w-full max-w-md grid-cols-1 gap-5 rounded-xl border bg-white p-10 shadow-sm">
        <div className="flex flex-col gap-y-2 text-center">
          <p className="text-sm font-semibold text-muted-foreground">
            Investor portal
          </p>
          <h1 className="text-2xl font-semibold tracking-tight">
            {props.title}
          </h1>
          {props.subtitle ? (
            <p className="text-sm text-muted-foreground">{props.subtitle}</p>
          ) : null}
        </div>
        {props.children}
      </div>
    </div>
  );
}

/** The set-password page for an unknown, used or expired link. */
export function ExpiredLinkCard() {
  return (
    <AuthCard
      title="This link has expired"
      subtitle="Set-up and reset links work once and for a limited time."
    >
      <p className="text-center text-sm" id="link-expired">
        This link has expired or was already used.
      </p>
      <Button asChild>
        <Link href="/portal/forgot-password">Request a new link</Link>
      </Button>
    </AuthCard>
  );
}

/**
 * The portal's sign-out button: a plain form POST to the route handler, so
 * it works before (and without) any client script. The handler checks the
 * Origin, revokes the session, clears the cookie and answers 303 to the
 * sign-in page.
 */
export function SignOutButton(props: {
  variant?: "outline" | "default";
  size?: "sm" | "default";
  className?: string;
}) {
  return (
    <form method="post" action="/portal/auth/sign-out">
      <Button
        type="submit"
        variant={props.variant ?? "outline"}
        size={props.size ?? "default"}
        className={props.className}
      >
        Sign out
      </Button>
    </form>
  );
}
