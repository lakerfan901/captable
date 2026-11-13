"use client";

import { createTRPCClient, httpLink, TRPCClientError } from "@trpc/client";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import type { AppRouter } from "@/trpc/api/root";
import {
  type BallotChoice,
  ZBallotSubmitSchema,
} from "@/trpc/routers/ballot-router/schema";
import { getUrl, transformer } from "@/trpc/shared";

// Public ballot form (03-governance.md G11). Runs in the Member's browser so
// that `markViewed` and `submit` are HTTP calls and the evidence records the
// Member's real IP address and user agent (A1 trap).
//
// The token is a credential. These calls use a private tRPC client with no
// logger link (the app-wide client logs failed operations, inputs included,
// to the console) and no batching. Every public ballot procedure is a
// mutation, so the token always travels in the POST body, never in a URL.
// Nothing here logs, reports or displays the token or a raw error object.

let ballotClient: ReturnType<typeof createTRPCClient<AppRouter>> | null = null;
function client() {
  if (ballotClient === null) {
    ballotClient = createTRPCClient<AppRouter>({
      links: [httpLink({ url: getUrl(), transformer })],
    });
  }
  return ballotClient;
}

export const ASSENT_TEXT =
  "I am the Member named above, or I am authorised to sign for it. I agree that typing my name is my electronic signature (Operating Agreement Sections 6.12 and 13.9).";

export const CHOICE_LABEL: Record<BallotChoice, string> = {
  FOR: "I consent (For)",
  AGAINST: "I do not consent (Against)",
  ABSTAIN: "Abstain",
};

const UNKNOWN_FAILURE =
  "We could not confirm whether your response was recorded. Reload this page: it will show your recorded response if it was received, or this form if it was not. A response can never be recorded twice.";

type FieldErrors = Partial<
  Record<"choice" | "signedName" | "signerCapacity" | "assent", string>
>;

function firstFieldErrors(
  fieldErrors: Record<string, string[] | undefined> | undefined,
): FieldErrors {
  const out: FieldErrors = {};
  if (!fieldErrors) return out;
  for (const key of [
    "choice",
    "signedName",
    "signerCapacity",
    "assent",
  ] as const) {
    const msg = fieldErrors[key]?.[0];
    if (msg) out[key] = msg;
  }
  return out;
}

export function BallotForm({
  token,
  frozenHash,
  memberName,
  deemedAgainstAtClose,
}: {
  token: string;
  frozenHash: string;
  memberName: string;
  deemedAgainstAtClose: boolean;
}) {
  const router = useRouter();
  const viewed = useRef(false);
  const [choice, setChoice] = useState<BallotChoice | "">("");
  const [signedName, setSignedName] = useState("");
  const [signerCapacity, setSignerCapacity] = useState("");
  const [assent, setAssent] = useState(false);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Record the first view once (the ref also absorbs React's dev double effect).
  useEffect(() => {
    if (viewed.current) return;
    viewed.current = true;
    client()
      .ballot.markViewed.mutate({ token })
      .catch(() => {
        // Viewing evidence is best effort; the form works without it.
      });
  }, [token]);

  const capacity = signerCapacity.trim();
  const input = {
    token,
    choice,
    signedName,
    signerCapacity: capacity === "" ? undefined : capacity,
    bodyHash: frozenHash,
    assent,
  };

  const review = () => {
    setFormError(null);
    const parsed = ZBallotSubmitSchema.safeParse(input);
    if (!parsed.success) {
      const fe = firstFieldErrors(parsed.error.flatten().fieldErrors);
      setErrors(fe);
      if (Object.keys(fe).length === 0) {
        setFormError("The document changed. Reload the page.");
      }
      return;
    }
    setErrors({});
    setConfirming(true);
  };

  const submit = async () => {
    const parsed = ZBallotSubmitSchema.safeParse(input);
    if (!parsed.success) {
      setConfirming(false);
      return;
    }
    setSubmitting(true);
    try {
      await client().ballot.submit.mutate(parsed.data);
      // Recorded: keep the form locked until the refreshed page replaces it.
      setConfirming(false);
      toast.success("Your response was recorded.");
      router.refresh();
      return;
    } catch (e) {
      setSubmitting(false);
      setConfirming(false);
      if (e instanceof TRPCClientError) {
        const code = (e.data as { code?: string } | undefined)?.code;
        if (code === "FORBIDDEN" || code === "CONFLICT") {
          setFormError(e.message);
          toast.error(e.message);
          router.refresh();
        } else if (code === "NOT_FOUND") {
          setFormError("This link is no longer valid.");
          router.refresh();
        } else if (code === "BAD_REQUEST") {
          const zodError = (
            e.data as {
              zodError?: {
                fieldErrors?: Record<string, string[] | undefined>;
              } | null;
            }
          )?.zodError;
          const fe = firstFieldErrors(zodError?.fieldErrors);
          setErrors(fe);
          setFormError(
            Object.keys(fe).length > 0
              ? "Please correct the highlighted fields."
              : "Your response could not be accepted. Check your entries and try again.",
          );
        } else {
          setFormError(UNKNOWN_FAILURE);
          router.refresh();
        }
      } else {
        setFormError(UNKNOWN_FAILURE);
        router.refresh();
      }
    }
  };

  const chosen = choice === "" ? null : CHOICE_LABEL[choice];

  return (
    <div className="space-y-6">
      <fieldset className="space-y-3">
        <legend className="mb-2 text-base font-semibold">Your response</legend>
        <RadioGroup
          value={choice}
          onValueChange={(v) => setChoice(v as BallotChoice)}
          className="grid gap-3"
          aria-invalid={errors.choice ? true : undefined}
        >
          {(Object.keys(CHOICE_LABEL) as BallotChoice[]).map((c) => (
            <Label
              key={c}
              htmlFor={`choice-${c}`}
              className="flex cursor-pointer items-center gap-3 rounded-md border p-4 text-base font-normal has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-primary/5"
            >
              <RadioGroupItem id={`choice-${c}`} value={c} />
              {CHOICE_LABEL[c]}
            </Label>
          ))}
        </RadioGroup>
        {errors.choice ? (
          <p className="text-sm text-red-600">{errors.choice}</p>
        ) : null}
      </fieldset>

      <div className="space-y-2">
        <Label htmlFor="signed-name" className="text-base">
          Type your full legal name
        </Label>
        <Input
          id="signed-name"
          autoComplete="name"
          className="h-11 text-base"
          maxLength={200}
          required
          value={signedName}
          onChange={(e) => setSignedName(e.target.value)}
          aria-invalid={errors.signedName ? true : undefined}
        />
        {errors.signedName ? (
          <p className="text-sm text-red-600">{errors.signedName}</p>
        ) : null}
      </div>

      <div className="space-y-2">
        <Label htmlFor="signer-capacity" className="text-base">
          Title or capacity (if signing for an entity or trust)
        </Label>
        <Input
          id="signer-capacity"
          className="h-11 text-base"
          maxLength={200}
          placeholder="Optional, e.g. Trustee"
          value={signerCapacity}
          onChange={(e) => setSignerCapacity(e.target.value)}
          aria-invalid={errors.signerCapacity ? true : undefined}
        />
        {errors.signerCapacity ? (
          <p className="text-sm text-red-600">{errors.signerCapacity}</p>
        ) : null}
      </div>

      <div className="space-y-2">
        <div className="flex items-start gap-3 rounded-md border p-4">
          <Checkbox
            id="assent"
            className="mt-0.5"
            checked={assent}
            onCheckedChange={(v) => setAssent(v === true)}
            aria-invalid={errors.assent ? true : undefined}
          />
          <Label
            htmlFor="assent"
            className="cursor-pointer text-sm font-normal leading-relaxed"
          >
            {ASSENT_TEXT}
          </Label>
        </div>
        {errors.assent ? (
          <p className="text-sm text-red-600">{errors.assent}</p>
        ) : null}
      </div>

      {deemedAgainstAtClose ? (
        <Alert>
          <AlertDescription>
            If you do not respond by the deadline you are deemed to have voted
            against the extension (Section 2.5).
          </AlertDescription>
        </Alert>
      ) : null}

      {formError ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{formError}</AlertDescription>
        </Alert>
      ) : null}

      <Button
        type="button"
        size="lg"
        className="h-12 w-full text-base"
        disabled={submitting}
        onClick={review}
      >
        Sign and submit
      </Button>

      <AlertDialog
        open={confirming}
        onOpenChange={(o) => (submitting ? null : setConfirming(o))}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Confirm your response</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm">
                <p>
                  Member: <span className="font-medium">{memberName}</span>
                </p>
                <p>
                  Response: <span className="font-medium">{chosen}</span>
                </p>
                <p>
                  Signed:{" "}
                  <span className="font-medium">
                    {signedName.trim()}
                    {capacity ? `, ${capacity}` : ""}
                  </span>
                </p>
                <p className="font-medium text-foreground">
                  Your response is final and cannot be changed.
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={submitting}>Go back</AlertDialogCancel>
            <Button disabled={submitting} onClick={() => void submit()}>
              {submitting ? "Submitting…" : "Sign and submit"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/** "Download the executed consent" (CLOSED + EFFECTIVE with a filed PDF). */
export function ExecutedConsentButton({ token }: { token: string }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const download = async () => {
    setError(null);
    setLoading(true);
    // Open the tab inside the click (an `await` first would be blocked as a
    // popup on mobile browsers); it is pointed at the file once we have it.
    const tab = window.open("", "_blank");
    try {
      const { url } = await client().ballot.executedPdf.mutate({ token });
      if (tab) {
        tab.opener = null;
        tab.location.href = url;
      } else {
        window.location.assign(url);
      }
    } catch {
      tab?.close();
      setError(
        "The document could not be opened. Reload the page and try again.",
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-2">
      <Button
        type="button"
        className="w-full sm:w-auto"
        disabled={loading}
        onClick={() => void download()}
      >
        {loading ? "Opening…" : "Download the executed consent"}
      </Button>
      {error ? <p className="text-sm text-red-600">{error}</p> : null}
    </div>
  );
}
