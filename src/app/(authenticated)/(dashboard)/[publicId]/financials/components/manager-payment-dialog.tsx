"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Money } from "@/components/llc/money";
import { MoneyInput } from "@/components/llc/money-input";
import { Alert, AlertDescription } from "@/components/ui/alert";
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
import type {
  ExpenseCategoryEnum,
  FundingSourceEnum,
  ManagerPaymentCategoryEnum,
} from "@/prisma/enums";
import { api } from "@/trpc/react";
import { ZManagerPaymentCreateSchema } from "@/trpc/routers/llc-financials/schema";
import {
  EnumSelect,
  EXPENSE_CATEGORY_LABELS,
  Field,
  FUNDING_SOURCE_LABELS,
  issuesByField,
  MANAGER_PAYMENT_CATEGORY_LABELS,
  type NamedOption,
  OptionSelect,
  ResolutionSelect,
  useLedgerForm,
} from "./shared";

export const PURCHASE_ORDER_NOTE =
  "Purchase-order approvals (Section 6.16(i)) are recorded under Governance; link the resolution if one exists.";

/** E13 rules: which categories need, forbid or allow a linked expense. */
function expenseMode(
  category: ManagerPaymentCategoryEnum,
): "none" | "required" | "optional" {
  if (category === "MANAGEMENT_FEE") return "none";
  if (category === "OTHER") return "optional";
  return "required";
}

export function ManagerPaymentDialog({
  today,
  documents,
  stakeholders,
}: {
  today: string;
  documents: NamedOption[];
  stakeholders: NamedOption[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const form = useLedgerForm({
    paidOn: today,
    payee: "",
    payeeStakeholderId: null as string | null,
    amountCents: null as number | null,
    category: "MANAGEMENT_FEE" as ManagerPaymentCategoryEnum,
    memo: "",
    documentId: null as string | null,
    resolutionId: null as string | null,
    countsTowardOrgCap: false,
    withExpense: false,
    expenseCategory: "OTHER" as ExpenseCategoryEnum,
    expenseFundingSource: "OPERATING_CASH" as FundingSourceEnum,
    expenseCountsTowardOrgCap: false,
  });
  const { values: v, set, errors } = form;
  const mutation = api.llcFinancials.managerPayment.create.useMutation();
  const cap = api.llcFinancials.managerPayment.capStatus.useQuery(undefined, {
    enabled: open,
  });

  const mode = expenseMode(v.category);
  const hasExpense =
    mode === "required" || (mode === "optional" && v.withExpense);
  const counts = hasExpense
    ? v.expenseCountsTowardOrgCap
    : mode === "optional" && v.countsTowardOrgCap;
  const remaining = cap.data?.remaining ?? null;
  const overCap =
    counts && remaining !== null && (v.amountCents ?? 0) > remaining;

  const submit = async () => {
    const parsed = ZManagerPaymentCreateSchema.safeParse({
      paidOn: v.paidOn,
      payee: v.payee,
      payeeStakeholderId: v.payeeStakeholderId,
      amountCents: v.amountCents ?? 0,
      category: v.category,
      memo: v.memo.trim() === "" ? null : v.memo,
      documentId: v.documentId,
      resolutionId: v.resolutionId,
      countsTowardOrgCap:
        !hasExpense && mode === "optional" && v.countsTowardOrgCap,
      expense: hasExpense
        ? {
            category: v.expenseCategory,
            fundingSource: v.expenseFundingSource,
            countsTowardOrgCap: v.expenseCountsTowardOrgCap,
          }
        : null,
    });
    if (!parsed.success) {
      form.setErrors(issuesByField(parsed.error.issues));
      return;
    }
    try {
      await mutation.mutateAsync(parsed.data);
      toast.success("Manager payment recorded.");
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
        <Button>Add Manager payment</Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Add Manager payment</DialogTitle>
          <DialogDescription>
            Every amount paid by the LLC to or through the Manager and its
            Affiliates (Section 8.2).
          </DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Category" error={errors.category}>
            <EnumSelect
              value={v.category}
              onChange={(c) => set("category", c)}
              labels={MANAGER_PAYMENT_CATEGORY_LABELS}
            />
          </Field>
          <Field label="Paid on" error={errors.paidOn}>
            <Input
              type="date"
              max={today}
              value={v.paidOn}
              onChange={(e) => set("paidOn", e.target.value)}
            />
          </Field>
          <Field label="Payee" error={errors.payee}>
            <Input
              value={v.payee}
              onChange={(e) => set("payee", e.target.value)}
            />
          </Field>
          <Field
            label="Payee member (optional)"
            error={errors.payeeStakeholderId}
          >
            <OptionSelect
              value={v.payeeStakeholderId}
              onChange={(id) => set("payeeStakeholderId", id)}
              options={stakeholders}
              placeholder="Not a member"
            />
          </Field>
          <Field label="Amount" error={errors.amountCents}>
            <MoneyInput
              value={v.amountCents}
              onChange={(c) => set("amountCents", c)}
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

          {v.category === "MANAGEMENT_FEE" ? (
            <p className="text-sm text-muted-foreground sm:col-span-2">
              The Management Fee is accrued monthly and paid quarterly (Section
              6.18). It cannot be paid ahead of accrual, is not an expense and
              does not count toward the Section 6.21 cap.
            </p>
          ) : null}
          {v.category === "PURCHASING_AGENT_PASS_THROUGH" ? (
            <Alert className="sm:col-span-2">
              <AlertDescription>{PURCHASE_ORDER_NOTE}</AlertDescription>
            </Alert>
          ) : null}

          {mode === "optional" ? (
            <div className="flex items-center gap-2 sm:col-span-2">
              <Checkbox
                id="mp-with-expense"
                checked={v.withExpense}
                onCheckedChange={(c) => set("withExpense", c === true)}
              />
              <Label htmlFor="mp-with-expense">
                This payment covers an LLC expense (record the expense with it)
              </Label>
            </div>
          ) : null}

          {hasExpense ? (
            <fieldset className="grid grid-cols-1 gap-4 rounded-md border p-3 sm:col-span-2 sm:grid-cols-2">
              <legend className="px-1 text-sm font-medium">
                Linked expense
              </legend>
              <p className="text-xs text-muted-foreground sm:col-span-2">
                The expense is recorded with this payment so the cost is counted
                exactly once. It is reversed by reversing this payment.
              </p>
              <Field label="Expense category" error={errors.expense}>
                <EnumSelect
                  value={v.expenseCategory}
                  onChange={(c) => {
                    set("expenseCategory", c);
                    set(
                      "expenseCountsTowardOrgCap",
                      c === "ORGANIZATIONAL_OFFERING",
                    );
                    set(
                      "expenseFundingSource",
                      c === "ORGANIZATIONAL_OFFERING" ||
                        c === "EQUIPMENT_ACQUISITION"
                        ? "CAPITAL_CONTRIBUTIONS"
                        : "OPERATING_CASH",
                    );
                  }}
                  labels={EXPENSE_CATEGORY_LABELS}
                />
              </Field>
              <Field label="Paid from">
                <EnumSelect
                  value={v.expenseFundingSource}
                  onChange={(s) => set("expenseFundingSource", s)}
                  labels={FUNDING_SOURCE_LABELS}
                />
              </Field>
              <div className="flex items-center gap-2 sm:col-span-2">
                <Checkbox
                  id="mp-expense-cap"
                  checked={v.expenseCountsTowardOrgCap}
                  disabled={v.expenseCategory === "EQUIPMENT_ACQUISITION"}
                  onCheckedChange={(c) =>
                    set("expenseCountsTowardOrgCap", c === true)
                  }
                />
                <Label htmlFor="mp-expense-cap">
                  Counts toward the Section 6.21 cap
                </Label>
              </div>
            </fieldset>
          ) : null}

          {mode === "optional" && !hasExpense ? (
            <div className="flex items-center gap-2 sm:col-span-2">
              <Checkbox
                id="mp-cap"
                checked={v.countsTowardOrgCap}
                onCheckedChange={(c) => set("countsTowardOrgCap", c === true)}
              />
              <Label htmlFor="mp-cap">Counts toward the Section 6.21 cap</Label>
            </div>
          ) : null}

          {counts ? (
            <div className="rounded-md bg-muted p-3 text-sm sm:col-span-2">
              {cap.data ? (
                <>
                  Section 6.21 cap: <Money cents={cap.data.counted} /> counted
                  of <Money cents={cap.data.limit} />;{" "}
                  <Money cents={cap.data.remaining} /> remaining.
                  {overCap ? (
                    <span className="block text-destructive">
                      This payment would exceed the cap. It needs a Preferred
                      Supermajority resolution: choose it below.
                    </span>
                  ) : null}
                </>
              ) : (
                "Loading cap status…"
              )}
            </div>
          ) : null}

          <Field
            label="Approving resolution (optional)"
            error={errors.resolutionId}
            hint="An effective Governance resolution approving this payment, if any."
          >
            <ResolutionSelect
              value={v.resolutionId}
              onChange={(id) => set("resolutionId", id)}
              enabled={open}
            />
          </Field>
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
