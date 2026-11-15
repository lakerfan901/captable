"use client";

import { RiCheckLine, RiCloseLine } from "@remixicon/react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { formatDateOnly } from "@/lib/date-only";
import {
  addButtonLabel,
  addReview,
  type DeliveryPlan,
  deliveryPlan,
  emailsSentence,
  initialSelection,
  type PickerHolder,
  type PickerMode,
  pickerCandidates,
  plural,
  releaseButtonLabel,
  releaseReview,
  totalEmails,
} from "@/lib/governance/release-view";
import { TEST_MODE_TEXT } from "@/lib/mail-delivery";
import { api } from "@/trpc/react";
import type { RouterOutputs } from "@/trpc/shared";
import { AudiencePicker, type AudiencePickerHolder } from "./audience-picker";
import { k1CompletionText } from "./k1-coverage-card";

// The release dialog and "Add recipients" (04-investor-portal.md 6.2,
// P17–P27; package P4c). Release replaces the former "Review and send":
// the Manager user picks the holders (presets fill the picker), chooses
// whether to also email them and, with `portal: create`, whether to invite
// the notice addresses that have no portal access. Every send of email goes
// through a second confirmation that states how many emails go out.
//
// Sections, top to bottom: Checklist, Audience, Delivery, Consequences.
// Server refusals are shown as they come (P16 adds a Reconciliation block
// between Checklist and Audience without touching the picker).

type Options = RouterOutputs["memberReport"]["audienceOptions"];
type ReleaseResult = RouterOutputs["memberReport"]["release"];

function errorText(e: unknown, fallback: string): string {
  return e instanceof Error && e.message ? e.message : fallback;
}

function asPickerHolders(options: Options): PickerHolder[] {
  return options.holders.map((h) => ({
    ...h,
    memberStatus: h.memberStatus as PickerHolder["memberStatus"],
    noticeEmail: h.noticeEmail ?? "",
  }));
}

function pickerRows(holders: readonly PickerHolder[]): AudiencePickerHolder[] {
  return holders.map((h) => ({
    stakeholderId: h.stakeholderId,
    name: h.name,
    memberStatus: h.memberStatus,
    preferredUnits: h.preferredUnits,
    commonUnits: h.commonUnits,
    noticeEmail: h.noticeEmail,
    portal: h.portal,
    hasK1: h.hasK1,
    note: h.transferor ? "transferor" : undefined,
  }));
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h3 className="text-sm font-semibold tracking-tight">{children}</h3>;
}

/** One toast for the result of a release or an addition. */
function reportOutcome(
  lead: string,
  res: Pick<
    ReleaseResult,
    "emailed" | "queued" | "invitations" | "invitationsQueued"
  >,
) {
  const parts = [lead];
  if (res.emailed) {
    parts.push(`${plural(res.queued, "report email", "report emails")} queued`);
  } else {
    parts.push("not emailed");
  }
  if (res.invitationsQueued > 0) {
    parts.push(
      `${plural(res.invitationsQueued, "portal invitation", "portal invitations")} sent`,
    );
  }
  toast.success(`${parts.join(", ")}.`);
  const disabled = res.invitations.filter((l) => l.outcome === "LEFT_DISABLED");
  if (disabled.length > 0) {
    toast.warning(
      `Portal access stays disabled for ${disabled
        .map((l) => (l.email ? `${l.name} (${l.email})` : l.name))
        .join(", ")}: it was turned off by the team and is not re-enabled.`,
    );
  }
  const none = res.invitations.filter(
    (l) => l.outcome === "NO_ADDRESS" || l.outcome === "INVALID_ADDRESS",
  );
  if (none.length > 0) {
    toast.warning(
      `Not invited, no valid notice email: ${none.map((l) => l.name).join(", ")}.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Delivery block (shared)

function DeliveryBlock({
  email,
  setEmail,
  emailOffered,
  emailBlocked,
  invite,
  setInvite,
  plan,
  idPrefix,
}: {
  email: boolean;
  setEmail: (v: boolean) => void;
  /** false: the tick is absent (the report is unpublished). */
  emailOffered: React.ReactNode | true;
  /** Production with the mail catcher: the tick is off and says why. */
  emailBlocked: string | null;
  invite: boolean;
  setInvite: (v: boolean) => void;
  plan: DeliveryPlan;
  idPrefix: string;
}) {
  return (
    <div className="space-y-3">
      <SectionTitle>Delivery</SectionTitle>
      <div className="flex items-center gap-2 text-sm">
        <RiCheckLine className="h-4 w-4" aria-hidden />
        <span className="font-medium">Publish to the investor portal</span>
        <span className="text-muted-foreground">(always)</span>
      </div>
      {emailOffered === true ? (
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <Checkbox
              id={`${idPrefix}-email`}
              checked={email}
              disabled={emailBlocked !== null}
              onCheckedChange={(c) => setEmail(c === true)}
            />
            <Label htmlFor={`${idPrefix}-email`}>Also send by email</Label>
          </div>
          {emailBlocked ? (
            <p className="pl-6 text-xs text-muted-foreground">{emailBlocked}</p>
          ) : null}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">{emailOffered}</p>
      )}
      {plan.inviteLine.length > 0 ? (
        <div className="space-y-2 pl-6" data-testid="invite-line">
          <div className="flex items-start gap-2">
            <Checkbox
              id={`${idPrefix}-invite`}
              className="mt-0.5"
              checked={invite}
              onCheckedChange={(c) => setInvite(c === true)}
            />
            <Label htmlFor={`${idPrefix}-invite`} className="leading-5">
              Invite these {plural(plan.inviteLine.length, "holder", "holders")}{" "}
              to the portal at their notice email
            </Label>
          </div>
          <ul className="ml-6 list-disc space-y-1 pl-5 text-sm text-muted-foreground">
            {plan.inviteLine.map((h) => (
              <li key={h.stakeholderId} className="break-all">
                {h.name} — {h.noticeEmail}
              </li>
            ))}
          </ul>
          {invite ? null : (
            <p className="pl-6 text-xs text-muted-foreground">
              Not invited: their emailed link opens the read-only page as today.
            </p>
          )}
        </div>
      ) : null}
    </div>
  );
}

/** The second step of every action that sends email: it states how many. */
function EmailConfirm({
  open,
  onOpenChange,
  title,
  sentence,
  action,
  busy,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  sentence: string;
  action: string;
  busy: boolean;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{sentence}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Back</AlertDialogCancel>
          <AlertDialogAction
            disabled={busy}
            onClick={(e) => {
              e.preventDefault();
              onConfirm();
            }}
          >
            {action}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function useAudience(publicId: string, mode: PickerMode) {
  const options = api.memberReport.audienceOptions.useQuery(
    { publicId },
    { refetchOnWindowFocus: false, staleTime: 0 },
  );
  const holders = useMemo(
    () => (options.data ? asPickerHolders(options.data) : []),
    [options.data],
  );
  const candidates = useMemo(
    () =>
      options.data ? pickerCandidates(options.data.type, holders, mode) : [],
    [options.data, holders, mode],
  );
  const [selected, setSelected] = useState<Set<string> | null>(null);
  useEffect(() => {
    if (options.data && selected === null) {
      setSelected(
        initialSelection(
          options.data.type,
          mode,
          candidates,
          options.data.presets,
          options.data.defaultPreset,
        ),
      );
    }
  }, [options.data, candidates, mode, selected]);
  const sel = selected ?? new Set<string>();
  // Only listed holders count: a holder that left the list is never sent.
  const picked = candidates.filter((h) => sel.has(h.stakeholderId));
  return { options, holders, candidates, selected: sel, setSelected, picked };
}

// ---------------------------------------------------------------------------
// Release

export function ReleaseDialog({
  publicId,
  today,
  mayInvite,
  showPortal,
  onClose,
  onReleased,
}: {
  publicId: string;
  today: string;
  /** `portal: create`: the invitation line exists (absent otherwise). */
  mayInvite: boolean;
  /** `portal: read`: the picker's Portal column. */
  showPortal: boolean;
  onClose: () => void;
  onReleased: () => void;
}) {
  const report = api.memberReport.get.useQuery(
    { publicId },
    { refetchOnWindowFocus: false, staleTime: 0 },
  );
  const { options, holders, candidates, selected, setSelected, picked } =
    useAudience(publicId, "RELEASE");
  const release = api.memberReport.release.useMutation();
  const mailBlocked = options.data?.mailDelivery.blockedReason ?? null;
  const [emailWanted, setEmail] = useState(true);
  const email = emailWanted && mailBlocked === null;
  const [invite, setInvite] = useState(true);
  const [confirming, setConfirming] = useState(false);

  const data = report.data;
  const opts = options.data;
  const plan = deliveryPlan(picked, { email, invite, mayInvite });
  const emails = totalEmails(plan);

  let body: React.ReactNode = (
    <p className="text-sm text-muted-foreground">Loading…</p>
  );
  let blocked: string | null = "Loading…";
  if (report.error || options.error) {
    body = (
      <p className="text-sm text-red-600">
        {(report.error ?? options.error)?.message}
      </p>
    );
  } else if (data && opts) {
    const r = data.report;
    const review = releaseReview(
      {
        type: r.type,
        noticeKind: r.noticeKind,
        periodEnd: r.periodEnd,
        hasDeadline:
          r.dueOn !== null ||
          r.relatedType === "COMPLIANCE_DEADLINE" ||
          r.type === "TAX_K1",
      },
      {
        holders,
        selectedIds: picked.map((h) => h.stakeholderId),
        email,
        deadlineAudienceIds: opts.deadlineAudienceIds,
        formatDate: formatDateOnly,
      },
    );
    const missing = data.checklist.filter((i) => !i.ok);
    const notEnded =
      (r.type === "QUARTERLY" || r.type === "ANNUAL") &&
      r.periodEnd !== null &&
      !(r.periodEnd < today)
        ? `This period has not ended yet. A report can be released, and the books closed, only after ${formatDateOnly(r.periodEnd)}.`
        : null;
    blocked =
      r.status !== "DRAFT"
        ? "This report has already been released."
        : (notEnded ??
          (missing.length > 0
            ? `Incomplete: ${missing.map((i) => i.label).join(", ")}`
            : picked.length === 0
              ? "Select at least one holder."
              : (review.problems[0] ?? null)));
    const sentence = emailsSentence(plan);
    body = (
      <div className="flex flex-col gap-5">
        {email && opts.mailDelivery.testMode ? (
          <Alert variant="destructive">
            <AlertTitle>Test mode</AlertTitle>
            <AlertDescription>{TEST_MODE_TEXT}</AlertDescription>
          </Alert>
        ) : null}
        <div className="space-y-2">
          <SectionTitle>Checklist</SectionTitle>
          <ul className="space-y-1 text-sm">
            {data.checklist.map((i) => (
              <li key={i.key} className="flex items-center gap-2">
                {i.ok ? (
                  <RiCheckLine
                    className="h-4 w-4 shrink-0 text-green-700"
                    aria-label="Done"
                  />
                ) : (
                  <RiCloseLine
                    className="h-4 w-4 shrink-0 text-red-600"
                    aria-label="Missing"
                  />
                )}
                <span>
                  {i.label}{" "}
                  <span className="text-muted-foreground">
                    (Section {i.section})
                  </span>
                </span>
              </li>
            ))}
          </ul>
          {data.k1Coverage ? (
            <p className="text-sm font-medium">
              {k1CompletionText(data.k1Coverage, r.status)}
            </p>
          ) : null}
        </div>

        <div className="space-y-3">
          <SectionTitle>Audience</SectionTitle>
          <AudiencePicker
            holders={pickerRows(candidates)}
            presets={opts.presets}
            selected={selected}
            onChange={setSelected}
            warnings={review.warnings}
            showPortal={showPortal}
            showK1={r.type === "TAX_K1"}
            countNote={
              r.type === "TAX_K1"
                ? "Only holders with a K-1 attached are listed."
                : "Prospects cannot receive a report and are not listed."
            }
          />
        </div>

        <DeliveryBlock
          email={email}
          setEmail={setEmail}
          emailOffered
          emailBlocked={mailBlocked}
          invite={invite}
          setInvite={setInvite}
          plan={plan}
          idPrefix="release"
        />

        <div className="space-y-2">
          <SectionTitle>Consequences</SectionTitle>
          <ul
            className="list-disc space-y-1 pl-5 text-sm text-muted-foreground"
            data-testid="consequences"
          >
            {review.consequences.map((c) => (
              <li key={c}>{c}</li>
            ))}
            <li className="font-medium text-foreground">
              {sentence
                ? `Sent when you release: ${sentence}.`
                : "No email is sent."}
            </li>
          </ul>
        </div>

        {review.problems.length > 0 ? (
          <ul className="space-y-1 text-sm font-medium text-red-600">
            {review.problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        ) : blocked && blocked !== "Select at least one holder." ? (
          <p className="text-sm font-medium text-red-600">{blocked}</p>
        ) : null}
      </div>
    );
  }

  const submit = async () => {
    try {
      const res = await release.mutateAsync({
        publicId,
        stakeholderIds: picked.map((h) => h.stakeholderId),
        email,
        ...(plan.inviteMissing ? { inviteMissing: true } : {}),
      });
      setConfirming(false);
      reportOutcome(
        `Released to ${plural(res.recipientCount, "holder", "holders")}`,
        res,
      );
      onReleased();
    } catch (e) {
      setConfirming(false);
      toast.error(errorText(e, "The report could not be released."));
      void report.refetch();
      void options.refetch();
    }
  };

  const title = data?.report.title ?? "report";
  return (
    <Dialog open onOpenChange={(o) => (o ? null : onClose())}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Release {title}</DialogTitle>
          <DialogDescription>
            Releasing freezes the report, publishes it to the holders you pick
            and, if ticked, emails them. It cannot be undone.
          </DialogDescription>
        </DialogHeader>
        {body}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={
              blocked !== null ||
              release.isPending ||
              report.isFetching ||
              options.isFetching
            }
            loading={release.isPending}
            onClick={() => (emails > 0 ? setConfirming(true) : void submit())}
          >
            {blocked === "Select at least one holder."
              ? blocked
              : releaseButtonLabel(picked.length, emails)}
          </Button>
        </DialogFooter>
        <EmailConfirm
          open={confirming}
          onOpenChange={setConfirming}
          title={`Release and send ${plural(emails, "email", "emails")}?`}
          sentence={`Releasing ${title} to ${plural(picked.length, "holder", "holders")} sends ${emailsSentence(plan) ?? "no email"} now. Emails cannot be recalled.`}
          action={`Release and send ${plural(emails, "email", "emails")}`}
          busy={release.isPending}
          onConfirm={() => void submit()}
        />
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Add recipients (after release)

export function AddRecipientsDialog({
  publicId,
  title,
  noticeKind,
  canEmail,
  mayInvite,
  showPortal,
  onClose,
  onAdded,
}: {
  publicId: string;
  title: string;
  noticeKind: string | null;
  /** false while the report is unpublished: added holders cannot be emailed (P24). */
  canEmail: boolean;
  mayInvite: boolean;
  showPortal: boolean;
  onClose: () => void;
  onAdded: () => void;
}) {
  const { options, holders, candidates, selected, setSelected, picked } =
    useAudience(publicId, "ADD");
  const add = api.memberReport.addRecipients.useMutation();
  const mailBlocked = options.data?.mailDelivery.blockedReason ?? null;
  const [emailWanted, setEmail] = useState(canEmail);
  const email = canEmail && emailWanted && mailBlocked === null;
  const [invite, setInvite] = useState(true);
  const [confirming, setConfirming] = useState(false);
  const plan = deliveryPlan(picked, { email, invite, mayInvite });
  const emails = totalEmails(plan);
  const opts = options.data;

  let body: React.ReactNode = (
    <p className="text-sm text-muted-foreground">Loading…</p>
  );
  let blocked: string | null = "Loading…";
  if (options.error) {
    body = <p className="text-sm text-red-600">{options.error.message}</p>;
  } else if (opts) {
    const review = addReview(
      { type: opts.type, noticeKind },
      { holders, selectedIds: picked.map((h) => h.stakeholderId), email },
    );
    blocked =
      candidates.length === 0
        ? "Every holder that can receive this report is already a recipient."
        : picked.length === 0
          ? "Select at least one holder."
          : (review.problems[0] ?? null);
    const sentence = emailsSentence(plan);
    body = (
      <div className="flex flex-col gap-5">
        {email && opts.mailDelivery.testMode ? (
          <Alert variant="destructive">
            <AlertTitle>Test mode</AlertTitle>
            <AlertDescription>{TEST_MODE_TEXT}</AlertDescription>
          </Alert>
        ) : null}
        <div className="space-y-3">
          <SectionTitle>
            {opts.type === "TAX_K1"
              ? "K-1 attached, not yet a recipient"
              : "Holders not yet on the list"}
          </SectionTitle>
          <AudiencePicker
            holders={pickerRows(candidates)}
            presets={opts.presets}
            selected={selected}
            onChange={setSelected}
            warnings={review.warnings}
            showPortal={showPortal}
            showK1={opts.type === "TAX_K1"}
          />
        </div>
        <DeliveryBlock
          email={email}
          setEmail={setEmail}
          emailOffered={
            canEmail
              ? true
              : "The report is unpublished: the holders you add are not emailed now and see it when it is published again."
          }
          emailBlocked={mailBlocked}
          invite={invite}
          setInvite={setInvite}
          plan={plan}
          idPrefix="add"
        />
        <div className="space-y-2">
          <SectionTitle>Consequences</SectionTitle>
          <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
            {review.consequences.map((c) => (
              <li key={c}>{c}</li>
            ))}
            <li className="font-medium text-foreground">
              {sentence
                ? `Sent when you add: ${sentence}.`
                : "No email is sent."}
            </li>
          </ul>
        </div>
        {review.problems.length > 0 ? (
          <ul className="space-y-1 text-sm font-medium text-red-600">
            {review.problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        ) : null}
      </div>
    );
  }

  const submit = async () => {
    try {
      const res = await add.mutateAsync({
        publicId,
        stakeholderIds: picked.map((h) => h.stakeholderId),
        email,
        ...(plan.inviteMissing ? { inviteMissing: true } : {}),
      });
      setConfirming(false);
      reportOutcome(
        `${plural(res.added.length, "recipient", "recipients")} added`,
        res,
      );
      onAdded();
    } catch (e) {
      setConfirming(false);
      toast.error(errorText(e, "The recipients could not be added."));
      void options.refetch();
    }
  };

  return (
    <Dialog open onOpenChange={(o) => (o ? null : onClose())}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Add recipients</DialogTitle>
          <DialogDescription>
            {title} is already released. The holders you add see the same frozen
            content.
          </DialogDescription>
        </DialogHeader>
        {body}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={blocked !== null || add.isPending || options.isFetching}
            loading={add.isPending}
            onClick={() => (emails > 0 ? setConfirming(true) : void submit())}
          >
            {blocked === "Select at least one holder."
              ? blocked
              : addButtonLabel(picked.length, emails)}
          </Button>
        </DialogFooter>
        <EmailConfirm
          open={confirming}
          onOpenChange={setConfirming}
          title={`Add and send ${plural(emails, "email", "emails")}?`}
          sentence={`Adding ${plural(picked.length, "holder", "holders")} sends ${emailsSentence(plan) ?? "no email"} now. Emails cannot be recalled.`}
          action={`Add and send ${plural(emails, "email", "emails")}`}
          busy={add.isPending}
          onConfirm={() => void submit()}
        />
      </DialogContent>
    </Dialog>
  );
}

export { EmailConfirm };
