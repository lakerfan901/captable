"use client";

import Link from "next/link";
import { type FormEvent, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PasswordInput } from "@/components/ui/password-input";
import {
  failureMessage,
  nextOf,
  postPortalJson,
  SOMETHING_WENT_WRONG,
} from "./post-json";

// The portal sign-in form (04-investor-portal.md 5.2 "Sign in", 6.1;
// package P2b). Posts JSON to `POST /portal/auth/sign-in`; one error line for
// every refusal, as the server answers it. On success the browser goes to
// the `next` the SERVER returned (already through `safeNextPath`), never to
// the raw `?next=` value.
//
// `method="post"`: a submit before the script has loaded never puts the
// password in a URL; the button stays disabled until then.

export function PortalSignInForm({ next }: { next: string }) {
  const [ready, setReady] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => setReady(true), []);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await postPortalJson("/portal/auth/sign-in", {
        email,
        password,
        next,
      });
      if (result.status === 200 && result.data?.ok === true) {
        window.location.assign(nextOf(result));
        return;
      }
      setPassword("");
      setError(failureMessage(result));
    } catch {
      setError(SOMETHING_WENT_WRONG);
    }
    setSubmitting(false);
  }

  return (
    <>
      <form
        method="post"
        className="space-y-8"
        onSubmit={onSubmit}
        noValidate
        data-testid="portal-sign-in-form"
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
          <div className="grid gap-1">
            <Label htmlFor="password">Password</Label>
            <PasswordInput
              id="password"
              name="password"
              autoCapitalize="none"
              autoComplete="current-password"
              autoCorrect="off"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          {error ? (
            <p
              className="text-sm font-medium text-destructive"
              role="alert"
              id="signin-error"
            >
              {error}
            </p>
          ) : null}
          <Link
            href="/portal/forgot-password"
            className="text-right text-sm font-medium hover:text-gray-500"
          >
            Forgot password?
          </Link>
          <Button
            type="submit"
            disabled={!ready || submitting}
            loading={submitting}
            loadingText="Signing in..."
          >
            Sign in
          </Button>
        </div>
      </form>
      <span className="text-center text-sm text-gray-500">
        Access is by invitation from the Manager.
      </span>
    </>
  );
}
