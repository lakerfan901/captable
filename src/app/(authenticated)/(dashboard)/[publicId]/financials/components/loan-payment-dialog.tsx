"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { MoneyInput } from "@/components/llc/money-input";
import { Button } from "@/components/ui/button";
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
import type { FundingSourceEnum } from "@/prisma/enums";
import { api } from "@/trpc/react";
import { ZLoanPaymentSchema } from "@/trpc/routers/llc-financials/schema";
import {
  EnumSelect,
  Field,
  FUNDING_SOURCE_LABELS,
  issuesByField,
  useLedgerForm,
} from "./shared";

export function LoanPaymentDialog({
  loanId,
  lenderName,
  today,
}: {
  loanId: string;
  lenderName: string | null;
  today: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const form = useLedgerForm({
    paidOn: today,
    principalCents: null as number | null,
    interestCents: null as number | null,
    fundingSource: "OPERATING_CASH" as FundingSourceEnum,
  });
  const { values: v, set, errors } = form;
  const mutation = api.llcFinancials.loan.recordPayment.useMutation();

  const submit = async () => {
    const parsed = ZLoanPaymentSchema.safeParse({
      memberLoanId: loanId,
      paidOn: v.paidOn,
      principalCents: v.principalCents ?? 0,
      interestCents: v.interestCents ?? 0,
      fundingSource: v.fundingSource,
    });
    if (!parsed.success) {
      form.setErrors(issuesByField(parsed.error.issues));
      return;
    }
    try {
      await mutation.mutateAsync(parsed.data);
      toast.success("Loan payment recorded.");
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
        <Button size="sm" variant="outline">
          Record payment
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Record loan payment</DialogTitle>
          <DialogDescription>
            Payment to {lenderName ?? "the lender"} under the promissory note
            (Section 4.6). Enter the amounts actually paid.
          </DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Paid on" error={errors.paidOn}>
            <Input
              type="date"
              max={today}
              value={v.paidOn}
              onChange={(e) => set("paidOn", e.target.value)}
            />
          </Field>
          <Field label="Paid from" error={errors.fundingSource}>
            <EnumSelect
              value={v.fundingSource}
              onChange={(s) => set("fundingSource", s)}
              labels={FUNDING_SOURCE_LABELS}
            />
          </Field>
          <Field label="Principal" error={errors.principalCents}>
            <MoneyInput
              value={v.principalCents}
              onChange={(c) => set("principalCents", c)}
            />
          </Field>
          <Field label="Interest" error={errors.interestCents}>
            <MoneyInput
              value={v.interestCents}
              onChange={(c) => set("interestCents", c)}
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
