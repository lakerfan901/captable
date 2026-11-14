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
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/trpc/react";
import { ZLoanCreateSchema } from "@/trpc/routers/llc-financials/schema";
import {
  Field,
  issuesByField,
  type NamedOption,
  OptionSelect,
  ResolutionSelect,
  useLedgerForm,
} from "./shared";

export function LoanDialog({
  today,
  stakeholders,
  documents,
}: {
  today: string;
  stakeholders: NamedOption[];
  documents: NamedOption[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const form = useLedgerForm({
    lenderStakeholderId: null as string | null,
    principalCents: null as number | null,
    interestPercent: "",
    madeOn: today,
    maturityOn: "",
    noteDocumentId: null as string | null,
    resolutionId: null as string | null,
    notes: "",
  });
  const { values: v, set, errors } = form;
  const mutation = api.llcFinancials.loan.create.useMutation();

  const submit = async () => {
    const pct = Number(v.interestPercent);
    const parsed = ZLoanCreateSchema.safeParse({
      lenderStakeholderId: v.lenderStakeholderId ?? "",
      principalCents: v.principalCents ?? 0,
      interestBps:
        v.interestPercent.trim() === "" || Number.isNaN(pct)
          ? Number.NaN
          : Math.round(pct * 100),
      madeOn: v.madeOn,
      maturityOn: v.maturityOn,
      noteDocumentId: v.noteDocumentId ?? "",
      resolutionId: v.resolutionId,
      notes: v.notes.trim() === "" ? null : v.notes,
    });
    if (!parsed.success) {
      form.setErrors(issuesByField(parsed.error.issues));
      return;
    }
    try {
      await mutation.mutateAsync(parsed.data);
      toast.success("Member loan recorded.");
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
        <Button>Add member loan</Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Add member loan</DialogTitle>
          <DialogDescription>
            A member advance is not a Capital Contribution. It is documented by
            a promissory note stating its interest rate and maturity and is
            repaid before distributions (Section 4.6).
          </DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Lender" error={errors.lenderStakeholderId}>
            <OptionSelect
              value={v.lenderStakeholderId}
              onChange={(id) => set("lenderStakeholderId", id)}
              options={stakeholders}
              placeholder="Select member"
            />
          </Field>
          <Field label="Principal" error={errors.principalCents}>
            <MoneyInput
              value={v.principalCents}
              onChange={(c) => set("principalCents", c)}
            />
          </Field>
          <Field
            label="Interest rate (% per year, simple)"
            error={errors.interestBps}
          >
            <Input
              inputMode="decimal"
              value={v.interestPercent}
              onChange={(e) => set("interestPercent", e.target.value)}
            />
          </Field>
          <Field label="Promissory note" error={errors.noteDocumentId}>
            <OptionSelect
              value={v.noteDocumentId}
              onChange={(id) => set("noteDocumentId", id)}
              options={documents}
              placeholder="Select document"
            />
          </Field>
          <Field label="Loan date" error={errors.madeOn}>
            <Input
              type="date"
              max={today}
              value={v.madeOn}
              onChange={(e) => set("madeOn", e.target.value)}
            />
          </Field>
          <Field label="Maturity" error={errors.maturityOn}>
            <Input
              type="date"
              value={v.maturityOn}
              onChange={(e) => set("maturityOn", e.target.value)}
            />
          </Field>
          <Field
            label="Approving resolution"
            error={errors.resolutionId}
            hint="The effective Governance resolution approving the loan (Section 6.16(d))."
            className="sm:col-span-2"
          >
            <ResolutionSelect
              value={v.resolutionId}
              onChange={(id) => set("resolutionId", id)}
              enabled={open}
            />
          </Field>
          <Field
            label="Notes"
            error={errors.notes}
            hint="Without a resolution, describe the Preferred Supermajority approval here."
            className="sm:col-span-2"
          >
            <Textarea
              value={v.notes}
              onChange={(e) => set("notes", e.target.value)}
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
