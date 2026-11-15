"use client";

import { type FormEvent, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { PasswordInput } from "@/components/ui/password-input";
import {
  checkPassword,
  PASSWORD_MIN_CHARS,
  PASSWORD_PROBLEM_MESSAGES,
  PASSWORD_RULE_SENTENCE,
} from "@/lib/portal/password-core";
import { AuthCard, ExpiredLinkCard } from "./auth-card";
import {
  failureMessage,
  nextOf,
  postPortalJson,
  SOMETHING_WENT_WRONG,
} from "./post-json";

// "Set a password for {email}" (04-investor-portal.md 5.2 "Set or reset a
// password", 6.1; package P2b). The rule in one sentence and a live check
// against the same policy the server applies (`checkPassword` is pure and
// shared); the server checks again and is the one that decides. Posts JSON
// to `POST /portal/auth/set-password`; a refused password leaves the link
// usable, an expired one shows the expired card.

const MISMATCH = "The two passwords do not match.";

function liveHint(password: string, email: string): string {
  if (password.length === 0) return "";
  const check = checkPassword(password, email);
  if (check.ok) return "Looks good.";
  if (check.reason === "TOO_SHORT") {
    const left = PASSWORD_MIN_CHARS - [...password].length;
    return `${left} more to go.`;
  }
  return PASSWORD_PROBLEM_MESSAGES[check.reason];
}

export function PortalSetPasswordForm(props: { token: string; email: string }) {
  const [ready, setReady] = useState(false);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [expired, setExpired] = useState(false);

  useEffect(() => setReady(true), []);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;
    const check = checkPassword(password, props.email);
    if (!check.ok) {
      setError(PASSWORD_PROBLEM_MESSAGES[check.reason]);
      return;
    }
    if (confirm !== password) {
      setError(MISMATCH);
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const result = await postPortalJson("/portal/auth/set-password", {
        token: props.token,
        password,
        confirm,
      });
      if (result.status === 200 && result.data?.ok === true) {
        window.location.assign(nextOf(result));
        return;
      }
      if (result.status === 410) {
        setExpired(true);
        return;
      }
      setError(failureMessage(result));
    } catch {
      setError(SOMETHING_WENT_WRONG);
    }
    setSubmitting(false);
  }

  if (expired) return <ExpiredLinkCard />;

  const hint = liveHint(password, props.email);
  return (
    <AuthCard
      title="Set a password"
      subtitle={
        <>
          Set a password for{" "}
          <span className="break-all font-medium text-foreground">
            {props.email}
          </span>
        </>
      }
    >
      <form
        method="post"
        className="space-y-8"
        onSubmit={onSubmit}
        noValidate
        data-testid="portal-set-password-form"
      >
        {/* For password managers: the account this password belongs to. */}
        <input
          type="email"
          name="username"
          autoComplete="username"
          value={props.email}
          readOnly
          hidden
        />
        <div className="grid gap-4">
          <div className="grid gap-1">
            <Label htmlFor="pw1">New password</Label>
            <PasswordInput
              id="pw1"
              name="pw1"
              autoComplete="new-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              aria-describedby="pw-rule"
            />
          </div>
          <div className="grid gap-1">
            <Label htmlFor="pw2">Repeat password</Label>
            <PasswordInput
              id="pw2"
              name="pw2"
              autoComplete="new-password"
              required
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
            />
          </div>
          <p className="text-xs text-muted-foreground" id="pw-rule">
            {PASSWORD_RULE_SENTENCE}{" "}
            <span id="pw-check" aria-live="polite">
              {hint}
            </span>
          </p>
          {error ? (
            <p
              className="text-sm font-medium text-destructive"
              role="alert"
              id="set-password-error"
            >
              {error}
            </p>
          ) : null}
          <Button
            type="submit"
            size="lg"
            disabled={!ready || submitting}
            loading={submitting}
            loadingText="Setting password..."
          >
            Set password and continue
          </Button>
        </div>
      </form>
    </AuthCard>
  );
}
