"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Money } from "@/components/llc/money";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { formatDateOnly } from "@/lib/date-only";
import type { ResolutionType } from "@/lib/governance/presets";
import {
  eligibleRecipients,
  type SnapshotEntryDraft,
} from "@/lib/governance/resolution-core";
import { type Requirement, toMicro, type VoteBasis } from "@/lib/llc/voting";
import { api } from "@/trpc/react";
import {
  BallotTable,
  DeliveryState,
  type EmailRow,
  latestEmailBy,
  responseLabel,
} from "./ballot-table";
import { RESOLUTION_TYPE_LABEL } from "./resolution-table";
import { RichDocView } from "./rich-doc-view";
import { EXCLUSION_REASON_TEXT } from "./send-dialog";
import { StatusBadge } from "./status-badge";
import {
  formatInstant,
  formatUnits,
  type ResolutionGetOutput,
  TallyPanel,
} from "./tally-panel";

// Sent-resolution detail (03-governance.md G11). Data comes from the Server
// Component; while the vote is open it is refetched every 30 s. After every
// mutation the query is invalidated AND the route refreshed (initialData only
// seeds the cache once, so a refresh alone would leave the view stale).

type SnapshotEntry = NonNullable<
  ResolutionGetOutput["snapshot"]
>["entries"][number];
type RequirementView = ResolutionGetOutput["requirements"][number];

function toRequirements(rows: RequirementView[]): Requirement[] {
  return rows.flatMap((r): Requirement[] => {
    switch (r.kind) {
      case "UNIT_VOTE":
        return r.basis
          ? [{ kind: "UNIT_VOTE", basis: r.basis as VoteBasis }]
          : [];
      case "MANAGER_APPROVAL":
        return [{ kind: "MANAGER_APPROVAL" }];
      case "COMMON_MEMBER_APPROVAL":
        return [{ kind: "COMMON_MEMBER_APPROVAL" }];
      case "AFFECTED_MEMBER_CONSENT":
        return r.stakeholderId
          ? [
              {
                kind: "AFFECTED_MEMBER_CONSENT",
                stakeholderId: r.stakeholderId,
              },
            ]
          : [];
      default:
        return [];
    }
  });
}

function toDraft(e: SnapshotEntry): SnapshotEntryDraft {
  return {
    stakeholderId: e.stakeholderId,
    name: e.name,
    email: e.email,
    memberStatus: e.memberStatus,
    isMember: e.isMember,
    isInsider: e.isInsider,
    isSuspended: e.isSuspended,
    preferredUnits: e.preferredUnits,
    commonUnits: e.commonUnits,
  };
}

/**
 * "Not asked" (entitled to a ballot, none issued) and "Not entitled to vote"
 * (with the send dialog's reasons and precedence: not a Member, no Preferred
 * Units, suspended, insider), from the frozen register.
 */
export function splitRegister(
  entries: SnapshotEntry[],
  requirements: RequirementView[],
  ballotStakeholderIds: Set<string>,
) {
  const eligible = new Set(
    eligibleRecipients(entries.map(toDraft), toRequirements(requirements)).map(
      (e) => e.stakeholderId,
    ),
  );
  const notAsked = entries.filter(
    (e) =>
      eligible.has(e.stakeholderId) &&
      !ballotStakeholderIds.has(e.stakeholderId),
  );
  const notEntitled = entries
    .filter((e) => !eligible.has(e.stakeholderId))
    .map((e) => ({
      entry: e,
      reason: !e.isMember
        ? "FINANCIAL_INTEREST_ONLY"
        : toMicro(e.preferredUnits) === 0n
          ? "NO_PREFERRED_UNITS"
          : e.isSuspended
            ? "SUSPENDED"
            : "INSIDER",
    }));
  return { notAsked, notEntitled };
}

function downloadCsv(fileName: string, csv: string) {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function errorMessage(e: unknown, fallback: string): string {
  return e instanceof Error && e.message ? e.message : fallback;
}

function Fact({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm">{value}</dd>
    </div>
  );
}

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-2">
      <div>
        <h4 className="font-medium">{title}</h4>
        {description ? (
          <p className="text-sm text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {children}
    </section>
  );
}

function WithdrawDialog({
  publicId,
  open,
  onOpenChange,
  onDone,
}: {
  publicId: string;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onDone: () => void;
}) {
  const [reason, setReason] = useState("");
  const withdraw = api.resolution.withdraw.useMutation();
  const trimmed = reason.trim();
  const submit = async () => {
    try {
      await withdraw.mutateAsync({ publicId, reason: trimmed });
      toast.success(
        "The resolution was withdrawn. Members are being notified.",
      );
      onOpenChange(false);
    } catch (e) {
      toast.error(errorMessage(e, "Could not withdraw."));
    } finally {
      onDone();
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Withdraw this resolution</DialogTitle>
          <DialogDescription>
            Voting closes immediately and cannot be reopened. Every Member who
            was asked is told it was withdrawn, with the reason below. To ask
            again, duplicate it as a new draft.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1">
          <Label htmlFor="withdraw-reason">Reason (required)</Label>
          <Textarea
            id="withdraw-reason"
            value={reason}
            maxLength={500}
            onChange={(e) => setReason(e.target.value)}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={trimmed.length === 0 || withdraw.isPending}
            onClick={() => void submit()}
          >
            {withdraw.isPending ? "Withdrawing…" : "Withdraw"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AddRecipientsDialog({
  publicId,
  candidates,
  open,
  onOpenChange,
  onDone,
}: {
  publicId: string;
  candidates: SnapshotEntry[];
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onDone: () => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const add = api.resolution.addRecipients.useMutation();
  const toggle = (id: string, on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  const submit = async () => {
    try {
      const res = await add.mutateAsync({
        publicId,
        stakeholderIds: [...selected],
      });
      toast.success(
        `${res.added} ${res.added === 1 ? "Member was" : "Members were"} added. Ballot links are being emailed.`,
      );
      setSelected(new Set());
      onOpenChange(false);
    } catch (e) {
      toast.error(errorMessage(e, "Could not add recipients."));
    } finally {
      onDone();
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Add recipients</DialogTitle>
          <DialogDescription>
            Holders on the frozen register who are entitled to vote on this
            resolution but were not asked. Each one receives a ballot link by
            email.
          </DialogDescription>
        </DialogHeader>
        {candidates.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Every entitled holder already has a ballot.
          </p>
        ) : (
          <div className="max-h-80 overflow-y-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10" />
                  <TableHead>Name</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead className="text-right">Preferred Units</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {candidates.map((c) => (
                  <TableRow key={c.stakeholderId}>
                    <TableCell>
                      <Checkbox
                        aria-label={`Add ${c.name}`}
                        checked={selected.has(c.stakeholderId)}
                        onCheckedChange={(v) =>
                          toggle(c.stakeholderId, v === true)
                        }
                      />
                    </TableCell>
                    <TableCell className="font-medium">{c.name}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {c.email || "—"}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatUnits(c.preferredUnits)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={selected.size === 0 || add.isPending}
            onClick={() => void submit()}
          >
            {add.isPending
              ? "Adding…"
              : `Add ${selected.size} ${selected.size === 1 ? "Member" : "Members"}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function NoticeTable({
  publicId,
  rows,
  latest,
  timeZone,
  canResend,
  onDone,
}: {
  publicId: string;
  rows: { stakeholderId: string; name: string; email: string }[];
  latest: Map<string, EmailRow>;
  timeZone: string;
  canResend: boolean;
  onDone: () => void;
}) {
  const resend = api.resolution.resendNotice.useMutation();
  const [pending, setPending] = useState<string | null>(null);
  const resendOne = async (stakeholderId: string, name: string) => {
    setPending(stakeholderId);
    try {
      await resend.mutateAsync({ publicId, stakeholderId });
      toast.success(`The notice is being re-sent to ${name}.`);
    } catch (e) {
      toast.error(errorMessage(e, "Could not re-send."));
    } finally {
      setPending(null);
      onDone();
    }
  };
  if (rows.length === 0) {
    return (
      <Card className="p-4 text-sm text-muted-foreground">No recipients.</Card>
    );
  }
  return (
    <Card className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Email</TableHead>
            <TableHead>Sent</TableHead>
            <TableHead>Delivery</TableHead>
            <TableHead className="w-24">
              <span className="sr-only">Actions</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => {
            const log = latest.get(r.stakeholderId);
            return (
              <TableRow key={r.stakeholderId}>
                <TableCell className="font-medium">{r.name}</TableCell>
                <TableCell className="text-muted-foreground">
                  {log?.toAddress ?? r.email}
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  {formatInstant(log?.sentAt ?? null, timeZone)}
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  {log ? (
                    <DeliveryState email={log} />
                  ) : (
                    <span className="text-muted-foreground">Not sent yet</span>
                  )}
                </TableCell>
                <TableCell>
                  {canResend ? (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={pending !== null}
                      onClick={() => void resendOne(r.stakeholderId, r.name)}
                    >
                      {pending === r.stakeholderId ? "Sending…" : "Resend"}
                    </Button>
                  ) : null}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </Card>
  );
}

function LinkedPayments({ resolutionId }: { resolutionId: string }) {
  const payments = api.llcFinancials.managerPayment.list.useQuery(
    { from: "2000-01-01", to: "2100-12-31" },
    { retry: false },
  );
  const rows = (payments.data?.rows ?? []).filter(
    (r) => r.resolutionId === resolutionId,
  );
  if (rows.length === 0) return null;
  return (
    <Section title="Linked payments">
      <Card className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Date</TableHead>
              <TableHead>Payee</TableHead>
              <TableHead className="text-right">Amount</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.id}>
                <TableCell className="whitespace-nowrap">
                  {formatDateOnly(r.paidOn)}
                </TableCell>
                <TableCell>{r.payee}</TableCell>
                <TableCell className="text-right">
                  <Money cents={r.amountCents} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
    </Section>
  );
}

export interface ResolutionDetailProps {
  data: ResolutionGetOutput;
  /** `/<companyPublicId>/resolutions` */
  base: string;
  timeZone: string;
  canUpdate: boolean;
  canCreate: boolean;
  canReadDocuments: boolean;
  canReadFinancials: boolean;
  defaultSignerName: string;
}

export function ResolutionDetail({
  data: initialData,
  base,
  timeZone,
  canUpdate,
  canCreate,
  canReadDocuments,
  canReadFinancials,
  defaultSignerName,
}: ResolutionDetailProps) {
  const router = useRouter();
  const utils = api.useUtils();
  const publicId = initialData.resolution.publicId;
  const query = api.resolution.get.useQuery(
    { publicId },
    {
      initialData,
      refetchInterval: (q) =>
        (q.state.data ?? initialData).resolution.status === "SENT"
          ? 30_000
          : false,
    },
  );
  const data = query.data ?? initialData;
  const { resolution, requirements, ballots, snapshot, events, emails } = data;
  const type = resolution.type as ResolutionType;
  const status = resolution.status;
  const isSent = status === "SENT";
  const windowOpen =
    isSent &&
    resolution.closesAt !== null &&
    new Date(resolution.closesAt).getTime() > Date.now();
  const isPo = type === "PURCHASE_ORDER";

  const [withdrawOpen, setWithdrawOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const remind = api.resolution.remind.useMutation();
  const clone = api.resolution.clone.useMutation();
  const [busy, setBusy] = useState<null | "evidence" | "pdf">(null);

  const onChanged = () => {
    void utils.resolution.get.invalidate({ publicId });
    router.refresh();
  };

  const entries = snapshot?.entries ?? [];
  const ballotIds = useMemo(
    () => new Set(ballots.map((b) => b.stakeholderId)),
    [ballots],
  );
  const { notAsked, notEntitled } = useMemo(
    () =>
      data.preset.hasBallots
        ? splitRegister(entries, requirements, ballotIds)
        : { notAsked: [], notEntitled: [] },
    [data.preset.hasBallots, entries, requirements, ballotIds],
  );

  const memberNames: Record<string, string> = {};
  for (const e of entries) memberNames[e.stakeholderId] = e.name;
  const ballotStates: Record<string, string> = {};
  for (const b of ballots) {
    const label = responseLabel(b);
    ballotStates[b.stakeholderId] = label === "—" ? "No response" : label;
  }

  // Result notices go to every Member of the register when effective, else to
  // every invited ballot holder (governance-resolution-finalize).
  const noticeRows =
    status === "EFFECTIVE"
      ? entries
          .filter((e) => e.isMember)
          .map((e) => ({
            stakeholderId: e.stakeholderId,
            name: e.name,
            email: e.email,
          }))
      : ballots
          .filter((b) => b.invitedAt !== null)
          .map((b) => ({
            stakeholderId: b.stakeholderId,
            name: b.name,
            email: b.email,
          }));
  const closed = ["EFFECTIVE", "FAILED", "EXPIRED", "WITHDRAWN"].includes(
    status,
  );

  const remindAll = async () => {
    try {
      const res = await remind.mutateAsync({ publicId });
      toast.success(
        `${res.sent} reminder${res.sent === 1 ? "" : "s"} sent${res.skipped > 0 ? `, ${res.skipped} skipped (already responded, link revoked, or reminded in the last 24 hours)` : ""}.`,
      );
    } catch (e) {
      toast.error(errorMessage(e, "Could not send reminders."));
    } finally {
      onChanged();
    }
  };

  const duplicate = async () => {
    try {
      const res = await clone.mutateAsync({ publicId });
      toast.success("A new draft was created.");
      router.push(`${base}/${res.publicId}`);
    } catch (e) {
      toast.error(errorMessage(e, "Could not duplicate."));
    }
  };

  const exportEvidence = async () => {
    setBusy("evidence");
    try {
      const res = await utils.resolution.evidence.fetch({ publicId });
      downloadCsv(res.fileName, res.csv);
    } catch (e) {
      toast.error(errorMessage(e, "Could not export the evidence."));
    } finally {
      setBusy(null);
    }
  };

  const openExecutedPdf = async () => {
    const doc = data.executedDocument;
    if (!doc) return;
    setBusy("pdf");
    try {
      const res = await utils.document.get.fetch({ publicId: doc.publicId });
      window.open(res.url, "_blank", "noopener,noreferrer");
    } catch (e) {
      toast.error(errorMessage(e, "Could not open the document."));
    } finally {
      setBusy(null);
    }
  };

  const closedLabel =
    status === "EFFECTIVE"
      ? "Effective"
      : status === "WITHDRAWN"
        ? "Withdrawn"
        : "Closed";
  const closedAt =
    status === "EFFECTIVE" ? resolution.effectiveAt : resolution.closedAt;

  return (
    <div className="flex flex-col gap-6" data-slot="resolution-detail">
      {/* 1. Header */}
      <div className="flex flex-col gap-3">
        <Link href={base} className="text-sm text-muted-foreground">
          ← Resolutions
        </Link>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-3">
              {resolution.referenceCode ? (
                <span className="font-mono text-sm text-muted-foreground">
                  {resolution.referenceCode}
                </span>
              ) : null}
              <h3 className="text-lg font-medium">{resolution.title}</h3>
              <StatusBadge status={status} />
            </div>
            <p className="text-sm text-muted-foreground">
              {RESOLUTION_TYPE_LABEL[type] ?? type}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {isSent && canUpdate && data.preset.hasBallots ? (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!windowOpen || remind.isPending}
                  onClick={() => void remindAll()}
                >
                  Remind all pending
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!windowOpen}
                  onClick={() => setAddOpen(true)}
                >
                  Add recipients
                </Button>
              </>
            ) : null}
            {isSent && canUpdate ? (
              <Button
                size="sm"
                variant="destructive"
                onClick={() => setWithdrawOpen(true)}
              >
                Withdraw
              </Button>
            ) : null}
            {canCreate ? (
              <Button
                size="sm"
                variant="outline"
                disabled={clone.isPending}
                onClick={() => void duplicate()}
              >
                Duplicate as new draft
              </Button>
            ) : null}
            <Button
              size="sm"
              variant="outline"
              disabled={busy === "evidence"}
              onClick={() => void exportEvidence()}
            >
              Evidence export (CSV)
            </Button>
            {status === "EFFECTIVE" &&
            data.executedDocument &&
            canReadDocuments ? (
              <Button
                size="sm"
                disabled={busy === "pdf"}
                onClick={() => void openExecutedPdf()}
              >
                Executed PDF
              </Button>
            ) : null}
          </div>
        </div>
        <dl className="grid grid-cols-2 gap-3 rounded border p-3 sm:grid-cols-4">
          <Fact
            label="Record date"
            value={
              resolution.recordDate
                ? formatDateOnly(resolution.recordDate)
                : "—"
            }
          />
          <Fact
            label="Sent"
            value={formatInstant(resolution.sentAt, timeZone)}
          />
          {data.preset.hasBallots ? (
            <Fact
              label="Respond by"
              value={formatInstant(resolution.closesAt, timeZone)}
            />
          ) : null}
          {closed ? (
            <Fact
              label={closedLabel}
              value={formatInstant(closedAt, timeZone)}
            />
          ) : null}
        </dl>
        {status === "WITHDRAWN" && resolution.withdrawnReason ? (
          <Alert>
            <AlertDescription>
              Withdrawn: {resolution.withdrawnReason}
            </AlertDescription>
          </Alert>
        ) : null}
        {/* 9. Term extension information */}
        {status === "EFFECTIVE" && type === "TERM_EXTENSION" ? (
          <Alert>
            <AlertDescription>
              The Target Sale Date is extended by one year (Section 2.5).
            </AlertDescription>
          </Alert>
        ) : null}
      </div>

      {/* 2. Tally */}
      <Section title="Approval required">
        <TallyPanel
          publicId={publicId}
          status={status}
          frozenHash={resolution.frozenHash}
          requirements={requirements}
          memberNames={memberNames}
          ballotStates={ballotStates}
          timeZone={timeZone}
          canSign={canUpdate && windowOpen}
          defaultSignerName={defaultSignerName}
          onChanged={onChanged}
        />
      </Section>

      {/* 3. Ballots */}
      {data.preset.hasBallots ? (
        <Section title="Ballots">
          <BallotTable
            publicId={publicId}
            ballots={ballots}
            emails={emails}
            open={windowOpen}
            canUpdate={canUpdate}
            timeZone={timeZone}
            onChanged={onChanged}
          />
        </Section>
      ) : null}

      {/* 4. Not asked / not entitled */}
      {data.preset.hasBallots && notAsked.length > 0 ? (
        <Section
          title="Not asked"
          description="Entitled to vote but not sent a ballot. Their units still count in the denominator."
        >
          <Card className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead className="text-right">Preferred Units</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {notAsked.map((e) => (
                  <TableRow key={e.stakeholderId}>
                    <TableCell className="font-medium">{e.name}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {e.email || "—"}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatUnits(e.preferredUnits)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
        </Section>
      ) : null}
      {data.preset.hasBallots && notEntitled.length > 0 ? (
        <Section title="Not entitled to vote">
          <Card className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead className="text-right">Preferred Units</TableHead>
                  <TableHead>Reason</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {notEntitled.map(({ entry, reason }) => (
                  <TableRow key={entry.stakeholderId}>
                    <TableCell className="font-medium">{entry.name}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatUnits(entry.preferredUnits)}
                    </TableCell>
                    <TableCell>
                      {EXCLUSION_REASON_TEXT[reason] ?? reason}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
        </Section>
      ) : null}

      {/* 5. Purchase order: copy to Members */}
      {isPo ? (
        <Section
          title="Copy to Members"
          description={
            <>
              Due{" "}
              {resolution.copyDueOn
                ? formatDateOnly(resolution.copyDueOn)
                : "—"}{" "}
              (Section 6.16(i)(B)) · Delivered{" "}
              {resolution.copyDeliveredAt
                ? formatInstant(resolution.copyDeliveredAt, timeZone)
                : "not yet"}
            </>
          }
        >
          <NoticeTable
            publicId={publicId}
            rows={noticeRows}
            latest={latestEmailBy(emails, "resolution.copy")}
            timeZone={timeZone}
            canResend={canUpdate && closed}
            onDone={onChanged}
          />
        </Section>
      ) : null}

      {/* 6. Result notices */}
      {!isPo && closed ? (
        <Section title="Result notices">
          <NoticeTable
            publicId={publicId}
            rows={noticeRows}
            latest={latestEmailBy(emails, "resolution.result")}
            timeZone={timeZone}
            canResend={canUpdate}
            onDone={onChanged}
          />
        </Section>
      ) : null}

      {/* 7. Document */}
      <Section title="Document">
        <Card>
          <CardContent className="space-y-4 p-4">
            <RichDocView doc={data.starter.doc} />
            {data.starter.lockedClauses.length > 0 ? (
              <ol className="list-decimal space-y-1 pl-5 text-sm">
                {data.starter.lockedClauses.map((c, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: frozen, never reordered
                  <li key={i}>{c}</li>
                ))}
              </ol>
            ) : null}
            <p className="break-all font-mono text-xs text-muted-foreground">
              Document hash (SHA-256): {resolution.frozenHash ?? "—"}
            </p>
          </CardContent>
        </Card>
      </Section>

      {/* 8. History */}
      <Section title="History">
        <Card>
          <CardHeader className="sr-only">
            <CardTitle>History</CardTitle>
          </CardHeader>
          <CardContent className="p-4">
            {events.length === 0 ? (
              <p className="text-sm text-muted-foreground">No events.</p>
            ) : (
              <ol className="space-y-2 border-l pl-4">
                {events.map((ev) => (
                  <li key={ev.id} className="text-sm">
                    <span className="block text-xs text-muted-foreground">
                      {formatInstant(ev.occurredAt, timeZone)}
                    </span>
                    {ev.summary}
                  </li>
                ))}
              </ol>
            )}
          </CardContent>
        </Card>
      </Section>

      {/* 10. Linked payments (ECONOMICS) */}
      {canReadFinancials ? (
        <LinkedPayments resolutionId={resolution.id} />
      ) : null}

      <WithdrawDialog
        publicId={publicId}
        open={withdrawOpen}
        onOpenChange={setWithdrawOpen}
        onDone={onChanged}
      />
      <AddRecipientsDialog
        publicId={publicId}
        candidates={notAsked}
        open={addOpen}
        onOpenChange={setAddOpen}
        onDone={onChanged}
      />
    </div>
  );
}
