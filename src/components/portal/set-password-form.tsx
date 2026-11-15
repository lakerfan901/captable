"use client";

import { type FormEvent, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { AuthCard, ExpiredLinkCard } from "./auth-card";
import { NewPasswordFields, newPasswordProblem } from "./password-form";
import {
  failureMessage,
  nextOf,
  postPortalJson,
  SOMETHING_WENT_WRONG,
} from "./post-json";

// "Set a password for {email}" (04-investor-portal.md 5.2 "Set or reset a
// password", 6.1; packages P2b, P8a). The rule in one sentence and a live
// check against the same policy the server applies (`NewPasswordFields`,
// shared with the account page); the server checks again and is the one
// that decides. Posts JSON to `POST /portal/auth/set-password`; a refused
// password leaves the link usable, an expired one shows the expired card.

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
    const problem = newPasswordProblem(password, confirm, props.email);
    if (problem !== null) {
      setError(problem);
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
          <NewPasswordFields
            email={props.email}
            password={password}
            confirm={confirm}
            onPasswordChange={setPassword}
            onConfirmChange={setConfirm}
          />
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
