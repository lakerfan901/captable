"use client";

import { useState } from "react";
import { Money, Units } from "@/components/llc/money";
import { MoneyInput } from "@/components/llc/money-input";
import { Alert, AlertDescription } from "@/components/ui/alert";
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
import { formatDateOnly } from "@/lib/date-only";
import { api } from "@/trpc/react";
import { FairValueTable } from "./fair-value-table";

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const UNITS = /^\d+(\.\d{1,6})?$/;
const NONE = "__none__";

type UnitClass = "PREFERRED" | "COMMON";

type Query = {
  asOf: string;
  assetFmvCents: number;
  cashOnHandCents: number;
  liabilitiesCents: number;
  includeMemberLoans: boolean;
  stakeholderId?: string;
  unitClass?: UnitClass;
  unitsValued?: string;
};

/** A field filled from the prefill: the value and the valuation date it is as of. */
type Prefilled = { asOf: string; cents: number } | null;

function PrefilledNote({ p }: { p: Prefilled }) {
  return p ? (
    <p className="text-xs text-muted-foreground">
      Prefilled as of {formatDateOnly(p.asOf)}
    </p>
  ) : null;
}

function PrefillButton({
  label,
  onClick,
  disabled,
}: {
  label: string;
  onClick: () => void;
  disabled: boolean;
}) {
  return (
    <Button
      type="button"
      variant="link"
      size="sm"
      className="h-auto p-0 text-xs"
      disabled={disabled}
      onClick={onClick}
    >
      {label}
    </Button>
  );
}

export function FairValueForm({
  today,
  initialStakeholderId,
}: {
  today: string;
  initialStakeholderId: string | null;
}) {
  const [asOf, setAsOf] = useState(today);
  const [assetFmv, setAssetFmv] = useState<number | null>(null);
  const [cash, setCash] = useState<number | null>(null);
  const [liabilities, setLiabilities] = useState<number | null>(null);
  const [includeLoans, setIncludeLoans] = useState(true);
  const [stakeholderId, setStakeholderId] = useState<string | null>(
    initialStakeholderId,
  );
  const [unitClass, setUnitClass] = useState<UnitClass | null>(null);
  const [units, setUnits] = useState("");
  // Which fields hold a prefilled value, and as of which date. A hand-typed
  // value is never touched; a prefilled one is cleared when the valuation
  // date changes (it was measured on the old date).
  const [cashPrefilled, setCashPrefilled] = useState<Prefilled>(null);
  const [liabilitiesPrefilled, setLiabilitiesPrefilled] =
    useState<Prefilled>(null);
  const [clearedNote, setClearedNote] = useState<string | null>(null);

  // Prefill figures for the SELECTED date (not the last calculated one).
  const prefillQuery = api.llcEconomics.fairValuePrefill.useQuery(
    { asOf },
    { enabled: ISO.test(asOf), retry: false, refetchOnWindowFocus: false },
  );
  const prefill =
    prefillQuery.data && prefillQuery.data.asOf === asOf
      ? prefillQuery.data
      : null;

  const changeAsOf = (next: string) => {
    setAsOf(next);
    const cleared: string[] = [];
    if (cashPrefilled && cashPrefilled.asOf !== next) {
      setCash(null);
      setCashPrefilled(null);
      cleared.push("cash on hand");
    }
    if (liabilitiesPrefilled && liabilitiesPrefilled.asOf !== next) {
      setLiabilities(null);
      setLiabilitiesPrefilled(null);
      cleared.push("liabilities");
    }
    if (cleared.length > 0) {
      setClearedNote(
        `The prefilled ${cleared.join(" and ")} ${cleared.length === 1 ? "was" : "were"} measured on another date and ${cleared.length === 1 ? "was" : "were"} cleared. Prefill again for the new date.`,
      );
    }
  };

  const [query, setQuery] = useState<Query>({
    asOf: today,
    assetFmvCents: 0,
    cashOnHandCents: 0,
    liabilitiesCents: 0,
    includeMemberLoans: true,
  });
  const result = api.llcEconomics.fairValue.useQuery(query, {
    retry: false,
    refetchOnWindowFocus: false,
  });
  // Last good result: member list and prefill survive a failed calculation.
  const [last, setLast] = useState<typeof result.data>(undefined);
  if (result.data && result.data !== last) setLast(result.data);
  const data = result.data ?? last;

  const member = data?.lines.find((l) => l.holderId === stakeholderId) ?? null;
  const holdsPreferred =
    member !== null && member.preferredUnits !== "0.000000";
  const holdsCommon = member !== null && member.commonUnits !== "0.000000";
  const holdsBoth = holdsPreferred && holdsCommon;
  const effectiveClass: UnitClass | null = holdsBoth
    ? unitClass
    : holdsPreferred
      ? "PREFERRED"
      : holdsCommon
        ? "COMMON"
        : null;

  const valid =
    ISO.test(asOf) &&
    (units === "" || UNITS.test(units)) &&
    (!stakeholderId || !holdsBoth || unitClass !== null);

  const calculate = () => {
    if (!valid) return;
    setQuery({
      asOf,
      assetFmvCents: assetFmv ?? 0,
      cashOnHandCents: cash ?? 0,
      liabilitiesCents: liabilities ?? 0,
      includeMemberLoans: includeLoans,
      ...(stakeholderId
        ? {
            stakeholderId,
            unitClass: effectiveClass ?? undefined,
            unitsValued: units === "" ? undefined : units,
          }
        : {}),
    });
  };

  const selected = result.data?.selected ?? null;

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Inputs</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          <div className="grid gap-1.5">
            <Label htmlFor="fv-as-of">Valuation date</Label>
            <Input
              id="fv-as-of"
              type="date"
              value={asOf}
              onChange={(e) => changeAsOf(e.target.value)}
            />
            {clearedNote ? (
              <p className="text-xs text-amber-700" role="status">
                {clearedNote}
              </p>
            ) : null}
          </div>
          <div className="grid gap-1.5">
            <Label>Fair market value of the LLC&apos;s assets</Label>
            <MoneyInput value={assetFmv} onChange={setAssetFmv} />
          </div>
          <div className="grid gap-1.5">
            <Label>Cash on hand</Label>
            <MoneyInput
              value={cash}
              onChange={(cents) => {
                setCash(cents);
                // Typed over: no longer the prefilled figure.
                if (cashPrefilled && cents !== cashPrefilled.cents) {
                  setCashPrefilled(null);
                }
              }}
            />
            <PrefilledNote p={cashPrefilled} />
            <div className="flex gap-3">
              <PrefillButton
                label={`Prefill: Available Cash (before reserves) + reserves as of ${ISO.test(asOf) ? formatDateOnly(asOf) : "the valuation date"}`}
                disabled={!prefill}
                onClick={() => {
                  if (!prefill) return;
                  const cents =
                    Math.max(0, prefill.availableCashRaw) + prefill.reserves;
                  setCash(cents);
                  setCashPrefilled({ asOf: prefill.asOf, cents });
                  setClearedNote(null);
                }}
              />
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label>Liabilities to creditors</Label>
            <MoneyInput
              value={liabilities}
              onChange={(cents) => {
                setLiabilities(cents);
                if (
                  liabilitiesPrefilled &&
                  cents !== liabilitiesPrefilled.cents
                ) {
                  setLiabilitiesPrefilled(null);
                }
              }}
            />
            <PrefilledNote p={liabilitiesPrefilled} />
            <PrefillButton
              label={`Prefill: unpaid Management Fee as of ${ISO.test(asOf) ? formatDateOnly(asOf) : "the valuation date"}`}
              disabled={!prefill}
              onClick={() => {
                if (!prefill) return;
                const cents = prefill.unpaidManagementFee;
                setLiabilities(cents);
                setLiabilitiesPrefilled({ asOf: prefill.asOf, cents });
                setClearedNote(null);
              }}
            />
          </div>
          <div className="flex items-center gap-2 md:col-span-2">
            <Checkbox
              id="fv-loans"
              checked={includeLoans}
              onCheckedChange={(v) => setIncludeLoans(v === true)}
            />
            <Label htmlFor="fv-loans">
              Include member loans (principal and accrued interest
              {prefill ? ` as of ${formatDateOnly(prefill.asOf)}` : ""}:{" "}
              <Money cents={prefill?.memberLoans ?? null} />)
            </Label>
          </div>

          <div className="grid gap-1.5">
            <Label>Member (optional)</Label>
            <Select
              value={stakeholderId ?? NONE}
              onValueChange={(v) => {
                setStakeholderId(v === NONE ? null : v);
                setUnitClass(null);
              }}
            >
              <SelectTrigger>
                <SelectValue placeholder="No member" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>No member</SelectItem>
                {(data?.lines ?? []).map((l) => (
                  <SelectItem key={l.holderId} value={l.holderId}>
                    {l.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {holdsBoth && (
            <div className="grid gap-1.5">
              <Label>Unit class</Label>
              <Select
                value={unitClass ?? undefined}
                onValueChange={(v) => setUnitClass(v as UnitClass)}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Choose a class" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="PREFERRED">Preferred</SelectItem>
                  <SelectItem value="COMMON">Common</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}
          {stakeholderId && (
            <div className="grid gap-1.5">
              <Label htmlFor="fv-units">
                Number of Units (blank = all{" "}
                {effectiveClass === "COMMON" ? (
                  <Units micro={member?.commonUnits} />
                ) : effectiveClass === "PREFERRED" ? (
                  <Units micro={member?.preferredUnits} />
                ) : null}
                )
              </Label>
              <Input
                id="fv-units"
                inputMode="decimal"
                value={units}
                onChange={(e) => setUnits(e.target.value.trim())}
              />
            </div>
          )}

          <div className="md:col-span-2">
            <Button
              type="button"
              onClick={calculate}
              disabled={!valid || result.isFetching}
            >
              {result.isFetching ? "Calculating…" : "Calculate"}
            </Button>
          </div>
        </CardContent>
      </Card>

      {result.error && (
        <Alert variant="destructive">
          <AlertDescription>{result.error.message}</AlertDescription>
        </Alert>
      )}

      {selected && (
        <Alert>
          <AlertDescription>
            <span className="block font-medium">
              Fair value of <Units micro={selected.unitsValued} />{" "}
              {selected.unitClass === "PREFERRED" ? "Preferred" : "Common"}{" "}
              Units: <Money cents={selected.fairValue} />
            </span>
            <span className="block text-muted-foreground">
              <Money cents={selected.classGross} /> (
              {selected.unitClass === "PREFERRED"
                ? "tiers (c) + (d) + Preferred side of (e)"
                : "Common side of tier (e)"}
              ) × <Units micro={selected.unitsValued} /> ÷{" "}
              <Units micro={selected.unitsHeld} /> Units held, rounded to the
              cent.
            </span>
          </AlertDescription>
        </Alert>
      )}

      {result.data && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              Hypothetical liquidation as of {result.data.asOf}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <FairValueTable data={result.data} />
          </CardContent>
        </Card>
      )}

      <p className="text-sm text-muted-foreground">
        This is a calculation aid. The price under Section 7.1 is the lesser of
        the Transfer Notice price and fair value as agreed or appraised.
      </p>
    </div>
  );
}
