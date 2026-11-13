"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Allow } from "@/components/rbac/allow";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useAllowed } from "@/hooks/use-allowed";
import { formatDateOnly, isValidDateOnly } from "@/lib/date-only";
import { firstOfFollowingMonth } from "@/lib/governance/dates";
import {
  displayUnits,
  hasRofr,
  type TransferKind,
} from "@/lib/governance/transfer-core";
import { CENTS_MAX, formatCents, parseDollarsToCents } from "@/lib/money";
import { cn } from "@/lib/utils";
import { api } from "@/trpc/react";
import type { RouterInputs } from "@/trpc/shared";
import { ReportStatusBadge } from "./report-table";
import { formatInstantDate } from "./resolution-table";
import {
  AdmitDialog,
  CancelTransferDialog,
  CompleteDialog,
  type CompleteResult,
  ErrorLines,
  errorText,
  type TransferGet,
} from "./transfer-actions";
import {
  classKindLabel,
  FINANCIAL_INTEREST_ONLY_LABEL,
  kindLabel,
  TransferStatusBadge,
  unitsText,
} from "./transfer-table";

// Unit transfer page (03-governance.md G17 page 3): summary and timeline,
// then one card per step of Section 7 that applies to the kind of transfer.
// Each card saves only the fields that changed (`unitTransfer.update`
// refuses an empty update) and the page re-renders from the server after
// every change. Recording (completing) the transfer is disabled while any
// card has unsaved changes, because `complete` acts on the saved transfer.

type UpdateFields = Omit<RouterInputs["unitTransfer"]["update"], "publicId">;

export interface TransferMemberOption {
  id: string;
  name: string;
  memberStatus: string;
}

export interface TransferResolutionOption {
  publicId: string;
  label: string;
  status: string;
}

const NONE = "__none__";

const MEMBER_STATUS_LABEL: Record<string, string> = {
  MEMBER: "Member",
  PROSPECT: "Prospect",
  FINANCIAL_INTEREST_ONLY: FINANCIAL_INTEREST_ONLY_LABEL,
};

const DEADLINE_STATUS: Record<
  string,
  { label: string; variant: "warning" | "success" | "outline" }
> = {
  OPEN: { label: "Open", variant: "warning" },
  DONE: { label: "Done", variant: "success" },
  NOT_APPLICABLE: { label: "Not applicable", variant: "outline" },
};

const ROFR_OPTIONS = [
  ["PENDING", "Pending"],
  ["NOT_EXERCISED", "Not exercised"],
  ["EXERCISED_BY_MANAGER", "Exercised by the Manager (or its designee)"],
  ["EXERCISED_BY_MEMBERS", "Exercised by the other Preferred Members"],
] as const;

const ROFR_LABEL: Record<string, string> = {
  NOT_APPLICABLE: "Not applicable",
  ...Object.fromEntries(ROFR_OPTIONS),
};

const CONSENT_OPTIONS = [
  ["PENDING", "Pending"],
  ["GRANTED", "Granted"],
  ["DENIED", "Denied"],
] as const;

const OPINION_OPTIONS = [
  ["RECEIVED", "Opinion of counsel received"],
  ["WAIVED", "Waived by the Manager"],
] as const;

function plainCents(cents: number | null): string {
  if (cents === null) return "";
  return formatCents(cents).replace(/^\$/, "");
}

/** Reports a card's unsaved state to the page; cleared on unmount. */
function useDirty(
  key: string,
  dirty: boolean,
  onDirty: (key: string, dirty: boolean) => void,
) {
  useEffect(() => {
    onDirty(key, dirty);
  }, [key, dirty, onDirty]);
  useEffect(() => () => onDirty(key, false), [key, onDirty]);
}

/** `unitTransfer.update` with the server's refusal kept for display. */
function useTransferUpdate(publicId: string) {
  const router = useRouter();
  const update = api.unitTransfer.update.useMutation();
  const [error, setError] = useState<string | null>(null);
  const save = async (fields: UpdateFields, success: string) => {
    setError(null);
    try {
      await update.mutateAsync({ publicId, ...fields });
      toast.success(success);
      router.refresh();
    } catch (e) {
      setError(errorText(e, "The transfer could not be updated."));
    }
  };
  return { save, pending: update.isPending, error };
}

function SaveRow({
  dirty,
  pending,
  invalid,
  onSave,
  error,
}: {
  dirty: boolean;
  pending: boolean;
  invalid?: boolean;
  onSave: () => void;
  error: string | null;
}) {
  return (
    <div className="flex flex-col gap-2">
      {error ? <ErrorLines message={error} /> : null}
      <Allow subject="governance" action="update">
        <div>
          <Button
            size="sm"
            disabled={!dirty || pending || invalid}
            onClick={onSave}
          >
            {pending ? "Saving…" : "Save"}
          </Button>
        </div>
      </Allow>
    </div>
  );
}

function Field({
  label,
  htmlFor,
  children,
  hint,
}: {
  label: string;
  htmlFor?: string;
  children: React.ReactNode;
  hint?: React.ReactNode;
}) {
  return (
    <div className="grid gap-1">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

function Section({
  title,
  children,
  description,
}: {
  title: string;
  description?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">{title}</CardTitle>
        {description ? (
          <p className="text-sm text-muted-foreground">{description}</p>
        ) : null}
      </CardHeader>
      <CardContent className="grid gap-4">{children}</CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Summary, timeline, deadlines

function Summary({ data, timeZone }: { data: TransferGet; timeZone: string }) {
  const rows: [string, React.ReactNode][] = [
    ["Type", kindLabel(data.kind)],
    [
      data.kind === "DEATH_INCAPACITY" ? "Member" : "Transferring Member",
      data.fromName,
    ],
    [
      "Transferee",
      data.toName
        ? `${data.toName}${data.toMemberStatus ? ` (${MEMBER_STATUS_LABEL[data.toMemberStatus] ?? data.toMemberStatus})` : ""}`
        : "Not named yet",
    ],
    [
      "Units",
      `${unitsText(data.units, data.unitClassKind)}${data.unitClassName && data.unitClassName !== `${classKindLabel(data.unitClassKind)} Units` ? ` (${data.unitClassName})` : ""}`,
    ],
    [
      `${data.fromName} holds today`,
      `${displayUnits(data.fromUnitsToday)} ${classKindLabel(data.unitClassKind)} Units`,
    ],
    [
      "Price",
      data.proposedPriceCents === null
        ? "—"
        : formatCents(data.proposedPriceCents),
    ],
  ];
  if (data.terms) rows.push(["Terms", data.terms]);
  if (data.kind === "VOLUNTARY") {
    rows.push([
      "Bona fide third-party offer",
      data.bonaFideOffer ? "Yes" : "No",
    ]);
  }
  if (data.notes) rows.push(["Notes", data.notes]);
  if (data.status === "COMPLETED" && data.completedAt) {
    rows.push(["Recorded", formatInstantDate(data.completedAt, timeZone)]);
  }
  if (data.status === "CANCELLED") {
    rows.push([
      "Cancelled",
      `${formatInstantDate(data.cancelledAt, timeZone)}${data.cancelReason ? ` — ${data.cancelReason}` : ""}`,
    ]);
  }
  return (
    <Section title="Summary">
      <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-[max-content_1fr]">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-muted-foreground">{k}</dt>
            <dd className="whitespace-pre-line">{v}</dd>
          </div>
        ))}
      </dl>
    </Section>
  );
}

interface TimelineItem {
  label: string;
  date: string | null;
  detail?: string;
}

function Timeline({ data, timeZone }: { data: TransferGet; timeZone: string }) {
  const involuntary = data.kind === "INVOLUNTARY";
  const right = involuntary ? "purchase option" : "right of first refusal";
  const items: TimelineItem[] = [
    { label: "Notice received", date: data.noticeReceivedOn },
  ];
  if (hasRofr(data.kind as TransferKind)) {
    items.push({
      label: "Copy to the other Preferred Members due",
      date: data.noticeCopyDueOn,
      detail: data.noticeCopyReport?.sentAt
        ? `Sent ${formatInstantDate(data.noticeCopyReport.sentAt, timeZone)}`
        : data.noticeCopyReport
          ? "Prepared, not sent"
          : "Not prepared",
    });
    items.push({
      label: `Manager's ${right} ends`,
      date: data.managerRofrEndsOn,
    });
    items.push({
      label: `Preferred Members' ${right} ends`,
      date: data.memberRofrEndsOn,
      detail:
        data.rofrOutcome !== "PENDING"
          ? `${ROFR_LABEL[data.rofrOutcome] ?? data.rofrOutcome}${data.rofrDecidedOn ? ` (${formatDateOnly(data.rofrDecidedOn)})` : ""}`
          : undefined,
    });
  }
  if (data.closeByOn) {
    items.push({ label: "Last day to complete", date: data.closeByOn });
  }
  if (data.priceEstablishedOn) {
    items.push({ label: "Price established", date: data.priceEstablishedOn });
    items.push({
      label: "Purchase closing due (7.7)",
      date: data.purchaseCloseByOn,
    });
  }
  items.push({
    label: "Written notice of the transfer received",
    date: data.transferNoticeOn,
  });
  if (data.status !== "CANCELLED") {
    items.push({
      label:
        data.status === "COMPLETED" ? "Effective" : "Effective if completed",
      date:
        data.status === "COMPLETED"
          ? data.effectiveOn
          : data.effectiveOnIfCompleted,
    });
  }
  if (data.admittedOn) {
    items.push({ label: "Admitted as Member", date: data.admittedOn });
  }

  return (
    <Section title="Key dates">
      <ol className="relative ml-2 border-l">
        {items.map((item) => {
          const past = item.date !== null && item.date <= data.today;
          return (
            <li key={item.label} className="mb-3 ml-4 last:mb-0">
              <span
                className={cn(
                  "absolute -left-1.5 mt-1.5 size-3 rounded-full border",
                  past ? "bg-primary" : "bg-background",
                )}
              />
              <div className="flex flex-wrap items-baseline gap-x-3 text-sm">
                <span className="w-28 shrink-0 tabular-nums">
                  {item.date ? formatDateOnly(item.date) : "—"}
                </span>
                <span>{item.label}</span>
                {item.detail ? (
                  <span className="text-muted-foreground">{item.detail}</span>
                ) : null}
              </div>
            </li>
          );
        })}
      </ol>
    </Section>
  );
}

function Deadlines({
  data,
  companyPublicId,
}: {
  data: TransferGet;
  companyPublicId: string;
}) {
  if (data.deadlines.length === 0) return null;
  return (
    <Section
      title="Deadlines"
      description={
        <>
          On the{" "}
          <Link className="underline" href={`/${companyPublicId}/compliance`}>
            compliance calendar
          </Link>
          , with reminders to the Manager.
        </>
      }
    >
      <ul className="grid gap-2 text-sm">
        {data.deadlines.map((d) => {
          const s = DEADLINE_STATUS[d.status] ?? {
            label: d.status,
            variant: "outline" as const,
          };
          return (
            <li key={d.id} className="flex flex-wrap items-center gap-x-3">
              <span className="w-28 shrink-0 tabular-nums">
                {formatDateOnly(d.dueOn)}
              </span>
              <span>
                {d.title}
                {d.section ? ` (Section ${d.section})` : ""}
              </span>
              <Badge variant={s.variant}>{s.label}</Badge>
              {d.note ? (
                <span className="text-muted-foreground">{d.note}</span>
              ) : null}
            </li>
          );
        })}
      </ul>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Parties and terms (OPEN only)

function TermsCard({
  data,
  members,
  editable,
  onDirty,
}: {
  data: TransferGet;
  members: TransferMemberOption[];
  editable: boolean;
  onDirty: (key: string, dirty: boolean) => void;
}) {
  const { save, pending, error } = useTransferUpdate(data.publicId);
  const [toId, setToId] = useState(data.toStakeholderId ?? NONE);
  const [price, setPrice] = useState(plainCents(data.proposedPriceCents));
  const [terms, setTerms] = useState(data.terms ?? "");
  const [bonaFide, setBonaFide] = useState(data.bonaFideOffer);
  const [priceOn, setPriceOn] = useState(data.priceEstablishedOn ?? "");
  const [notes, setNotes] = useState(data.notes ?? "");

  const priceCents =
    price.trim() === "" ? null : parseDollarsToCents(price.trim());
  const priceInvalid =
    price.trim() !== "" &&
    (priceCents === null || priceCents > BigInt(CENTS_MAX));
  const priceOnInvalid =
    (priceOn === "" && data.priceEstablishedOn !== null) ||
    (priceOn !== "" && !isValidDateOnly(priceOn));

  const fields: UpdateFields = {};
  const to = toId === NONE ? null : toId;
  if (to !== data.toStakeholderId) fields.toStakeholderId = to;
  const cents = priceCents === null ? null : Number(priceCents);
  if (!priceInvalid && cents !== data.proposedPriceCents) {
    fields.proposedPriceCents = cents;
  }
  if (terms.trim() !== (data.terms ?? "")) {
    fields.terms = terms.trim() === "" ? null : terms.trim();
  }
  if (bonaFide !== data.bonaFideOffer) fields.bonaFideOffer = bonaFide;
  if (priceOn !== "" && priceOn !== data.priceEstablishedOn) {
    fields.priceEstablishedOn = priceOn;
  }
  if (notes.trim() !== (data.notes ?? "")) {
    fields.notes = notes.trim() === "" ? null : notes.trim();
  }
  const dirty =
    Object.keys(fields).length > 0 || priceInvalid || priceOnInvalid;
  useDirty("terms", dirty, onDirty);

  const options = members.filter((m) => m.id !== data.fromStakeholderId);
  if (
    data.toStakeholderId &&
    !options.some((m) => m.id === data.toStakeholderId)
  ) {
    options.unshift({
      id: data.toStakeholderId,
      name: data.toName ?? "Transferee",
      memberStatus: data.toMemberStatus ?? "",
    });
  }

  return (
    <Section title="Transferee, price and terms">
      <Field
        label="Transferee"
        htmlFor="terms-to"
        hint="Add the transferee as a prospect on the Members page first."
      >
        <Select value={toId} onValueChange={setToId} disabled={!editable}>
          <SelectTrigger id="terms-to" className="max-w-md">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE}>Not named yet</SelectItem>
            {options.map((m) => (
              <SelectItem key={m.id} value={m.id}>
                {m.name}
                {MEMBER_STATUS_LABEL[m.memberStatus]
                  ? ` (${MEMBER_STATUS_LABEL[m.memberStatus]})`
                  : ""}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Price" htmlFor="terms-price">
          <Input
            id="terms-price"
            inputMode="decimal"
            value={price}
            placeholder="$0.00"
            disabled={!editable}
            onChange={(e) => setPrice(e.target.value)}
          />
          {priceInvalid ? (
            <p className="text-xs text-red-700">
              Enter an amount in dollars, e.g. 125,000.00.
            </p>
          ) : null}
        </Field>
        <Field
          label="Price finally established on (Section 7.7)"
          htmlFor="terms-price-on"
          hint="The purchase must close within 45 days. Once entered it can be moved but not cleared."
        >
          <Input
            id="terms-price-on"
            type="date"
            value={priceOn}
            disabled={!editable}
            onChange={(e) => setPriceOn(e.target.value)}
            className="w-48"
          />
        </Field>
      </div>
      <Field label="Terms" htmlFor="terms-terms">
        <Textarea
          id="terms-terms"
          value={terms}
          rows={3}
          maxLength={4000}
          disabled={!editable}
          onChange={(e) => setTerms(e.target.value)}
        />
      </Field>
      {data.kind === "VOLUNTARY" ? (
        <div className="flex items-center gap-2">
          <Checkbox
            id="terms-bona-fide"
            checked={bonaFide}
            disabled={!editable}
            onCheckedChange={(v) => setBonaFide(v === true)}
          />
          <Label htmlFor="terms-bona-fide" className="font-normal">
            Bona fide offer from a third party
          </Label>
        </div>
      ) : null}
      <Field label="Notes" htmlFor="terms-notes">
        <Textarea
          id="terms-notes"
          value={notes}
          rows={2}
          maxLength={4000}
          disabled={!editable}
          onChange={(e) => setNotes(e.target.value)}
        />
      </Field>
      {editable ? (
        <SaveRow
          dirty={Object.keys(fields).length > 0}
          invalid={priceInvalid || priceOnInvalid}
          pending={pending}
          error={error}
          onSave={() => void save(fields, "Transfer updated.")}
        />
      ) : null}
    </Section>
  );
}

// ---------------------------------------------------------------------------
// 2. Copy to the Preferred Members

function NoticeCopyCard({
  data,
  companyPublicId,
  timeZone,
}: {
  data: TransferGet;
  companyPublicId: string;
  timeZone: string;
}) {
  const router = useRouter();
  const create = api.unitTransfer.createNoticeCopy.useMutation();
  const [error, setError] = useState<string | null>(null);
  const report = data.noticeCopyReport;
  const reportHref = (id: string) => `/${companyPublicId}/reports/${id}`;

  const prepare = async () => {
    setError(null);
    try {
      const res = await create.mutateAsync({ publicId: data.publicId });
      router.push(reportHref(res.reportPublicId));
    } catch (e) {
      setError(errorText(e, "The copy could not be prepared."));
    }
  };

  return (
    <Section
      title="Copy to the Preferred Members"
      description={`The Manager delivers a copy of the ${data.kind === "INVOLUNTARY" ? "notice of the Involuntary Transfer (Section 7.2)" : "Transfer Notice (Section 7.1)"} to the other Preferred Members within 5 business days${data.noticeCopyDueOn ? `, by ${formatDateOnly(data.noticeCopyDueOn)}` : ""}.`}
    >
      {report ? (
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <ReportStatusBadge status={report.status} />
          <span className="text-muted-foreground">
            {report.sentAt
              ? `Sent ${formatInstantDate(report.sentAt, timeZone)}`
              : "Prepared. Attach the notice and send it from the report page."}
          </span>
          <Button asChild size="sm" variant="outline">
            <Link href={reportHref(report.publicId)}>Open the report</Link>
          </Button>
        </div>
      ) : data.status === "OPEN" ? (
        <div className="grid gap-2">
          <p className="text-sm text-muted-foreground">
            Prepares a draft notice to the Members with the details filled in.
            On the report page, attach the notice and send it; it goes to the
            other Preferred Members only.
          </p>
          {error ? <ErrorLines message={error} /> : null}
          <Allow subject="governance" action="create">
            <div>
              <Button
                size="sm"
                disabled={create.isPending}
                onClick={() => void prepare()}
              >
                {create.isPending ? "Preparing…" : "Prepare the copy"}
              </Button>
            </div>
          </Allow>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">Not prepared.</p>
      )}
    </Section>
  );
}

// ---------------------------------------------------------------------------
// 3. Right of first refusal / purchase option

function RofrCard({
  data,
  editable,
  onDirty,
}: {
  data: TransferGet;
  editable: boolean;
  onDirty: (key: string, dirty: boolean) => void;
}) {
  const { save, pending, error } = useTransferUpdate(data.publicId);
  const involuntary = data.kind === "INVOLUNTARY";
  const [outcome, setOutcome] = useState<string>(data.rofrOutcome);
  const [decidedOn, setDecidedOn] = useState(data.rofrDecidedOn ?? "");
  const [note, setNote] = useState(data.rofrNote ?? "");

  const dateInvalid = decidedOn !== "" && !isValidDateOnly(decidedOn);
  const needsDate = outcome === "NOT_EXERCISED" && decidedOn === "";
  const fields: UpdateFields = {};
  if (outcome !== data.rofrOutcome && outcome !== "NOT_APPLICABLE") {
    fields.rofrOutcome = outcome as NonNullable<UpdateFields["rofrOutcome"]>;
  }
  if (!dateInvalid && (decidedOn || null) !== data.rofrDecidedOn) {
    fields.rofrDecidedOn = decidedOn === "" ? null : decidedOn;
  }
  if (note.trim() !== (data.rofrNote ?? "")) {
    fields.rofrNote = note.trim() === "" ? null : note.trim();
  }
  const dirty = Object.keys(fields).length > 0 || dateInvalid;
  useDirty("rofr", dirty, onDirty);

  const earlyWaiver =
    outcome === "NOT_EXERCISED" &&
    data.memberRofrEndsOn !== null &&
    decidedOn !== "" &&
    decidedOn < data.memberRofrEndsOn &&
    note.trim() === "";

  return (
    <Section
      title={involuntary ? "Purchase option" : "Right of first refusal"}
      description={
        involuntary
          ? `The Manager may buy the Units at fair value until ${data.managerRofrEndsOn ? formatDateOnly(data.managerRofrEndsOn) : "—"}; then the other Preferred Members, pro rata, until ${data.memberRofrEndsOn ? formatDateOnly(data.memberRofrEndsOn) : "—"} (Section 7.2).`
          : `The Manager (or its designee) until ${data.managerRofrEndsOn ? formatDateOnly(data.managerRofrEndsOn) : "—"}; then the other Preferred Members, pro rata, until ${data.memberRofrEndsOn ? formatDateOnly(data.memberRofrEndsOn) : "—"} (Section 7.1).`
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Outcome" htmlFor="rofr-outcome">
          <Select
            value={outcome}
            onValueChange={setOutcome}
            disabled={!editable}
          >
            <SelectTrigger id="rofr-outcome">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ROFR_OPTIONS.map(([value, label]) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field label="Decided on" htmlFor="rofr-decided">
          <Input
            id="rofr-decided"
            type="date"
            value={decidedOn}
            disabled={!editable}
            onChange={(e) => setDecidedOn(e.target.value)}
            className="w-48"
          />
          {needsDate ? (
            <p className="text-xs text-red-700">
              Enter the date the right was decided.
            </p>
          ) : null}
        </Field>
      </div>
      <Field
        label="Note"
        htmlFor="rofr-note"
        hint={
          earlyWaiver
            ? "The 90-day period has not ended: note that every holder of the right waived it in writing."
            : undefined
        }
      >
        <Textarea
          id="rofr-note"
          value={note}
          rows={2}
          maxLength={2000}
          disabled={!editable}
          onChange={(e) => setNote(e.target.value)}
        />
      </Field>
      {editable ? (
        <SaveRow
          dirty={Object.keys(fields).length > 0}
          invalid={dateInvalid || needsDate}
          pending={pending}
          error={error}
          onSave={() => void save(fields, "Outcome saved.")}
        />
      ) : null}
    </Section>
  );
}

// ---------------------------------------------------------------------------
// 4. Manager consent

function ConsentCard({
  data,
  editable,
  onDirty,
}: {
  data: TransferGet;
  editable: boolean;
  onDirty: (key: string, dirty: boolean) => void;
}) {
  const { save, pending, error } = useTransferUpdate(data.publicId);
  const [consent, setConsent] = useState<string>(data.managerConsent);
  const [on, setOn] = useState(data.managerConsentOn ?? "");
  const [note, setNote] = useState(data.managerConsentNote ?? "");

  const dateInvalid = on !== "" && !isValidDateOnly(on);
  const fields: UpdateFields = {};
  if (consent !== data.managerConsent && consent !== "NOT_REQUIRED") {
    fields.managerConsent = consent as NonNullable<
      UpdateFields["managerConsent"]
    >;
  }
  if (!dateInvalid && (on || null) !== data.managerConsentOn) {
    fields.managerConsentOn = on === "" ? null : on;
  }
  if (note.trim() !== (data.managerConsentNote ?? "")) {
    fields.managerConsentNote = note.trim() === "" ? null : note.trim();
  }
  useDirty("consent", Object.keys(fields).length > 0 || dateInvalid, onDirty);

  return (
    <Section
      title="Manager consent"
      description="Consent may not be unreasonably withheld for a transfer to an accredited investor who signs Exhibit B and satisfies Section 7.8."
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Consent (Section 7.1)" htmlFor="consent-value">
          <Select
            value={consent}
            onValueChange={setConsent}
            disabled={!editable}
          >
            <SelectTrigger id="consent-value">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CONSENT_OPTIONS.map(([value, label]) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field label="Date" htmlFor="consent-on">
          <Input
            id="consent-on"
            type="date"
            value={on}
            disabled={!editable}
            onChange={(e) => setOn(e.target.value)}
            className="w-48"
          />
        </Field>
      </div>
      <Field label="Note" htmlFor="consent-note">
        <Textarea
          id="consent-note"
          value={note}
          rows={2}
          maxLength={2000}
          disabled={!editable}
          onChange={(e) => setNote(e.target.value)}
        />
      </Field>
      {editable ? (
        <SaveRow
          dirty={Object.keys(fields).length > 0}
          invalid={dateInvalid}
          pending={pending}
          error={error}
          onSave={() => void save(fields, "Consent saved.")}
        />
      ) : null}
    </Section>
  );
}

// ---------------------------------------------------------------------------
// 5. Securities law

function SecuritiesCard({
  data,
  editable,
  onDirty,
}: {
  data: TransferGet;
  editable: boolean;
  onDirty: (key: string, dirty: boolean) => void;
}) {
  const { save, pending, error } = useTransferUpdate(data.publicId);
  const [opinion, setOpinion] = useState<string>(
    data.securitiesOpinion ?? NONE,
  );
  const value = opinion === NONE ? null : opinion;
  const fields: UpdateFields = {};
  if (value !== data.securitiesOpinion) {
    fields.securitiesOpinion = value as UpdateFields["securitiesOpinion"];
  }
  useDirty("securities", Object.keys(fields).length > 0, onDirty);

  return (
    <Section
      title="Securities law"
      description="No transfer without registration unless counsel's opinion is delivered or the Manager waives it (Section 7.6)."
    >
      <Field label="Opinion of counsel" htmlFor="securities-opinion">
        <Select value={opinion} onValueChange={setOpinion} disabled={!editable}>
          <SelectTrigger id="securities-opinion" className="max-w-md">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE}>Not recorded</SelectItem>
            {OPINION_OPTIONS.map(([v, label]) => (
              <SelectItem key={v} value={v}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      {editable ? (
        <SaveRow
          dirty={Object.keys(fields).length > 0}
          pending={pending}
          error={error}
          onSave={() => void save(fields, "Saved.")}
        />
      ) : null}
    </Section>
  );
}

// ---------------------------------------------------------------------------
// 6. Common Units

function CommonUnitsCard({
  data,
  resolutions,
  editable,
  onDirty,
}: {
  data: TransferGet;
  resolutions: TransferResolutionOption[];
  editable: boolean;
  onDirty: (key: string, dirty: boolean) => void;
}) {
  const { save, pending, error } = useTransferUpdate(data.publicId);
  const linked = data.requiredResolution;
  const [resolution, setResolution] = useState(linked?.publicId ?? NONE);
  const [exempt, setExempt] = useState(data.exemptUnder71);
  const [note, setNote] = useState(data.exemptNote ?? "");

  const options = [...resolutions];
  if (linked && !options.some((o) => o.publicId === linked.publicId)) {
    options.unshift({
      publicId: linked.publicId,
      label: linked.referenceCode
        ? `${linked.referenceCode} ${linked.title}`
        : linked.title,
      status: linked.status,
    });
  }

  const fields: UpdateFields = {};
  const resolutionValue = resolution === NONE ? null : resolution;
  if (resolutionValue !== (linked?.publicId ?? null)) {
    fields.requiredResolutionPublicId = resolutionValue;
  }
  if (exempt !== data.exemptUnder71) fields.exemptUnder71 = exempt;
  if (note.trim() !== (data.exemptNote ?? "")) {
    fields.exemptNote = note.trim() === "" ? null : note.trim();
  }
  useDirty("common", Object.keys(fields).length > 0, onDirty);

  return (
    <Section
      title="Common Units"
      description="A transfer of Common Units requires the approval of a Preferred Supermajority, unless it is to Reid, Schoen or an Affiliate that remains controlled by them (Section 7.1)."
    >
      <Field
        label="Approving resolution"
        htmlFor="common-resolution"
        hint={
          linked
            ? `Linked: ${linked.title} (${linked.status === "EFFECTIVE" ? "effective" : linked.status.toLowerCase()}). Only an effective resolution on this matter allows the transfer.`
            : "Resolutions on the transfer of Common Units or a change of control of the Manager."
        }
      >
        <Select
          value={resolution}
          onValueChange={setResolution}
          disabled={!editable}
        >
          <SelectTrigger id="common-resolution" className="max-w-md">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE}>None</SelectItem>
            {options.map((o) => (
              <SelectItem key={o.publicId} value={o.publicId}>
                {o.label}
                {o.status !== "EFFECTIVE" ? ` (${o.status.toLowerCase()})` : ""}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      <div className="flex items-start gap-2">
        <Checkbox
          id="common-exempt"
          checked={exempt}
          disabled={!editable}
          onCheckedChange={(v) => setExempt(v === true)}
          className="mt-0.5"
        />
        <Label htmlFor="common-exempt" className="font-normal">
          Exempt under 7.1 (to Reid, Schoen or a controlled Affiliate)
        </Label>
      </div>
      {exempt ? (
        <Field
          label="Why the exemption applies"
          htmlFor="common-exempt-note"
          hint="Required for the exemption to count."
        >
          <Textarea
            id="common-exempt-note"
            value={note}
            rows={2}
            maxLength={2000}
            disabled={!editable}
            onChange={(e) => setNote(e.target.value)}
          />
        </Field>
      ) : null}
      {editable ? (
        <SaveRow
          dirty={Object.keys(fields).length > 0}
          pending={pending}
          error={error}
          onSave={() => void save(fields, "Saved.")}
        />
      ) : null}
    </Section>
  );
}

// ---------------------------------------------------------------------------
// 7. Complete

function CompleteCard({
  data,
  editable,
  anyDirty,
  onDirty,
  onCompleted,
  timeZone,
}: {
  data: TransferGet;
  editable: boolean;
  anyDirty: boolean;
  onDirty: (key: string, dirty: boolean) => void;
  onCompleted: (result: CompleteResult) => void;
  timeZone: string;
}) {
  const { save, pending, error } = useTransferUpdate(data.publicId);
  const [noticeOn, setNoticeOn] = useState(data.transferNoticeOn ?? "");
  const [open, setOpen] = useState(false);
  const dateValid = noticeOn === "" || isValidDateOnly(noticeOn);
  const future = dateValid && noticeOn !== "" && noticeOn > data.today;
  const fields: UpdateFields = {};
  if (dateValid && (noticeOn || null) !== data.transferNoticeOn) {
    fields.transferNoticeOn = noticeOn === "" ? null : noticeOn;
  }
  const noticeDirty = Object.keys(fields).length > 0 || !dateValid;
  useDirty("complete", noticeDirty, onDirty);

  if (data.status === "COMPLETED") {
    return (
      <Section title="Transfer recorded">
        <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-[max-content_1fr]">
          <dt className="text-muted-foreground">
            Written notice of the transfer received
          </dt>
          <dd>
            {data.transferNoticeOn
              ? formatDateOnly(data.transferNoticeOn)
              : "—"}
          </dd>
          <dt className="text-muted-foreground">Effective</dt>
          <dd className="font-medium">
            {data.effectiveOn ? formatDateOnly(data.effectiveOn) : "—"}
          </dd>
          <dt className="text-muted-foreground">Recorded</dt>
          <dd>{formatInstantDate(data.completedAt, timeZone)}</dd>
          <dt className="text-muted-foreground">Transferee</dt>
          <dd>
            {data.toName}:{" "}
            {data.admittedOn
              ? `Member, admitted ${formatDateOnly(data.admittedOn)}`
              : FINANCIAL_INTEREST_ONLY_LABEL}
          </dd>
        </dl>
      </Section>
    );
  }
  if (data.status !== "OPEN") return null;

  const effectivePreview =
    noticeOn !== "" && isValidDateOnly(noticeOn)
      ? firstOfFollowingMonth(noticeOn)
      : null;
  const blocked = data.completionErrors.length > 0;

  return (
    <Section
      title="Complete"
      description="A permitted transfer takes effect on the first day of the month after the Manager receives written notice of the transfer (Section 7.9.1)."
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Date the Manager received written notice of the transfer"
          htmlFor="complete-notice"
        >
          <Input
            id="complete-notice"
            type="date"
            value={noticeOn}
            max={data.today}
            disabled={!editable}
            onChange={(e) => setNoticeOn(e.target.value)}
            className="w-48"
          />
          {future ? (
            <p className="text-xs text-red-700">
              The notice date cannot be in the future.
            </p>
          ) : null}
        </Field>
        <Field label="Effective date">
          <p className="text-sm font-medium">
            {effectivePreview ? formatDateOnly(effectivePreview) : "—"}
            {noticeDirty ? (
              <span className="font-normal text-muted-foreground">
                {" "}
                (save the date to use it)
              </span>
            ) : null}
          </p>
        </Field>
      </div>
      {editable ? (
        <SaveRow
          dirty={Object.keys(fields).length > 0}
          invalid={!dateValid}
          pending={pending}
          error={error}
          onSave={() => void save(fields, "Notice date saved.")}
        />
      ) : null}

      {blocked ? (
        <Alert>
          <AlertTitle>Before the transfer can be recorded</AlertTitle>
          <AlertDescription>
            <ul className="list-disc space-y-1 pl-4">
              {data.completionErrors.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      ) : (
        <p className="text-sm text-muted-foreground">
          Every condition recorded on this page is met. Other open matters (a
          default, closed books, a pending vote or distribution) are checked
          when the transfer is recorded.
        </p>
      )}
      {anyDirty ? (
        <p className="text-sm text-amber-700">
          Save or undo the changes on this page before recording the transfer.
        </p>
      ) : null}

      <Allow subject="governance" action="update">
        <div>
          <Button disabled={blocked || anyDirty} onClick={() => setOpen(true)}>
            Record the transfer…
          </Button>
        </div>
      </Allow>
      <CompleteDialog
        data={data}
        open={open}
        onOpenChange={setOpen}
        onCompleted={onCompleted}
      />
    </Section>
  );
}

// ---------------------------------------------------------------------------
// 8. Admission

function AdmissionCard({
  data,
  canUpdate,
  onDirty,
}: {
  data: TransferGet;
  canUpdate: boolean;
  onDirty: (key: string, dirty: boolean) => void;
}) {
  const { save, pending, error } = useTransferUpdate(data.publicId);
  const [sig, setSig] = useState(data.admissionSignaturePage);
  const [expenses, setExpenses] = useState(data.admissionExpensesPaid);
  const [qualified, setQualified] = useState(data.admissionQualified);
  const [consent, setConsent] = useState(data.admissionManagerConsent);
  const earliest =
    data.effectiveOn && data.effectiveOn > data.today ? null : data.today;
  const [admittedOn, setAdmittedOn] = useState(earliest ?? "");
  const [open, setOpen] = useState(false);

  const editable =
    canUpdate &&
    (data.status === "OPEN" ||
      (data.status === "COMPLETED" && data.admittedOn === null));

  const fields: UpdateFields = {};
  if (sig !== data.admissionSignaturePage) fields.admissionSignaturePage = sig;
  if (expenses !== data.admissionExpensesPaid) {
    fields.admissionExpensesPaid = expenses;
  }
  if (qualified !== data.admissionQualified) {
    fields.admissionQualified = qualified;
  }
  if (consent !== data.admissionManagerConsent) {
    fields.admissionManagerConsent = consent;
  }
  const dirty = Object.keys(fields).length > 0;
  useDirty("admission", dirty, onDirty);

  const permitted = data.kind === "PERMITTED_TRANSFEREE";
  const noAccreditation =
    data.kind === "INVOLUNTARY" || data.kind === "DEATH_INCAPACITY";
  const boxes: [string, string, boolean, (v: boolean) => void][] = [
    [
      "admission-sig",
      "Exhibit B signature page and adoption instrument received (7.8(a))",
      sig,
      setSig,
    ],
    [
      "admission-expenses",
      "Admission expenses paid or waived (7.8(b))",
      expenses,
      setExpenses,
    ],
    [
      "admission-qualified",
      noAccreditation
        ? "Legal and regulatory requirements satisfied (accredited-investor status not required)"
        : "Legal and regulatory requirements satisfied, including accredited-investor status (7.8(c))",
      qualified,
      setQualified,
    ],
  ];
  if (!permitted) {
    boxes.push([
      "admission-consent",
      "Manager consents to the admission (7.8(d))",
      consent,
      setConsent,
    ]);
  }

  const canAdmitNow =
    data.status === "COMPLETED" && data.admittedOn === null && canUpdate;
  const effectiveOn = data.effectiveOn;
  let dateError: string | null = null;
  if (admittedOn !== "") {
    if (!isValidDateOnly(admittedOn)) dateError = "Enter a valid date.";
    else if (effectiveOn && admittedOn < effectiveOn) {
      dateError = `The admission date cannot be before the transfer took effect (${formatDateOnly(effectiveOn)}).`;
    } else if (admittedOn > data.today) {
      dateError = "The admission date cannot be in the future.";
    }
  }

  return (
    <Section
      title="Admission as Substitute Member (Section 7.8)"
      description={
        data.status === "COMPLETED" && data.admittedOn === null
          ? `${data.toName ?? "The transferee"} holds a Financial Interest only — distributions and allocations, no vote — until admitted by the Manager.`
          : "Admission is a Manager action. The transferee must sign Exhibit B and satisfy Section 7.8."
      }
    >
      {data.admittedOn ? (
        <p className="text-sm">
          {data.toName} was admitted as a Member on{" "}
          <span className="font-medium">{formatDateOnly(data.admittedOn)}</span>
          .
        </p>
      ) : null}
      <div className="grid gap-2">
        {boxes.map(([id, label, checked, set]) => (
          <div key={id} className="flex items-start gap-2">
            <Checkbox
              id={id}
              checked={checked}
              disabled={!editable}
              onCheckedChange={(v) => set(v === true)}
              className="mt-0.5"
            />
            <Label htmlFor={id} className="font-normal">
              {label}
            </Label>
          </div>
        ))}
      </div>
      {editable ? (
        <SaveRow
          dirty={dirty}
          pending={pending}
          error={error}
          onSave={() => void save(fields, "Checklist saved.")}
        />
      ) : null}

      {data.status === "OPEN" ? (
        <p className="text-sm text-muted-foreground">
          {data.toMemberStatus === "MEMBER"
            ? "The transferee is already a Member: complete this checklist before recording the transfer."
            : "The transferee can be admitted once the transfer is recorded."}
        </p>
      ) : null}

      {canAdmitNow ? (
        <div className="grid gap-3 border-t pt-4">
          {!dirty && data.admissionErrors.length > 0 ? (
            <ul className="list-disc space-y-1 pl-4 text-sm text-muted-foreground">
              {data.admissionErrors.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          ) : null}
          {earliest === null && effectiveOn ? (
            <p className="text-sm text-muted-foreground">
              The transferee can be admitted from {formatDateOnly(effectiveOn)},
              when the transfer takes effect.
            </p>
          ) : (
            <Field label="Admission date" htmlFor="admission-date">
              <Input
                id="admission-date"
                type="date"
                value={admittedOn}
                min={effectiveOn ?? undefined}
                max={data.today}
                onChange={(e) => setAdmittedOn(e.target.value)}
                className="w-48"
              />
              {dateError ? (
                <p className="text-xs text-red-700">{dateError}</p>
              ) : null}
            </Field>
          )}
          <Allow subject="governance" action="update">
            <div>
              <Button
                disabled={
                  dirty ||
                  earliest === null ||
                  admittedOn === "" ||
                  dateError !== null ||
                  data.admissionErrors.length > 0
                }
                onClick={() => setOpen(true)}
              >
                Admit as Member
              </Button>
            </div>
          </Allow>
          <AdmitDialog
            data={data}
            admittedOn={admittedOn}
            open={open}
            onOpenChange={setOpen}
          />
        </div>
      ) : null}
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Page

export function TransferDetail({
  data,
  base,
  companyPublicId,
  members,
  resolutions,
  timeZone,
}: {
  data: TransferGet;
  /** `/<companyPublicId>/transfers` */
  base: string;
  companyPublicId: string;
  members: TransferMemberOption[];
  resolutions: TransferResolutionOption[];
  timeZone: string;
}) {
  const { isAllowed: canUpdate } = useAllowed({
    subject: "governance",
    action: "update",
  });
  const [dirtyKeys, setDirtyKeys] = useState<Record<string, boolean>>({});
  const onDirty = useCallback((key: string, dirty: boolean) => {
    setDirtyKeys((prev) =>
      prev[key] === dirty ? prev : { ...prev, [key]: dirty },
    );
  }, []);
  const anyDirty = Object.values(dirtyKeys).some(Boolean);
  const [result, setResult] = useState<CompleteResult | null>(null);
  const [cancelOpen, setCancelOpen] = useState(false);

  const kind = data.kind as TransferKind;
  const isOpen = data.status === "OPEN";
  const editable = canUpdate && isOpen;
  // Cards remount with the server's values after every change.
  const stamp = String(new Date(data.updatedAt).getTime());

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <Link href={base} className="text-sm text-muted-foreground">
          ← Transfers
        </Link>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="font-medium">
              Transfer of {unitsText(data.units, data.unitClassKind)} by{" "}
              {data.fromName}
            </h3>
            <p className="text-sm text-muted-foreground">
              {kindLabel(kind)}
              {data.toName ? ` to ${data.toName}` : ""}
            </p>
          </div>
          <TransferStatusBadge
            status={data.status}
            admittedOn={data.admittedOn}
          />
        </div>
      </div>

      {result ? (
        <Alert>
          <AlertTitle>Transfer recorded</AlertTitle>
          <AlertDescription>
            Effective {formatDateOnly(result.effectiveOn)}.{" "}
            {result.transfereeStatus === "MEMBER"
              ? `${data.toName ?? "The transferee"} is a Member${result.admittedOn ? ` (admitted ${formatDateOnly(result.admittedOn)})` : ""}.`
              : `${data.toName ?? "The transferee"} holds a Financial Interest only until admitted below.`}
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <Summary data={data} timeZone={timeZone} />
        <Timeline data={data} timeZone={timeZone} />
      </div>
      <Deadlines data={data} companyPublicId={companyPublicId} />

      {isOpen ? (
        <TermsCard
          key={`terms-${stamp}`}
          data={data}
          members={members}
          editable={editable}
          onDirty={onDirty}
        />
      ) : null}

      {hasRofr(kind) ? (
        <NoticeCopyCard
          data={data}
          companyPublicId={companyPublicId}
          timeZone={timeZone}
        />
      ) : null}
      {hasRofr(kind) ? (
        <RofrCard
          key={`rofr-${stamp}`}
          data={data}
          editable={editable}
          onDirty={onDirty}
        />
      ) : null}
      {kind === "VOLUNTARY" ? (
        <ConsentCard
          key={`consent-${stamp}`}
          data={data}
          editable={editable}
          onDirty={onDirty}
        />
      ) : null}
      {kind === "VOLUNTARY" || kind === "PERMITTED_TRANSFEREE" ? (
        <SecuritiesCard
          key={`securities-${stamp}`}
          data={data}
          editable={editable}
          onDirty={onDirty}
        />
      ) : null}
      {data.unitClassKind === "COMMON" ? (
        <CommonUnitsCard
          key={`common-${stamp}`}
          data={data}
          resolutions={resolutions}
          editable={editable}
          onDirty={onDirty}
        />
      ) : null}

      <CompleteCard
        key={`complete-${stamp}`}
        data={data}
        editable={editable}
        anyDirty={anyDirty}
        onDirty={onDirty}
        onCompleted={setResult}
        timeZone={timeZone}
      />

      {data.status !== "CANCELLED" && data.toStakeholderId ? (
        <AdmissionCard
          key={`admission-${stamp}`}
          data={data}
          canUpdate={canUpdate}
          onDirty={onDirty}
        />
      ) : null}

      {isOpen ? (
        <Allow subject="governance" action="update">
          <Section
            title="Cancel transfer"
            description="Closes a transfer that will not go ahead. No Units move."
          >
            <div>
              <Button
                variant="outline"
                className="text-red-700"
                onClick={() => setCancelOpen(true)}
              >
                Cancel transfer…
              </Button>
            </div>
            <CancelTransferDialog
              data={data}
              open={cancelOpen}
              onOpenChange={setCancelOpen}
            />
          </Section>
        </Allow>
      ) : null}
    </div>
  );
}
