"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { api } from "@/trpc/react";
import { LOCKED_TERM_FIELDS } from "@/trpc/routers/llc-term/schema";
import type { RouterOutputs } from "@/trpc/shared";

type Term = RouterOutputs["llcTerm"]["get"]["term"];

type SwitchValues = {
  prefAccrualCutoff: Term["prefAccrualCutoff"];
  accrueOnDefaulterCapital: boolean;
  capitalReturnLotOrder: Term["capitalReturnLotOrder"];
  forfeitureBaseNetOfReplacementFunding: boolean;
  defaultOffsetOrder: Term["defaultOffsetOrder"];
  includeInsiderDistributionsInManagerList: boolean;
};

type SwitchDef = {
  [K in keyof SwitchValues]: {
    key: K;
    title: string;
    section: string;
    ambiguity: string;
    defaultLabel: string;
    options: { value: string; label: string }[];
  };
}[keyof SwitchValues];

const YES_NO = [
  { value: "true", label: "Yes" },
  { value: "false", label: "No" },
];

const SWITCHES: SwitchDef[] = [
  {
    key: "prefAccrualCutoff",
    title: "Tier (c) measurement date",
    section: "5.6(c), R7",
    ambiguity:
      'Section 5.6(c) says "accrued and unpaid Preferred Return" without a date.',
    defaultLabel: "accrued through the distribution payment date",
    options: [
      { value: "PAYMENT_DATE", label: "Payment date" },
      { value: "PERIOD_END", label: "Period end" },
    ],
  },
  {
    key: "accrueOnDefaulterCapital",
    title: "Defaulting Member's paid capital keeps accruing",
    section: "4.9(iii), R8",
    ambiguity:
      "Section 4.9(iii) suspends votes and distributions, not the accrual of the Preferred Return.",
    defaultLabel: "yes, accrual continues",
    options: YES_NO,
  },
  {
    key: "capitalReturnLotOrder",
    title: "Order in which a return of capital reduces a holder's lots",
    section: "5.6(d), R10",
    ambiguity:
      "The agreement does not say which contributions a tier (d) return reduces first; it only matters while a lot is not yet accruing.",
    defaultLabel: "pro rata to each lot's outstanding amount",
    options: [
      { value: "PRO_RATA", label: "Pro rata" },
      { value: "FIFO", label: "Oldest first" },
      { value: "LIFO", label: "Newest first" },
    ],
  },
  {
    key: "forfeitureBaseNetOfReplacementFunding",
    title: "Forfeiture base reduced by Replacement Funder funding",
    section: "4.9(iv), R33",
    ambiguity:
      'Is the "unpaid Balance on the Forfeiture Date" reduced by amounts Replacement Funders have already funded?',
    defaultLabel:
      "no, measured against what the Defaulting Member itself has not paid",
    options: YES_NO,
  },
  {
    key: "defaultOffsetOrder",
    title: "Order of applying withheld distributions and late payments",
    section: "4.9(iii), R17",
    ambiguity:
      "Section 4.9(iii) lists Balance, interest and costs but does not say which is paid first.",
    defaultLabel: "Balance, then interest, then costs (text order)",
    options: [
      { value: "BALANCE_INTEREST_COSTS", label: "Balance, interest, costs" },
      { value: "COSTS_INTEREST_BALANCE", label: "Costs, interest, Balance" },
    ],
  },
  {
    key: "includeInsiderDistributionsInManagerList",
    title:
      "List distributions and loan repayments to insiders among amounts paid to or through the Manager",
    section: "8.2, R24",
    ambiguity:
      "Read literally, Section 8.2 covers every amount paid to or through the Manager and its Affiliates, including distributions to insiders.",
    defaultLabel: "yes, as a separate sub-list",
    options: YES_NO,
  },
];

const LOCKED = new Set<string>(LOCKED_TERM_FIELDS);

function toText(v: string | boolean): string {
  return typeof v === "boolean" ? String(v) : v;
}

export function SwitchesForm({
  term,
  locked,
  canEdit,
}: {
  term: Term;
  locked: boolean;
  canEdit: boolean;
}) {
  const router = useRouter();
  const [values, setValues] = useState<SwitchValues>({
    prefAccrualCutoff: term.prefAccrualCutoff,
    accrueOnDefaulterCapital: term.accrueOnDefaulterCapital,
    capitalReturnLotOrder: term.capitalReturnLotOrder,
    forfeitureBaseNetOfReplacementFunding:
      term.forfeitureBaseNetOfReplacementFunding,
    defaultOffsetOrder: term.defaultOffsetOrder,
    includeInsiderDistributionsInManagerList:
      term.includeInsiderDistributionsInManagerList,
  });
  const mutation = api.llcTerm.update.useMutation({
    onSuccess: () => {
      toast.success("Interpretation switches saved.");
      router.refresh();
    },
    onError: (error) => toast.error(error.message),
  });

  const setValue = (key: keyof SwitchValues, text: string) => {
    setValues((prev) => ({
      ...prev,
      [key]: text === "true" ? true : text === "false" ? false : text,
    }));
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">Interpretation switches</CardTitle>
        <CardDescription>
          Where the agreement is ambiguous, the default below is used. Most
          switches lock once a Call Notice, default or distribution exists.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <TooltipProvider>
          <form
            className="flex flex-col gap-6"
            onSubmit={(e) => {
              e.preventDefault();
              mutation.mutate(values);
            }}
          >
            {SWITCHES.map((s) => {
              const isLocked = locked && LOCKED.has(s.key);
              const select = (
                <Select
                  value={toText(values[s.key])}
                  onValueChange={(v) => setValue(s.key, v)}
                  disabled={!canEdit || isLocked}
                >
                  <SelectTrigger className="w-72" id={`switch-${s.key}`}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {s.options.map((o) => (
                      <SelectItem key={o.value} value={o.value}>
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              );
              return (
                <div key={s.key} className="space-y-2">
                  <Label htmlFor={`switch-${s.key}`}>
                    {s.title} (§{s.section})
                  </Label>
                  <p className="text-sm text-muted-foreground">
                    {s.ambiguity} Default: {s.defaultLabel}.
                  </p>
                  {isLocked ? (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="inline-block">{select}</span>
                      </TooltipTrigger>
                      <TooltipContent>
                        Locked: a Call Notice, default or distribution exists,
                        and changing it would rewrite history.
                      </TooltipContent>
                    </Tooltip>
                  ) : (
                    select
                  )}
                </div>
              );
            })}
            <div>
              <Button
                type="submit"
                disabled={!canEdit || mutation.isPending}
                loading={mutation.isPending}
              >
                Save switches
              </Button>
            </div>
          </form>
        </TooltipProvider>
      </CardContent>
    </Card>
  );
}
