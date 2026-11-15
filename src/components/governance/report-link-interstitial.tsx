"use client";

import { createTRPCClient, httpLink } from "@trpc/client";
import { useState } from "react";
import { AuthCard } from "@/components/portal/auth-card";
import { Button } from "@/components/ui/button";
import type { AppRouter } from "@/trpc/api/root";
import { getUrl, transformer } from "@/trpc/shared";

// The emailed report link (`/member-reports/{token}`) when it does not show
// the report itself (04-investor-portal.md P25, P26, 6.1; package P5b):
//
// - WITHDRAWN: "This report is no longer available."
// - ACCESS_OFF: "Your portal access has been turned off. Please contact the
//   Manager."
// - PORTAL: "This report is in the investor portal" with **Sign in** (a plain
//   link to `/portal/sign-in?next=/portal/go/report/{report public id}`; the
//   `next` carries the public id, never the token) and, while the addressee
//   has not set a password, **Email me my set-up link**.
//
// No report content is shown in any of them (P26), not even the title. The
// set-up request is a token-credentialed public mutation, like `markViewed`
// on the read-only page, so it works from this `no-referrer` page (whose
// POSTs carry `Origin: null`); nothing here posts to an Origin-checked
// portal endpoint. Its answer is the same whatever happened, and the page
// says the same sentence after every click.

export type ReportLinkInterstitialProps =
  | { state: "WITHDRAWN"; companyName: string }
  | { state: "ACCESS_OFF"; companyName: string }
  | {
      state: "PORTAL";
      companyName: string;
      /** `/portal/sign-in?next=…`, built on the server through `safeNextPath`. */
      signInHref: string;
      setupNeeded: boolean;
      token: string;
    };

let publicClient: ReturnType<typeof createTRPCClient<AppRouter>> | null = null;
function client() {
  if (publicClient === null) {
    publicClient = createTRPCClient<AppRouter>({
      links: [httpLink({ url: getUrl(), transformer })],
    });
  }
  return publicClient;
}

const SETUP_SENT =
  "A set-up link is on its way to the invited address. Open it from that mailbox to set your password; you will then land on this report.";
const SETUP_UNAVAILABLE =
  "Email is not available at the moment. Please contact the Manager.";
const SETUP_FAILED = "Something went wrong. Please try again in a minute.";

function SetupLinkButton({ token }: { token: string }) {
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  const request = async () => {
    setBusy(true);
    setFailed(false);
    try {
      const result = await client().memberReportView.requestSetup.mutate({
        token,
      });
      setAnswer(result.ok ? SETUP_SENT : SETUP_UNAVAILABLE);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Button
        type="button"
        variant="outline"
        disabled={busy}
        onClick={() => void request()}
        id="link-setup"
      >
        {busy ? "Sending…" : "Email me my set-up link"}
      </Button>
      {answer !== null ? (
        <p
          className="text-center text-sm text-muted-foreground"
          id="setup-sent"
          role="status"
        >
          {answer}
        </p>
      ) : (
        <p className="text-center text-xs text-muted-foreground">
          You have not set a password yet. The link goes to the invited address,
          never to this browser.
        </p>
      )}
      {failed ? (
        <p className="text-center text-sm text-destructive" role="alert">
          {SETUP_FAILED}
        </p>
      ) : null}
    </>
  );
}

export function ReportLinkInterstitial(props: ReportLinkInterstitialProps) {
  if (props.state === "WITHDRAWN") {
    return (
      <AuthCard title="Report not available" subtitle={props.companyName}>
        <p className="text-center text-sm" id="link-msg">
          This report is no longer available.
        </p>
      </AuthCard>
    );
  }
  if (props.state === "ACCESS_OFF") {
    return (
      <AuthCard title="Access turned off" subtitle={props.companyName}>
        <p className="text-center text-sm" id="link-msg">
          Your portal access has been turned off. Please contact the Manager.
        </p>
      </AuthCard>
    );
  }
  return (
    <AuthCard
      title="This report is in the investor portal"
      subtitle={props.companyName}
    >
      <p className="text-center text-sm" id="link-msg">
        This report is in the investor portal. Sign in to open it.
      </p>
      <Button asChild>
        {/* A plain link: the sign-in form posts from the sign-in page, never from this no-referrer page. */}
        <a href={props.signInHref} id="link-signin">
          Sign in
        </a>
      </Button>
      {props.setupNeeded ? <SetupLinkButton token={props.token} /> : null}
    </AuthCard>
  );
}
