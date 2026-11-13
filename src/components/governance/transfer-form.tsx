"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import { Textarea } from "@/components/ui/textarea";
import { formatDateOnly, isValidDateOnly } from "@/lib/date-only";
import { computeTransferDates } from "@/lib/governance/dates";
import {
  displayUnits,
  TRANSFER_KINDS,
  type TransferKind,
} from "@/lib/governance/transfer-core";
import { toMicro } from "@/lib/llc/voting";
import { CENTS_MAX, parseDollarsToCents } from "@/lib/money";
import { cn } from "@/lib/utils";
import { api } from "@/trpc/react";
import { classKindLabel } from "./transfer-table";

// Record a transfer (03-governance.md G17, `TransferForm`). The four kinds
// differ in what follows the notice: a voluntary transfer has the Manager's
// consent, the copy to the Preferred Members and the right of first refusal;
// an involuntary transfer has the copy and the purchase option; a transfer to
// a Permitted Transferee and a death or incapacity have neither. The date
// preview uses calendar days only; the 5-business-day copy date depends on
// the company's holiday calendar and is shown after saving.

export interface TransferFormClass {
  id: string;
  name: string;
  kind: "PREFERRED" | "COMMON";
}

/** stakeholderId → unitClassId → units (6 dp) held today. */
export type TransferFormHoldings = Record<string, Record<string, string>>;

interface MemberOption {
  id: string;
  name: string;
  memberStatus: string;
}

export const KIND_CARDS: Record<
  TransferKind,
  { title: string; explanation: string }
> = {
  VOLUNTARY: {
    title: "Sale or other voluntary transfer",
    explanation: "Manager consent and right of first refusal (7.1)",
  },
  PERMITTED_TRANSFEREE: {
    title: "Transfer to a Permitted Transferee",
    explanation:
      "Spouse, descendants, their trust or entity, or an entity Member's owners; notice only (7.1)",
  },
  INVOLUNTARY: {
    title: "Involuntary transfer",
    explanation: "Bankruptcy, divorce, foreclosure, legal process (7.2)",
  },
  DEATH_INCAPACITY: {
    title: "Death or incapacity",
    explanation:
      "The estate, representative or heirs succeed to the Financial Interest (7.3)",
  },
};

const NO_TRANSFEREE = "__none__";
const UNITS_RE = /^\d{1,12}(\.\d{1,6})?$/;

const MEMBER_STATUS_LABEL: Record<string, string> = {
  MEMBER: "Member",
  PROSPECT: "Prospect",
  FINANCIAL_INTEREST_ONLY: "Financial Interest only",
};

function errorText(e: unknown, fallback: string): string {
  return e instanceof Error && e.message ? e.message : fallback;
}

/** Calendar-day dates of the transfer; the business-day copy date is left out. */
function previewDates(kind: TransferKind, noticeReceivedOn: string) {
  // The business-day date is computed by the server; the stub keeps
  // `computeTransferDates` pure here and its result is never shown.
  return computeTransferDates(
    {
      kind,
      noticeReceivedOn,
      transferNoticeOn: null,
      priceEstablishedOn: null,
    },
    (ymd) => ymd,
  );
}

export function TransferForm({
  base,
  members,
  classes,
  holdings,
  today,
}: {
  /** `/<companyPublicId>/transfers` */
  base: string;
  members: MemberOption[];
  classes: TransferFormClass[];
  /** null when the Member Schedule could not be read (no max is shown). */
  holdings: TransferFormHoldings | null;
  /** Today in the company time zone. */
  today: string;
}) {
  const router = useRouter();
  const create = api.unitTransfer.create.useMutation();

  const [kind, setKind] = useState<TransferKind>("VOLUNTARY");
  const [fromId, setFromId] = useState("");
  const [classId, setClassId] = useState("");
  const [units, setUnits] = useState("");
  const [toId, setToId] = useState(NO_TRANSFEREE);
  const [noticeReceivedOn, setNoticeReceivedOn] = useState(today);
  const [price, setPrice] = useState("");
  const [terms, setTerms] = useState("");
  const [bonaFideOffer, setBonaFideOffer] = useState(false);
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);

  const holders =
    holdings === null
      ? members
      : members.filter((m) => Object.keys(holdings[m.id] ?? {}).length > 0);
  const heldByFrom = holdings && fromId ? (holdings[fromId] ?? {}) : null;
  const classOptions =
    heldByFrom === null
      ? classes
      : classes.filter((c) => heldByFrom[c.id] !== undefined);
  const maxUnits = heldByFrom && classId ? heldByFrom[classId] : undefined;
  const selectedClass = classes.find((c) => c.id === classId);

  // Validation (the server checks the same and more).
  const unitsTrimmed = units.trim();
  let unitsError: string | null = null;
  if (unitsTrimmed !== "") {
    if (!UNITS_RE.test(unitsTrimmed)) {
      unitsError = "Up to 6 decimals, e.g. 100 or 40.25.";
    } else if (toMicro(unitsTrimmed) <= 0n) {
      unitsError = "Enter more than zero units.";
    } else if (
      maxUnits !== undefined &&
      toMicro(unitsTrimmed) > toMicro(maxUnits)
    ) {
      unitsError = `The transferor holds only ${displayUnits(maxUnits)} ${classKindLabel(selectedClass?.kind ?? "PREFERRED")} Units.`;
    }
  }
  const dateValid = isValidDateOnly(noticeReceivedOn);
  const dateError =
    noticeReceivedOn === ""
      ? null
      : !dateValid
        ? "Enter a valid date."
        : noticeReceivedOn > today
          ? "The date the notice was received cannot be in the future."
          : null;
  const priceCents =
    price.trim() === "" ? null : parseDollarsToCents(price.trim());
  const priceError =
    price.trim() !== "" &&
    (priceCents === null || priceCents > BigInt(CENTS_MAX))
      ? "Enter an amount in dollars, e.g. 125,000.00."
      : null;

  const canSubmit =
    fromId !== "" &&
    classId !== "" &&
    unitsTrimmed !== "" &&
    unitsError === null &&
    dateValid &&
    dateError === null &&
    priceError === null &&
    !create.isPending;

  const chooseFrom = (id: string) => {
    setFromId(id);
    if (toId === id) setToId(NO_TRANSFEREE);
    const held = holdings?.[id];
    const options = held
      ? classes.filter((c) => held[c.id] !== undefined)
      : classes;
    setClassId(options.length === 1 && options[0] ? options[0].id : "");
  };

  const submit = async () => {
    if (!canSubmit) return;
    setError(null);
    try {
      const res = await create.mutateAsync({
        kind,
        fromStakeholderId: fromId,
        ...(toId !== NO_TRANSFEREE ? { toStakeholderId: toId } : {}),
        unitClassId: classId,
        units: unitsTrimmed,
        noticeReceivedOn,
        ...(priceCents !== null
          ? { proposedPriceCents: Number(priceCents) }
          : {}),
        ...(terms.trim() !== "" ? { terms: terms.trim() } : {}),
        ...(kind === "VOLUNTARY" && bonaFideOffer
          ? { bonaFideOffer: true }
          : {}),
        ...(notes.trim() !== "" ? { notes: notes.trim() } : {}),
      });
      router.push(`${base}/${res.publicId}`);
      router.refresh();
    } catch (e) {
      setError(errorText(e, "The transfer could not be recorded."));
    }
  };

  const dates = dateValid ? previewDates(kind, noticeReceivedOn) : null;
  const involuntary = kind === "INVOLUNTARY";

  return (
    <div className="grid max-w-3xl gap-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Type of transfer</CardTitle>
        </CardHeader>
        <CardContent>
          <RadioGroup
            value={kind}
            onValueChange={(v) => setKind(v as TransferKind)}
            className="grid gap-2 sm:grid-cols-2"
          >
            {TRANSFER_KINDS.map((k) => (
              <Label
                key={k}
                htmlFor={`kind-${k}`}
                className={cn(
                  "flex cursor-pointer items-start gap-3 rounded-md border p-3 font-normal",
                  kind === k ? "border-primary bg-muted/50" : "",
                )}
              >
                <RadioGroupItem value={k} id={`kind-${k}`} className="mt-1" />
                <span className="flex flex-col gap-1">
                  <span className="font-medium">{KIND_CARDS[k].title}</span>
                  <span className="text-xs text-muted-foreground">
                    {KIND_CARDS[k].explanation}
                  </span>
                </span>
              </Label>
            ))}
          </RadioGroup>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Units and parties</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4">
          <div className="grid gap-1">
            <Label htmlFor="transfer-from">
              {kind === "DEATH_INCAPACITY"
                ? "Member (deceased or incapacitated)"
                : "Transferring Member"}
            </Label>
            {holders.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No Member holds Units yet.
              </p>
            ) : (
              <Select value={fromId} onValueChange={chooseFrom}>
                <SelectTrigger id="transfer-from" className="max-w-md">
                  <SelectValue placeholder="Choose the Member" />
                </SelectTrigger>
                <SelectContent>
                  {holders.map((m) => (
                    <SelectItem key={m.id} value={m.id}>
                      {m.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>

          <div className="grid gap-1">
            <Label htmlFor="transfer-class">Unit class</Label>
            <Select
              value={classId}
              onValueChange={setClassId}
              disabled={fromId === ""}
            >
              <SelectTrigger id="transfer-class" className="max-w-md">
                <SelectValue placeholder="Choose the class" />
              </SelectTrigger>
              <SelectContent>
                {classOptions.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name} ({classKindLabel(c.kind)})
                    {heldByFrom?.[c.id]
                      ? ` — holds ${displayUnits(heldByFrom[c.id] ?? "0")}`
                      : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid gap-1">
            <Label htmlFor="transfer-units">Units transferred</Label>
            <div className="flex items-center gap-2">
              <Input
                id="transfer-units"
                inputMode="decimal"
                value={units}
                onChange={(e) => setUnits(e.target.value)}
                className="w-48"
                placeholder="0"
              />
              {maxUnits !== undefined ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setUnits(displayUnits(maxUnits))}
                >
                  All ({displayUnits(maxUnits)})
                </Button>
              ) : null}
            </div>
            {maxUnits !== undefined ? (
              <p className="text-xs text-muted-foreground">
                Maximum {displayUnits(maxUnits)} (held today).
              </p>
            ) : null}
            {unitsError ? (
              <p className="text-xs text-red-700">{unitsError}</p>
            ) : null}
          </div>

          <div className="grid gap-1">
            <Label htmlFor="transfer-to">
              {kind === "DEATH_INCAPACITY"
                ? "Successor (estate, representative or heir) — optional"
                : "Transferee — optional"}
            </Label>
            <Select value={toId} onValueChange={setToId}>
              <SelectTrigger id="transfer-to" className="max-w-md">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_TRANSFEREE}>Not named yet</SelectItem>
                {members
                  .filter((m) => m.id !== fromId)
                  .map((m) => (
                    <SelectItem key={m.id} value={m.id}>
                      {m.name}
                      {MEMBER_STATUS_LABEL[m.memberStatus]
                        ? ` (${MEMBER_STATUS_LABEL[m.memberStatus]})`
                        : ""}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Add the transferee as a prospect on the Members page first.
            </p>
          </div>

          <div className="grid gap-1">
            <Label htmlFor="transfer-notice">
              {kind === "VOLUNTARY"
                ? "Date the Transfer Notice was received"
                : "Date the notice was received"}
            </Label>
            <Input
              id="transfer-notice"
              type="date"
              value={noticeReceivedOn}
              max={today}
              onChange={(e) => setNoticeReceivedOn(e.target.value)}
              className="w-48"
            />
            {dateError ? (
              <p className="text-xs text-red-700">{dateError}</p>
            ) : null}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Price and terms</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4">
          <div className="grid gap-1">
            <Label htmlFor="transfer-price">
              {kind === "VOLUNTARY"
                ? "Proposed price (optional)"
                : "Price (optional)"}
            </Label>
            <Input
              id="transfer-price"
              inputMode="decimal"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              placeholder="$0.00"
              className="w-48"
            />
            {priceError ? (
              <p className="text-xs text-red-700">{priceError}</p>
            ) : null}
          </div>
          <div className="grid gap-1">
            <Label htmlFor="transfer-terms">
              {kind === "VOLUNTARY"
                ? "Payment terms and other material terms (optional)"
                : "Terms (optional)"}
            </Label>
            <Textarea
              id="transfer-terms"
              value={terms}
              maxLength={4000}
              rows={3}
              onChange={(e) => setTerms(e.target.value)}
            />
          </div>
          {kind === "VOLUNTARY" ? (
            <div className="flex items-center gap-2">
              <Checkbox
                id="transfer-bona-fide"
                checked={bonaFideOffer}
                onCheckedChange={(v) => setBonaFideOffer(v === true)}
              />
              <Label htmlFor="transfer-bona-fide" className="font-normal">
                Bona fide offer from a third party
              </Label>
            </div>
          ) : null}
          <div className="grid gap-1">
            <Label htmlFor="transfer-notes">Notes (optional)</Label>
            <Textarea
              id="transfer-notes"
              value={notes}
              maxLength={4000}
              rows={2}
              onChange={(e) => setNotes(e.target.value)}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Dates</CardTitle>
        </CardHeader>
        <CardContent>
          {dates === null ? (
            <p className="text-sm text-muted-foreground">
              Enter the date the notice was received.
            </p>
          ) : (
            <ul className="grid gap-1 text-sm">
              <li>Notice received: {formatDateOnly(noticeReceivedOn)}</li>
              {dates.managerRofrEndsOn ? (
                <>
                  <li>
                    Copy to the other Preferred Members due: 5 business days
                    after the notice (shown after saving)
                  </li>
                  <li>
                    {involuntary
                      ? "Manager's purchase option ends"
                      : "Manager's right of first refusal ends"}
                    : {formatDateOnly(dates.managerRofrEndsOn)}
                  </li>
                </>
              ) : null}
              {dates.memberRofrEndsOn ? (
                <li>
                  {involuntary
                    ? "Preferred Members' purchase option ends"
                    : "Preferred Members' right of first refusal ends"}
                  : {formatDateOnly(dates.memberRofrEndsOn)}
                </li>
              ) : null}
              {dates.closeByOn ? (
                <li>
                  Last day to complete the transfer:{" "}
                  {formatDateOnly(dates.closeByOn)}
                </li>
              ) : null}
              {kind === "PERMITTED_TRANSFEREE" ||
              kind === "DEATH_INCAPACITY" ? (
                <li className="text-muted-foreground">
                  No Manager consent, copy to the Members or right of first
                  refusal applies to this kind of transfer.
                </li>
              ) : null}
              <li className="text-muted-foreground">
                The transfer takes effect on the first day of the month after
                the Manager receives written notice of the transfer (Section
                7.9.1); that date is entered on the transfer's page.
              </li>
            </ul>
          )}
        </CardContent>
      </Card>

      {error ? (
        <Alert variant="destructive">
          <AlertDescription>
            {error.split("\n").map((line) => (
              <p key={line}>{line}</p>
            ))}
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="flex gap-2">
        <Button disabled={!canSubmit} onClick={() => void submit()}>
          {create.isPending ? "Saving…" : "Save transfer"}
        </Button>
        <Button variant="outline" onClick={() => router.push(base)}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
