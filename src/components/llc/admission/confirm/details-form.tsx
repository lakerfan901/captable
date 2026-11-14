"use client";

import { useState } from "react";
import { toast } from "sonner";
import { InstantTime } from "@/components/common/instant-time";
import {
  centsFromText,
  DollarInput,
  textFromCents,
} from "@/components/llc/commitment/decide-commitment-dialog";
import {
  ACCREDITATION_LABELS,
  HOLDER_TYPE_LABELS,
} from "@/components/llc/member/member-profile-card";
import { Allow } from "@/components/rbac/allow";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAllowed } from "@/hooks/use-allowed";
import { isValidDateOnly } from "@/lib/date-only";
import { formatCents } from "@/lib/money";
import states from "@/lib/states";
import { getPresignedGetUrl } from "@/server/file-upload-actions";
import { api } from "@/trpc/react";
import {
  ACCREDITATION_BASES,
  HOLDER_TYPES,
  type MemberDTO,
} from "@/trpc/routers/stakeholder-router/member-schema";
import { type PacketView, useReview } from "./review-context";

// Section 2 of the confirmation screen (F13): the member record and the
// commitment as the Manager confirms them (`admission.confirmDetails`).
// Prefilled from the investor's answers until a commitment exists, then from
// the saved record. Nothing the investor typed is saved without this click.

type HolderType = (typeof HOLDER_TYPES)[number];
type Basis = (typeof ACCREDITATION_BASES)[number];
type RecordChoice = "" | "replace" | "keep";

type Values = {
  name: string;
  holderType: HolderType | "";
  residenceState: string;
  accreditationBasis: Basis | "";
  streetAddress: string;
  city: string;
  state: string;
  zipcode: string;
  noticeEmail: string;
  signerName: string;
  signerTitle: string;
  phone: string;
  isInsider: boolean;
  committed: string;
  signedOn: string;
  investmentSummaryDate: string;
};

const STATE_CODES = new Set(states.map((s) => s.abbreviation));
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const firstText = (...values: (string | null | undefined)[]) =>
  values.find((v) => v !== null && v !== undefined && v.trim() !== "") ?? "";

/** The form's starting values (see the file comment). */
export function seedValues(view: PacketView): Values {
  const s = view.stakeholder;
  const c = view.commitment;
  // Once a commitment exists the confirmed details are what was saved.
  const p = c ? null : (view.answers?.parsed ?? null);
  const investorEmail = p?.email ?? null;
  return {
    name: firstText(p?.legalName, s.name),
    holderType: p?.holderType ?? s.holderType ?? "",
    residenceState: firstText(p?.residenceState, s.residenceState),
    accreditationBasis:
      p?.accreditationBasis ??
      c?.accreditationBasis ??
      s.accreditationBasis ??
      "",
    streetAddress: firstText(p?.streetAddress, s.streetAddress),
    city: firstText(p?.city, s.city),
    state: firstText(p?.state, s.state),
    zipcode: firstText(p?.zipcode, s.zipcode),
    // The record email is never changed here; a different address the
    // investor gave becomes the notice email.
    noticeEmail:
      investorEmail && investorEmail !== s.email.toLowerCase()
        ? investorEmail
        : (s.noticeEmail ?? ""),
    signerName: firstText(p?.signerName, s.signerName),
    signerTitle: firstText(p?.signerTitle, s.signerTitle),
    phone: s.phone ?? "",
    isInsider: s.isInsider,
    committed: c
      ? textFromCents(c.committedCents)
      : p?.committedCents !== null && p?.committedCents !== undefined
        ? textFromCents(p.committedCents)
        : "",
    signedOn: c?.signedOn ?? p?.investorSignDate ?? "",
    investmentSummaryDate:
      c?.investmentSummaryDate ?? p?.investmentSummaryDate ?? "",
  };
}

const orNull = (v: string) => (v.trim() === "" ? null : v.trim());

type MemberField = {
  key: keyof MemberDTO;
  label: string;
  next: (v: Values, s: MemberDTO) => string | boolean | null;
  show?: (x: string | boolean | null) => string;
};

const showHolder = (x: string | boolean | null) =>
  typeof x === "string" ? (HOLDER_TYPE_LABELS[x as HolderType] ?? x) : "none";
const showBasis = (x: string | boolean | null) =>
  typeof x === "string" ? (ACCREDITATION_LABELS[x as Basis] ?? x) : "none";

/** The 13 member fields `confirmDetails` writes, as the server computes them. */
const MEMBER_FIELDS: MemberField[] = [
  { key: "name", label: "Name", next: (v) => v.name.trim() },
  {
    key: "holderType",
    label: "Holder type",
    next: (v) => v.holderType || null,
    show: showHolder,
  },
  {
    key: "residenceState",
    label: "State of residence",
    next: (v) => v.residenceState.trim().toUpperCase(),
  },
  {
    key: "accreditationBasis",
    label: "Accreditation basis",
    next: (v) => v.accreditationBasis || null,
    show: showBasis,
  },
  {
    key: "streetAddress",
    label: "Street",
    next: (v) => v.streetAddress.trim(),
  },
  { key: "city", label: "City", next: (v) => v.city.trim() },
  { key: "state", label: "State", next: (v) => v.state.trim().toUpperCase() },
  { key: "zipcode", label: "ZIP", next: (v) => v.zipcode.trim() },
  {
    key: "noticeEmail",
    label: "Notice email",
    next: (v, s) => {
      const e = orNull(v.noticeEmail)?.toLowerCase() ?? null;
      return e !== null && e === s.email.toLowerCase() ? null : e;
    },
  },
  {
    key: "signerName",
    label: "Signer name",
    next: (v) => orNull(v.signerName),
  },
  {
    key: "signerTitle",
    label: "Signer title",
    next: (v) => orNull(v.signerTitle),
  },
  { key: "phone", label: "Phone", next: (v) => orNull(v.phone) },
  { key: "isInsider", label: "Insider", next: (v) => v.isInsider },
];

function memberDifferences(v: Values, s: MemberDTO) {
  const plain = (x: string | boolean | null) =>
    x === null || x === ""
      ? "none"
      : typeof x === "boolean"
        ? x
          ? "yes"
          : "no"
        : x;
  return MEMBER_FIELDS.flatMap((f) => {
    const stored = (s[f.key] ?? null) as string | boolean | null;
    const next = f.next(v, s);
    if (stored === next) return [];
    const show = f.show ?? plain;
    return [{ label: f.label, from: show(stored), to: show(next) }];
  });
}

function validate(v: Values, needsChoice: boolean, choice: RecordChoice) {
  const errors: Partial<Record<keyof Values | "choice", string>> = {};
  if (!v.name.trim()) errors.name = "Enter the legal name.";
  if (!v.holderType) errors.holderType = "Choose the holder type.";
  if (!STATE_CODES.has(v.residenceState))
    errors.residenceState = "Choose a US state.";
  if (!v.accreditationBasis)
    errors.accreditationBasis = "Choose the accreditation basis.";
  if (!v.streetAddress.trim()) errors.streetAddress = "Enter the street.";
  if (!v.city.trim()) errors.city = "Enter the city.";
  if (!STATE_CODES.has(v.state)) errors.state = "Choose a US state.";
  if (!v.zipcode.trim()) errors.zipcode = "Enter the ZIP code.";
  if (v.noticeEmail.trim() && !EMAIL_RE.test(v.noticeEmail.trim()))
    errors.noticeEmail = "Enter a valid email or leave it empty.";
  if (
    (v.holderType === "TRUST" || v.holderType === "ENTITY") &&
    !v.signerName.trim()
  )
    errors.signerName = "Signer name is required for trusts and entities.";
  const cents = centsFromText(v.committed);
  if (cents === null || cents <= 0n)
    errors.committed = "Enter the committed amount.";
  if (!isValidDateOnly(v.signedOn))
    errors.signedOn = "Enter the signature date.";
  if (!isValidDateOnly(v.investmentSummaryDate))
    errors.investmentSummaryDate = "Enter the Investment Summary date.";
  if (needsChoice && choice === "")
    errors.choice = "Choose whether these details replace the member record.";
  return errors;
}

function FieldError({ message }: { message?: string }) {
  return message ? <p className="text-xs text-red-600">{message}</p> : null;
}

function StateSelect({
  id,
  value,
  onChange,
  disabled,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  disabled: boolean;
}) {
  return (
    <Select
      value={value || undefined}
      onValueChange={onChange}
      disabled={disabled}
    >
      <SelectTrigger id={id}>
        <SelectValue placeholder="Select a state" />
      </SelectTrigger>
      <SelectContent>
        {states.map((s) => (
          <SelectItem key={s.abbreviation} value={s.abbreviation}>
            {s.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function W9Status() {
  const { view, companyPublicId } = useReview();
  const docs = view.w9Documents;
  const open = async (key: string) => {
    try {
      const file = await getPresignedGetUrl(key);
      window.open(file.url, "_blank");
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Could not open the file.",
      );
    }
  };
  if (docs.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No W-9 yet — the investor has an upload link. You can also attach one
        from the{" "}
        <a
          className="underline"
          href={`/${companyPublicId}/stakeholders/${view.stakeholder.id}`}
        >
          member page
        </a>
        .
      </p>
    );
  }
  return (
    <ul className="flex flex-col gap-1 text-sm">
      {docs.map((d) => (
        <li key={d.id} className="flex items-center gap-3">
          <span>
            W-9 received on <InstantTime at={d.createdAt} dateOnly /> — {d.name}
          </span>
          {d.bucketKey ? (
            <Allow subject="documents" action="read">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => open(d.bucketKey)}
              >
                Open
              </Button>
            </Allow>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

/** Keyed by the caller on the record version and commitment, so it re-seeds. */
export function DetailsForm() {
  const { view, busy, applyView, onError } = useReview();
  const { stakeholder: s, packet, commitment } = view;
  const canUpdateCommitments = useAllowed({
    subject: "commitments",
    action: "update",
  }).isAllowed;
  const canUpdateMembers = useAllowed({
    subject: "stakeholder",
    action: "update",
  }).isAllowed;
  const editableStage =
    packet.stage === "AWAITING_REVIEW" &&
    (commitment === null || commitment.status === "PENDING");
  const editable = editableStage && canUpdateCommitments && canUpdateMembers;

  const [values, setValues] = useState<Values>(() => seedValues(view));
  const [choice, setChoice] = useState<RecordChoice>("");
  const [showErrors, setShowErrors] = useState(false);

  const isProspect = s.memberStatus === "PROSPECT";
  const errors = validate(values, !isProspect, choice);
  const differences = isProspect ? [] : memberDifferences(values, s);

  const set = <K extends keyof Values>(key: K, value: Values[K]) =>
    setValues((v) => ({ ...v, [key]: value }));

  const mutation = api.admission.confirmDetails.useMutation({
    onSuccess: (next) => {
      toast.success(
        commitment ? "Details saved." : "Details saved; commitment created.",
      );
      applyView(next);
    },
    onError,
  });

  const onSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    if (busy || mutation.isPending) return;
    if (Object.keys(errors).length > 0) {
      setShowErrors(true);
      return;
    }
    const cents = centsFromText(values.committed);
    if (
      cents === null ||
      values.holderType === "" ||
      values.accreditationBasis === ""
    )
      return;
    mutation.mutate({
      publicId: packet.publicId,
      stakeholder: {
        name: values.name.trim(),
        holderType: values.holderType,
        residenceState: values.residenceState,
        accreditationBasis: values.accreditationBasis,
        streetAddress: values.streetAddress.trim(),
        city: values.city.trim(),
        state: values.state,
        zipcode: values.zipcode.trim(),
        noticeEmail: orNull(values.noticeEmail)?.toLowerCase() ?? null,
        signerName: orNull(values.signerName),
        signerTitle: orNull(values.signerTitle),
        phone: orNull(values.phone),
        isInsider: values.isInsider,
      },
      commitment: {
        committedCents: Number(cents),
        signedOn: values.signedOn,
        investmentSummaryDate: values.investmentSummaryDate,
      },
      // Exactly what `admission.get` returned last.
      expected: {
        commitmentId: commitment?.id ?? null,
        stakeholderVersion: view.stakeholderVersion,
      },
      ...(isProspect ? {} : { updateMemberRecord: choice === "replace" }),
    });
  };

  const err = (k: keyof Values | "choice") =>
    showErrors ? errors[k] : undefined;
  const disabled = !editable || busy;
  const minimum = view.classTerms.minCommitmentCents;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">
          Member and commitment details
        </CardTitle>
        <CardDescription>
          {editable
            ? "Check each value against the signed page and correct it where needed. Saving writes these details and creates or updates the pending commitment."
            : editableStage
              ? "You do not have permission to confirm these details."
              : "The details can only be changed while the subscription waits for review."}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="flex flex-col gap-5">
          <fieldset disabled={disabled} className="grid gap-4 md:grid-cols-2">
            <div className="flex flex-col gap-2 md:col-span-2">
              <Label htmlFor="d-name">Legal name</Label>
              <Input
                id="d-name"
                value={values.name}
                onChange={(e) => set("name", e.target.value)}
              />
              <FieldError message={err("name")} />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="d-holder">Holder type</Label>
              <Select
                value={values.holderType || undefined}
                onValueChange={(v) => set("holderType", v as HolderType)}
                disabled={disabled}
              >
                <SelectTrigger id="d-holder">
                  <SelectValue placeholder="Select a type" />
                </SelectTrigger>
                <SelectContent>
                  {HOLDER_TYPES.map((t) => (
                    <SelectItem key={t} value={t}>
                      {HOLDER_TYPE_LABELS[t]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FieldError message={err("holderType")} />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="d-res">State of residence (or formation)</Label>
              <StateSelect
                id="d-res"
                value={values.residenceState}
                onChange={(v) => set("residenceState", v)}
                disabled={disabled}
              />
              <FieldError message={err("residenceState")} />
            </div>
            <div className="flex flex-col gap-2 md:col-span-2">
              <Label htmlFor="d-basis">Accreditation basis</Label>
              <Select
                value={values.accreditationBasis || undefined}
                onValueChange={(v) => set("accreditationBasis", v as Basis)}
                disabled={disabled}
              >
                <SelectTrigger id="d-basis">
                  <SelectValue placeholder="Select a basis" />
                </SelectTrigger>
                <SelectContent>
                  {ACCREDITATION_BASES.map((b) => (
                    <SelectItem key={b} value={b}>
                      {ACCREDITATION_LABELS[b]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FieldError message={err("accreditationBasis")} />
            </div>
            <div className="flex flex-col gap-2 md:col-span-2">
              <Label htmlFor="d-street">Street</Label>
              <Input
                id="d-street"
                value={values.streetAddress}
                onChange={(e) => set("streetAddress", e.target.value)}
              />
              <FieldError message={err("streetAddress")} />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="d-city">City</Label>
              <Input
                id="d-city"
                value={values.city}
                onChange={(e) => set("city", e.target.value)}
              />
              <FieldError message={err("city")} />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="flex flex-col gap-2">
                <Label htmlFor="d-state">State</Label>
                <StateSelect
                  id="d-state"
                  value={values.state}
                  onChange={(v) => set("state", v)}
                  disabled={disabled}
                />
                <FieldError message={err("state")} />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="d-zip">ZIP</Label>
                <Input
                  id="d-zip"
                  value={values.zipcode}
                  onChange={(e) => set("zipcode", e.target.value)}
                />
                <FieldError message={err("zipcode")} />
              </div>
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="d-notice">Notice email (optional)</Label>
              <Input
                id="d-notice"
                type="email"
                value={values.noticeEmail}
                placeholder={s.email}
                onChange={(e) => set("noticeEmail", e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                The record email ({s.email}) is not changed here.
              </p>
              <FieldError message={err("noticeEmail")} />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="d-phone">Phone (optional)</Label>
              <Input
                id="d-phone"
                value={values.phone}
                onChange={(e) => set("phone", e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="d-signer">
                Signer name
                {values.holderType === "TRUST" || values.holderType === "ENTITY"
                  ? ""
                  : " (optional)"}
              </Label>
              <Input
                id="d-signer"
                value={values.signerName}
                onChange={(e) => set("signerName", e.target.value)}
              />
              <FieldError message={err("signerName")} />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="d-title">Signer title (optional)</Label>
              <Input
                id="d-title"
                value={values.signerTitle}
                onChange={(e) => set("signerTitle", e.target.value)}
              />
            </div>
            <div className="flex items-start gap-2 md:col-span-2">
              <Checkbox
                id="d-insider"
                checked={values.isInsider}
                onCheckedChange={(v) => set("isInsider", v === true)}
                disabled={disabled}
              />
              <div className="flex flex-col gap-1">
                <Label htmlFor="d-insider">Insider</Label>
                <p className="text-xs text-muted-foreground">
                  Tick for the Manager, Isaac Reid, Karl Schoen, their
                  affiliates, spouses, descendants and their trusts or entities
                  (Section 1.18).
                </p>
              </div>
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="d-committed">
                Capital Contribution committed
              </Label>
              <DollarInput
                id="d-committed"
                value={values.committed}
                onChange={(v) => set("committed", v)}
                disabled={disabled}
              />
              {minimum !== null ? (
                <p className="text-xs text-muted-foreground">
                  Minimum {formatCents(minimum)}
                  {view.classTerms.minCommitmentFloorCents !== null
                    ? ` (waivable to ${formatCents(view.classTerms.minCommitmentFloorCents)}, Section 3.7)`
                    : ""}
                  .
                </p>
              ) : null}
              <FieldError message={err("committed")} />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="flex flex-col gap-2">
                <Label htmlFor="d-signed">Signed on</Label>
                <Input
                  id="d-signed"
                  type="date"
                  value={values.signedOn}
                  max={view.today}
                  onChange={(e) => set("signedOn", e.target.value)}
                />
                <FieldError message={err("signedOn")} />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="d-isd">Investment Summary date</Label>
                <Input
                  id="d-isd"
                  type="date"
                  value={values.investmentSummaryDate}
                  onChange={(e) => set("investmentSummaryDate", e.target.value)}
                />
                <FieldError message={err("investmentSummaryDate")} />
              </div>
            </div>
          </fieldset>

          {editable && !isProspect ? (
            <Alert>
              <AlertTitle>
                {s.name} is already{" "}
                {s.memberStatus === "MEMBER" ? "a Member" : "on the register"}
              </AlertTitle>
              <AlertDescription className="flex flex-col gap-3">
                {differences.length === 0 ? (
                  <p>These details match the member record.</p>
                ) : (
                  <>
                    <p>These details differ from the member record:</p>
                    <ul className="list-disc pl-4">
                      {differences.map((d) => (
                        <li key={d.label}>
                          {d.label}: {d.from} → {d.to}
                        </li>
                      ))}
                    </ul>
                  </>
                )}
                <RadioGroup
                  value={choice}
                  onValueChange={(v) => setChoice(v as RecordChoice)}
                  className="flex flex-col gap-2"
                  disabled={busy}
                >
                  <div className="flex items-center gap-2">
                    <RadioGroupItem value="replace" id="rec-replace" />
                    <Label htmlFor="rec-replace">
                      Replace the member record with these details
                    </Label>
                  </div>
                  <div className="flex items-center gap-2">
                    <RadioGroupItem value="keep" id="rec-keep" />
                    <Label htmlFor="rec-keep">
                      Keep the member record unchanged (save the commitment
                      only)
                    </Label>
                  </div>
                </RadioGroup>
                <FieldError message={err("choice")} />
              </AlertDescription>
            </Alert>
          ) : null}

          <div className="flex flex-col gap-2">
            <h5 className="text-sm font-medium">Form W-9</h5>
            <W9Status />
          </div>

          {editable ? (
            <div className="flex items-center gap-3">
              <Button
                type="submit"
                loading={mutation.isPending}
                disabled={busy || mutation.isPending}
              >
                Save details
              </Button>
              {showErrors && Object.keys(errors).length > 0 ? (
                <p className="text-sm text-red-600">
                  Correct the highlighted fields.
                </p>
              ) : null}
            </div>
          ) : null}
        </form>
      </CardContent>
    </Card>
  );
}
