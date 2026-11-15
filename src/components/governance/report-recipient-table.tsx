"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Alert, AlertDescription } from "@/components/ui/alert";
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatInstant } from "@/lib/company-time";
import { RESEND_SKIP_TEXT } from "@/lib/governance/recipient-core";
import {
  mayEmail,
  PORTAL_STATE_LABEL,
  type PublishState,
  plural,
  recipientActions,
  replaceLinkEmailCount,
  resendRound,
} from "@/lib/governance/release-view";
import { MAIL_BLOCKED_MESSAGE } from "@/lib/mail-delivery";
import { api } from "@/trpc/react";
import type { RouterOutputs } from "@/trpc/shared";
import { AddRecipientsDialog, EmailConfirm } from "./release-dialog";

// Recipients of a released member report (03-governance.md G13;
// 04-investor-portal.md 6.2, P19, P21, P24; package P4c): when each was
// emailed (or "Not emailed"), its portal state and views, and the actions
// Add recipients…, Email all not yet emailed, Resend to all, and per row
// Email / Resend, Replace link and Remove. Each action is shown only when
// the role may take it (`governance: update`) and the server would accept
// it (not emailing an unpublished report, never a row without an address,
// Remove only for a never-emailed, never-opened recipient). Every action
// that sends email asks first and states how many emails go out.

type Recipient = RouterOutputs["memberReport"]["get"]["recipients"][number];

function errorText(e: unknown, fallback: string): string {
  return e instanceof Error && e.message ? e.message : fallback;
}

function EmailedCell({ r, timeZone }: { r: Recipient; timeZone: string }) {
  const failed = r.emailState === "FAILED" || r.emailState === "BOUNCED";
  if (r.emailedAt === null && !failed) {
    return <span className="text-muted-foreground">Not emailed</span>;
  }
  return (
    <span className="flex flex-col">
      {r.emailedAt !== null ? (
        <span>{formatInstant(r.lastEmailAt ?? r.emailedAt, timeZone)}</span>
      ) : null}
      {failed ? (
        <span className="font-medium text-red-600">
          Not delivered{r.emailState === "BOUNCED" ? " (bounced)" : ""}
        </span>
      ) : null}
    </span>
  );
}

function LinkState({ r }: { r: Recipient }) {
  if (r.linkState === "ACTIVE") return null;
  return (
    <Badge variant="outline" className="ml-2">
      {r.linkState === "EXPIRED" ? "Link expired" : "Link replaced"}
    </Badge>
  );
}

function ReplaceLinkDialog({
  recipient,
  publicId,
  noticeEmail,
  onClose,
}: {
  recipient: Recipient;
  publicId: string;
  /** The holder's notice address on file (told when the address changes). */
  noticeEmail: string | null;
  onClose: () => void;
}) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [confirming, setConfirming] = useState(false);
  const replace = api.memberReport.replaceLink.useMutation();
  const trimmed = email.trim();
  const needsAddress = !recipient.hasAddress;
  const count = replaceLinkEmailCount({
    currentEmail: recipient.email,
    newEmail: trimmed,
    noticeEmail,
  });
  const to = trimmed || recipient.email;
  const sentence =
    count.notices > 0
      ? `The new link is emailed to ${to}, and ${plural(count.notices, "notice", "notices")} without a link ${count.notices === 1 ? "tells" : "tell"} the previous ${count.notices === 1 ? "address" : "addresses"} that the link moved: ${plural(count.total, "email", "emails")} in all.`
      : `The new link is emailed to ${to}: 1 email.`;
  const submit = async () => {
    try {
      await replace.mutateAsync({
        publicId,
        recipientId: recipient.id,
        ...(trimmed ? { email: trimmed } : {}),
      });
      toast.success(
        `${plural(count.total, "email", "emails")} queued. The new link is being emailed to ${to}.`,
      );
      onClose();
      router.refresh();
    } catch (e) {
      setConfirming(false);
      toast.error(errorText(e, "Could not replace the link."));
    }
  };
  return (
    <Dialog open onOpenChange={(o) => (o ? null : onClose())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Replace the link of {recipient.name}</DialogTitle>
          <DialogDescription>
            {needsAddress
              ? "This recipient has no email address. Enter one: the new link is emailed to it."
              : `A new link to the report is emailed. Leave the email empty to use ${recipient.email}.`}
          </DialogDescription>
        </DialogHeader>
        <Alert variant="destructive">
          <AlertDescription>
            The previous link stops working immediately.
          </AlertDescription>
        </Alert>
        <div className="space-y-1">
          <Label htmlFor="report-replace-email">
            {needsAddress ? "Email" : "New email (optional)"}
          </Label>
          <Input
            id="report-replace-email"
            type="email"
            value={email}
            maxLength={320}
            placeholder={recipient.email || "name@example.com"}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={replace.isPending || (needsAddress && trimmed === "")}
            onClick={() => setConfirming(true)}
          >
            Replace link…
          </Button>
        </DialogFooter>
        <EmailConfirm
          open={confirming}
          onOpenChange={setConfirming}
          title={`Replace the link and send ${plural(count.total, "email", "emails")}?`}
          sentence={sentence}
          action={`Replace and send ${plural(count.total, "email", "emails")}`}
          busy={replace.isPending}
          onConfirm={() => void submit()}
        />
      </DialogContent>
    </Dialog>
  );
}

type Pending =
  | { kind: "ROUND"; scope: "ALL" | "NOT_EMAILED" }
  | { kind: "ONE"; recipient: Recipient }
  | { kind: "REMOVE"; recipient: Recipient };

export function ReportRecipientTable({
  publicId,
  title,
  noticeKind,
  recipients,
  timeZone,
  canUpdate,
  showPortal,
  mayInvite,
  state,
  addable,
  noticeEmails,
  mailBlocked,
}: {
  publicId: string;
  title: string;
  noticeKind: string | null;
  recipients: Recipient[];
  timeZone: string;
  /** `governance: update`: every action (absent otherwise). */
  canUpdate: boolean;
  /** `portal: read`: the Portal column. */
  showPortal: boolean;
  /** `portal: create`: the invitation line of "Add recipients". */
  mayInvite: boolean;
  state: PublishState;
  /** Holders that can still be added (0: no "Add recipients…"). */
  addable: number;
  /** stakeholderId → notice address on file (for the replace-link count). */
  noticeEmails: Record<string, string>;
  /** Production with the mail catcher: the reason; no email action is offered. */
  mailBlocked: string | null;
}) {
  const router = useRouter();
  const resend = api.memberReport.resend.useMutation();
  const remove = api.memberReport.removeRecipient.useMutation();
  const [replacing, setReplacing] = useState<Recipient | null>(null);
  const [adding, setAdding] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const emailing = canUpdate && mayEmail(state) && mailBlocked === null;
  const notEmailed = resendRound(recipients, "NOT_EMAILED");
  const all = resendRound(recipients, "ALL");
  const anyEmailed = recipients.some((r) => r.emailedAt !== null);
  const busy = resend.isPending || remove.isPending;

  const doResend = async (p: Pending) => {
    try {
      const res = await resend.mutateAsync(
        p.kind === "ONE"
          ? { publicId, recipientId: p.recipient.id }
          : { publicId, scope: p.kind === "ROUND" ? p.scope : "ALL" },
      );
      toast.success(
        `${plural(res.queued, "email", "emails")} queued.${
          res.skipped.length > 0
            ? ` Not emailed: ${res.skipped.map((s) => `${s.name} (${RESEND_SKIP_TEXT[s.reason]})`).join("; ")}.`
            : ""
        }`,
      );
      setPending(null);
      router.refresh();
    } catch (e) {
      setPending(null);
      toast.error(errorText(e, "Could not send the emails."));
    }
  };

  const doRemove = async (r: Recipient) => {
    try {
      await remove.mutateAsync({ publicId, recipientId: r.id });
      toast.success(`${r.name} removed from the recipients.`);
      setPending(null);
      router.refresh();
    } catch (e) {
      setPending(null);
      toast.error(errorText(e, "Could not remove the recipient."));
    }
  };

  let confirm: {
    title: string;
    sentence: string;
    action: string;
    run: () => void;
  } | null = null;
  if (pending?.kind === "ROUND") {
    const round = pending.scope === "ALL" ? all : notEmailed;
    const skipped =
      round.skipped.length > 0
        ? ` Not emailed: ${round.skipped.map((s) => `${s.name} (${RESEND_SKIP_TEXT[s.reason]})`).join("; ")}.`
        : "";
    confirm = {
      title:
        pending.scope === "ALL"
          ? `Resend this report to ${plural(round.queued, "recipient", "recipients")}?`
          : `Email ${plural(round.queued, "recipient", "recipients")} not yet emailed?`,
      sentence: `${plural(round.queued, "email", "emails")} will be sent now, each to the address shown in the table.${skipped} Emails cannot be recalled.`,
      action: `Send ${plural(round.queued, "email", "emails")}`,
      run: () => void doResend(pending),
    };
  } else if (pending?.kind === "ONE") {
    const r = pending.recipient;
    confirm = {
      title: `${r.emailedAt === null ? "Email" : "Resend"} this report to ${r.name}?`,
      sentence: `1 email will be sent now to ${r.email}.`,
      action: "Send 1 email",
      run: () => void doResend(pending),
    };
  }

  return (
    <div className="space-y-3">
      {canUpdate ? (
        <div className="flex flex-wrap items-center gap-2">
          {addable > 0 ? (
            <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
              Add recipients…
            </Button>
          ) : null}
          {emailing && notEmailed.queued > 0 ? (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() =>
                setPending({ kind: "ROUND", scope: "NOT_EMAILED" })
              }
            >
              Email all not yet emailed
            </Button>
          ) : null}
          {emailing && anyEmailed && all.queued > 0 ? (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => setPending({ kind: "ROUND", scope: "ALL" })}
            >
              Resend to all
            </Button>
          ) : null}
        </div>
      ) : null}
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Email</TableHead>
              <TableHead>Emailed</TableHead>
              {showPortal ? <TableHead>Portal</TableHead> : null}
              <TableHead>First viewed</TableHead>
              <TableHead>Views</TableHead>
              {canUpdate ? (
                <TableHead>
                  <span className="sr-only">Actions</span>
                </TableHead>
              ) : null}
            </TableRow>
          </TableHeader>
          <TableBody>
            {recipients.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={5 + (showPortal ? 1 : 0) + (canUpdate ? 1 : 0)}
                  className="text-center text-muted-foreground"
                >
                  No recipients.
                </TableCell>
              </TableRow>
            ) : null}
            {recipients.map((r) => {
              const actions = recipientActions(r, {
                canUpdate,
                state,
                mailBlocked: mailBlocked !== null,
              });
              return (
                <TableRow key={r.id}>
                  <TableCell className="font-medium">
                    {r.name}
                    <LinkState r={r} />
                  </TableCell>
                  <TableCell className="whitespace-nowrap">
                    {r.hasAddress ? (
                      r.email
                    ) : (
                      <span className="text-muted-foreground">No address</span>
                    )}
                  </TableCell>
                  <TableCell className="whitespace-nowrap">
                    <EmailedCell r={r} timeZone={timeZone} />
                  </TableCell>
                  {showPortal ? (
                    <TableCell className="whitespace-nowrap">
                      <span className="flex flex-col">
                        <span>{PORTAL_STATE_LABEL[r.portal]}</span>
                        {r.portalFirstViewedAt ? (
                          <span className="text-xs text-muted-foreground">
                            Viewed{" "}
                            {formatInstant(r.portalFirstViewedAt, timeZone)}
                          </span>
                        ) : null}
                      </span>
                    </TableCell>
                  ) : null}
                  <TableCell className="whitespace-nowrap">
                    {formatInstant(r.firstViewedAt, timeZone)}
                  </TableCell>
                  <TableCell className="tabular-nums">{r.viewCount}</TableCell>
                  {canUpdate ? (
                    <TableCell className="whitespace-nowrap text-right">
                      {actions.email ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy}
                          onClick={() =>
                            setPending({ kind: "ONE", recipient: r })
                          }
                        >
                          {actions.email}
                        </Button>
                      ) : null}
                      {actions.replaceLink ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setReplacing(r)}
                        >
                          Replace link
                        </Button>
                      ) : null}
                      {actions.remove ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy}
                          onClick={() =>
                            setPending({ kind: "REMOVE", recipient: r })
                          }
                        >
                          Remove
                        </Button>
                      ) : null}
                    </TableCell>
                  ) : null}
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
      {canUpdate ? (
        <p className="text-xs text-muted-foreground">
          Remove is offered while the holder has not been emailed and has not
          opened the report.
        </p>
      ) : null}
      {canUpdate && mailBlocked ? (
        <p className="text-xs text-muted-foreground">
          {MAIL_BLOCKED_MESSAGE.MEMBER_EMAIL}
        </p>
      ) : null}

      {confirm ? (
        <EmailConfirm
          open
          onOpenChange={(o) => (o ? null : setPending(null))}
          title={confirm.title}
          sentence={confirm.sentence}
          action={confirm.action}
          busy={resend.isPending}
          onConfirm={confirm.run}
        />
      ) : null}
      {pending?.kind === "REMOVE" ? (
        <AlertDialog open onOpenChange={(o) => (o ? null : setPending(null))}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                Remove {pending.recipient.name} from the recipients?
              </AlertDialogTitle>
              <AlertDialogDescription>
                {pending.recipient.name} no longer sees this report in the
                portal and its link stops working. No email is sent.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={remove.isPending}>
                Keep
              </AlertDialogCancel>
              <AlertDialogAction
                disabled={remove.isPending}
                onClick={(e) => {
                  e.preventDefault();
                  void doRemove(pending.recipient);
                }}
              >
                Remove
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : null}
      {replacing ? (
        <ReplaceLinkDialog
          recipient={replacing}
          publicId={publicId}
          noticeEmail={noticeEmails[replacing.stakeholderId] ?? null}
          onClose={() => setReplacing(null)}
        />
      ) : null}
      {adding ? (
        <AddRecipientsDialog
          publicId={publicId}
          title={title}
          noticeKind={noticeKind}
          canEmail={mayEmail(state)}
          mayInvite={mayInvite}
          showPortal={showPortal}
          onClose={() => setAdding(false)}
          onAdded={() => {
            setAdding(false);
            router.refresh();
          }}
        />
      ) : null}
    </div>
  );
}
