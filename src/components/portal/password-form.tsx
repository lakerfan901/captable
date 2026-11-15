"use client";

import Link from "next/link";
import { type FormEvent, useEffect, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { PasswordInput } from "@/components/ui/password-input";
import {
  checkPassword,
  PASSWORD_MIN_CHARS,
  PASSWORD_PROBLEM_MESSAGES,
  PASSWORD_RULE_SENTENCE,
} from "@/lib/portal/password-core";
import { api } from "@/trpc/react";
import { SOMETHING_WENT_WRONG, TOO_MANY_ATTEMPTS } from "./post-json";

// Password fields of the portal (04-investor-portal.md 5.2, 6.1; package
// P8a). `NewPasswordFields` is the "new password, repeat, the rule in one
// sentence, live check" block shared by the set-password page and the
// account page; both check against the same pure policy the server applies
// (`checkPassword`), and the server checks again and decides.
// `ChangePasswordForm` is `/portal/account`: it calls `portal.changePassword`.

export const PASSWORDS_DO_NOT_MATCH = "The two passwords do not match.";

/**
 * The server's one answer for a wrong current password and a locked account
 * (`CHANGE_PASSWORD_REFUSED_MESSAGE` in `portal-router/procedures/
 * change-password.ts`; repeated here because that file is server-only).
 */
export const CURRENT_PASSWORD_REFUSED =
  "The current password is incorrect, or the account is temporarily locked.";

/** The live hint under the rule sentence. */
export function livePasswordHint(password: string, email: string): string {
  if (password.length === 0) return "";
  const check = checkPassword(password, email);
  if (check.ok) return "Looks good.";
  if (check.reason === "TOO_SHORT") {
    const left = PASSWORD_MIN_CHARS - [...password].length;
    return `${left} more to go.`;
  }
  return PASSWORD_PROBLEM_MESSAGES[check.reason];
}

/**
 * The policy and repeat checks run before anything is sent: the message to
 * show, or null when the pair may be submitted.
 */
export function newPasswordProblem(
  password: string,
  confirm: string,
  email: string,
): string | null {
  const check = checkPassword(password, email);
  if (!check.ok) return PASSWORD_PROBLEM_MESSAGES[check.reason];
  if (confirm !== password) return PASSWORDS_DO_NOT_MATCH;
  return null;
}

export function NewPasswordFields(props: {
  email: string;
  password: string;
  confirm: string;
  onPasswordChange: (value: string) => void;
  onConfirmChange: (value: string) => void;
}) {
  const hint = livePasswordHint(props.password, props.email);
  return (
    <>
      <div className="grid gap-1">
        <Label htmlFor="pw1">New password</Label>
        <PasswordInput
          id="pw1"
          name="pw1"
          autoComplete="new-password"
          required
          value={props.password}
          onChange={(e) => props.onPasswordChange(e.target.value)}
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
          value={props.confirm}
          onChange={(e) => props.onConfirmChange(e.target.value)}
        />
      </div>
      <p className="text-xs text-muted-foreground" id="pw-rule">
        {PASSWORD_RULE_SENTENCE}{" "}
        <span id="pw-check" aria-live="polite">
          {hint}
        </span>
      </p>
    </>
  );
}

/** Reads a tRPC client error without trusting its shape. */
function errorOf(e: unknown): { code?: string; message?: string } {
  if (e === null || typeof e !== "object") return {};
  const data = (e as { data?: { code?: unknown } }).data;
  const message = (e as { message?: unknown }).message;
  return {
    code: typeof data?.code === "string" ? data.code : undefined,
    message: typeof message === "string" ? message : undefined,
  };
}

export function ChangePasswordForm(props: { email: string }) {
  const [ready, setReady] = useState(false);
  const [current, setCurrent] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  // The server refused the current password (or the account is locked):
  // offer the reset link, which works during a lock and clears it.
  const [refused, setRefused] = useState(false);
  const [done, setDone] = useState(false);
  const change = api.portal.changePassword.useMutation();

  useEffect(() => setReady(true), []);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (change.isPending) return;
    setRefused(false);
    if (current.length === 0) {
      setError("Enter your current password.");
      return;
    }
    const problem = newPasswordProblem(password, confirm, props.email);
    if (problem !== null) {
      setError(problem);
      return;
    }
    setError(null);
    try {
      await change.mutateAsync({
        currentPassword: current,
        newPassword: password,
      });
      setCurrent("");
      setPassword("");
      setConfirm("");
      setDone(true);
    } catch (e) {
      const { code, message } = errorOf(e);
      if (code === "UNAUTHORIZED") {
        window.location.assign("/portal/sign-in?next=%2Fportal%2Faccount");
        return;
      }
      // A wrong current password and a locked account are one message by
      // design (5.2); a weak new password names the rule. Both come from
      // the server as BAD_REQUEST with a message meant for the user.
      if (code === "BAD_REQUEST" && message) {
        setCurrent("");
        setError(message);
        setRefused(message === CURRENT_PASSWORD_REFUSED);
        return;
      }
      setError(
        code === "TOO_MANY_REQUESTS" ? TOO_MANY_ATTEMPTS : SOMETHING_WENT_WRONG,
      );
    }
  }

  if (done) {
    return (
      <div className="grid gap-4">
        <Alert id="password-changed" role="status">
          <AlertTitle>Password changed</AlertTitle>
          <AlertDescription>
            Your new password is set. Any other browser signed in to this
            account has been signed out.
          </AlertDescription>
        </Alert>
        <div className="flex flex-wrap gap-2">
          <Button asChild>
            <Link href="/portal">Back to the portal</Link>
          </Button>
        </div>
      </div>
    );
  }

  return (
    <form
      method="post"
      className="space-y-8"
      onSubmit={onSubmit}
      noValidate
      data-testid="portal-change-password-form"
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
          <Label htmlFor="current">Current password</Label>
          <PasswordInput
            id="current"
            name="current"
            autoComplete="current-password"
            required
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
          />
        </div>
        <NewPasswordFields
          email={props.email}
          password={password}
          confirm={confirm}
          onPasswordChange={setPassword}
          onConfirmChange={setConfirm}
        />
        {error ? (
          <div className="grid gap-1" role="alert" id="change-password-error">
            <p className="text-sm font-medium text-destructive">{error}</p>
            {refused ? (
              <p className="text-sm text-muted-foreground">
                Forgot your current password?{" "}
                <Link
                  href="/portal/forgot-password"
                  className="font-medium underline underline-offset-4 hover:text-primary"
                >
                  Reset it by email
                </Link>
                .
              </p>
            ) : null}
          </div>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button
            type="submit"
            disabled={!ready || change.isPending}
            loading={change.isPending}
            loadingText="Changing password..."
          >
            Change password
          </Button>
          <Button asChild variant="outline">
            <Link href="/portal">Cancel</Link>
          </Button>
        </div>
      </div>
    </form>
  );
}
