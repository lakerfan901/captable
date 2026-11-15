import type { Metadata } from "next";
import { ExpiredLinkCard } from "@/components/portal/auth-card";
import { PortalSetPasswordForm } from "@/components/portal/set-password-form";
import { db } from "@/server/db";
import { peekToken } from "@/server/portal/account";

// /portal/set-password/[token] (04-investor-portal.md 5.2, 6.1; package
// P2b): the invitation and reset link. The token is looked up read-only
// (`peekToken` consumes nothing); the form posts it with the password to
// `POST /portal/auth/set-password`, which claims it.
//
// The token is a credential. The proxy logs this path as
// `/portal/set-password/[token]` and limits it in the `token-page` bucket.
// The page loads nothing from another origin and uses the `same-origin`
// referrer policy, so the token never leaves in a Referer, while the form's
// POST still carries the real `Origin` (a `no-referrer` page could make a
// browser send `Origin: null`, which the handler refuses).

export const metadata: Metadata = {
  title: { absolute: "Investor portal" },
  robots: { index: false, follow: false },
  referrer: "same-origin",
};

export default async function PortalSetPasswordPage(props: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await props.params;
  const found = await peekToken(db, token);
  if (found === null) return <ExpiredLinkCard />;
  return <PortalSetPasswordForm token={token} email={found.email} />;
}
