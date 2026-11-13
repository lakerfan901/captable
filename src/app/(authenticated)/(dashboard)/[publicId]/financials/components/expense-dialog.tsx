"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { MoneyInput } from "@/components/llc/money-input";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { ExpenseCategoryEnum, FundingSourceEnum } from "@/prisma/enums";
import { api } from "@/trpc/react";
import { ZExpenseCreateSchema } from "@/trpc/routers/llc-financials/schema";
import {
  EnumSelect,
  EXPENSE_CATEGORY_LABELS,
  Field,
  FUNDING_SOURCE_LABELS,
  issuesByField,
  type NamedOption,
  OptionSelect,
  useLedgerForm,
} from "./shared";

export const PASS_THROUGH_FEE_NOTE =
  "Marketplace commissions, platform fees and payment-processing fees are deducted from Gross Revenue on the Revenue page. Do not also enter them as expenses.";

function defaultFunding(category: ExpenseCategoryEnum): FundingSourceEnum {
  return category === "ORGANIZATIONAL_OFFERING" ||
    category === "EQUIPMENT_ACQUISITION"
    ? "CAPITAL_CONTRIBUTIONS"
    : "OPERATING_CASH";
}

export function ExpenseDialog({
  today,
  documents,
}: {
  today: string;
  documents: NamedOption[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const form = useLedgerForm({
    incurredOn: today,
    category: "COLOCATION" as ExpenseCategoryEnum,
    payee: "",
    amountCents: null as number | null,
    fundingSource: "OPERATING_CASH" as FundingSourceEnum,
    countsTowardOrgCap: false,
    memo: "",
    documentId: null as string | null,
    resolutionId: "",
  });
  const { values: v, set, errors } = form;
  const mutation = api.llcFinancials.expense.create.useMutation();

  const setCategory = (category: ExpenseCategoryEnum) => {
    set("category", category);
    set("fundingSource", defaultFunding(category));
    set("countsTowardOrgCap", category === "ORGANIZATIONAL_OFFERING");
  };

  const submit = async () => {
    const parsed = ZExpenseCreateSchema.safeParse({
      incurredOn: v.incurredOn,
      category: v.category,
      payee: v.payee,
      amountCents: v.amountCents ?? 0,
      fundingSource: v.fundingSource,
      countsTowardOrgCap: v.countsTowardOrgCap,
      memo: v.memo.trim() === "" ? null : v.memo,
      documentId: v.documentId,
      resolutionId: v.resolutionId.trim() === "" ? null : v.resolutionId.trim(),
    });
    if (!parsed.success) {
      form.setErrors(issuesByField(parsed.error.issues));
      return;
    }
    try {
      await mutation.mutateAsync(parsed.data);
      toast.success("Expense recorded.");
      setOpen(false);
      form.reset();
      router.refresh();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      form.setErrors({ _: message });
      toast.error(message);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>Add expense</Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Add expense</DialogTitle>
          <DialogDescription>{PASS_THROUGH_FEE_NOTE}</DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Date paid or payable" error={errors.incurredOn}>
            <Input
              type="date"
              max={today}
              value={v.incurredOn}
              onChange={(e) => set("incurredOn", e.target.value)}
            />
          </Field>
          <Field label="Amount" error={errors.amountCents}>
            <MoneyInput
              value={v.amountCents}
              onChange={(c) => set("amountCents", c)}
            />
          </Field>
          <Field label="Payee" error={errors.payee}>
            <Input
              value={v.payee}
              onChange={(e) => set("payee", e.target.value)}
            />
          </Field>
          <Field label="Category" error={errors.category}>
            <EnumSelect
              value={v.category}
              onChange={setCategory}
              labels={EXPENSE_CATEGORY_LABELS}
            />
          </Field>
          <Field
            label="Paid from"
            error={errors.fundingSource}
            hint="Operating cash reduces Available Cash; capital contributions reduce unused capital (Section 1.15)."
          >
            <EnumSelect
              value={v.fundingSource}
              onChange={(s) => set("fundingSource", s)}
              labels={FUNDING_SOURCE_LABELS}
            />
          </Field>
          <Field label="Document (optional)" error={errors.documentId}>
            <OptionSelect
              value={v.documentId}
              onChange={(id) => set("documentId", id)}
              options={documents}
              placeholder="No document"
            />
          </Field>
          <div className="flex items-center gap-2 sm:col-span-2">
            <Checkbox
              id="expense-org-cap"
              checked={v.countsTowardOrgCap}
              disabled={v.category === "EQUIPMENT_ACQUISITION"}
              onCheckedChange={(c) => set("countsTowardOrgCap", c === true)}
            />
            <Label htmlFor="expense-org-cap">
              Counts toward the $40,000 organizational and offering expense cap
              (Section 6.21)
            </Label>
          </div>
          {v.countsTowardOrgCap ? (
            <Field
              label="Resolution id (only if the cap is exceeded)"
              error={errors.resolutionId}
              hint="An amount above the cap needs a Preferred Supermajority resolution recorded under Governance."
              className="sm:col-span-2"
            >
              <Input
                value={v.resolutionId}
                onChange={(e) => set("resolutionId", e.target.value)}
              />
            </Field>
          ) : null}
          <Field label="Memo" error={errors.memo} className="sm:col-span-2">
            <Textarea
              value={v.memo}
              onChange={(e) => set("memo", e.target.value)}
            />
          </Field>
        </div>
        {errors._ ? (
          <p className="text-sm text-destructive">{errors._}</p>
        ) : null}
        <DialogFooter>
          <Button
            onClick={submit}
            disabled={mutation.isPending}
            loading={mutation.isPending}
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
