"use client";

import Link from "next/link";
import { type FormEvent, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/trpc/react";
import { AuthCard } from "./auth-card";
import { SOMETHING_WENT_WRONG, TOO_MANY_ATTEMPTS } from "./post-json";

// "Forgot password" (04-investor-portal.md 5.2, 6.1; package P2b). Calls
// `portalAuth.requestReset`, which answers the same for every address; the
// page then shows the one neutral sentence. The only other answer depends on
// the deployment alone (production while mail goes to the mail catcher).

export const RESET_SENT_SENTENCE =
  "If this address has portal access, a reset link is on its way.";

export function PortalForgotPasswordForm() {
  const [ready, setReady] = useState(false);
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const request = api.portalAuth.requestReset.useMutation();

  useEffect(() => setReady(true), []);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (request.isPending) return;
    setError(null);
    try {
      const result = await request.mutateAsync({ email: email.slice(0, 254) });
      if (result.ok) {
        setSent(true);
        return;
      }
      setError(
        "Password reset by email is not available right now. Please contact the Manager.",
      );
    } catch (e) {
      const code = (e as { data?: { code?: string } } | null)?.data?.code;
      setError(
        code === "TOO_MANY_REQUESTS" ? TOO_MANY_ATTEMPTS : SOMETHING_WENT_WRONG,
      );
    }
  }

  if (sent) {
    return (
      <AuthCard title="Check your email">
        <p className="text-center text-sm" id="reset-sent">
          {RESET_SENT_SENTENCE}
        </p>
        <Button asChild variant="outline">
          <Link href="/portal/sign-in">Back to sign in</Link>
        </Button>
      </AuthCard>
    );
  }

  return (
    <AuthCard
      title="Forgot your password?"
      subtitle="Enter your email and we will send a link to set a new password."
    >
      <form
        method="post"
        className="space-y-8"
        onSubmit={onSubmit}
        noValidate
        data-testid="portal-forgot-form"
      >
        <div className="grid gap-4">
          <div className="grid gap-1">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              name="email"
              type="email"
              placeholder="you@example.com"
              autoCapitalize="none"
              autoComplete="email"
              autoCorrect="off"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          {error ? (
            <p className="text-sm font-medium text-destructive" role="alert">
              {error}
            </p>
          ) : null}
          <Button
            type="submit"
            disabled={!ready || request.isPending}
            loading={request.isPending}
            loadingText="Sending..."
          >
            Send reset link
          </Button>
        </div>
      </form>
      <span className="text-center text-sm text-gray-500">
        <Link
          href="/portal/sign-in"
          className="underline underline-offset-4 hover:text-primary"
        >
          Back to sign in
        </Link>
      </span>
    </AuthCard>
  );
}
