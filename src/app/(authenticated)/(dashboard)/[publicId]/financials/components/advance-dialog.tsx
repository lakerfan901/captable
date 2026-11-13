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
import type { MemberAdvanceKindEnum } from "@/prisma/enums";
import { api } from "@/trpc/react";
import {
  ZAdvanceCreateSchema,
  ZAdvanceRepaymentSchema,
} from "@/trpc/routers/llc-financials/schema";
import {
  ADVANCE_KIND_LABELS,
  EnumSelect,
  Field,
  issuesByField,
  type NamedOption,
  OptionSelect,
  useLedgerForm,
} from "./shared";

/** Record a tax advance (mode "advance") or a member's cash repayment of one (mode "repayment"), Section 9.2. */
export function AdvanceDialog({
  mode,
  today,
  stakeholders,
  documents,
}: {
  mode: "advance" | "repayment";
  today: string;
  stakeholders: NamedOption[];
  documents: NamedOption[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const form = useLedgerForm({
    stakeholderId: null as string | null,
    on: today,
    kind: "TAX_WITHHOLDING" as MemberAdvanceKindEnum,
    amountCents: null as number | null,
    jurisdiction: "",
    taxYear: "",
    memo: "",
    documentId: null as string | null,
  });
  const { values: v, set, errors } = form;
  const create = api.llcFinancials.advance.create.useMutation();
  const repay = api.llcFinancials.advance.recordRepayment.useMutation();
  const pending = create.isPending || repay.isPending;

  const submit = async () => {
    try {
      if (mode === "advance") {
        const parsed = ZAdvanceCreateSchema.safeParse({
          stakeholderId: v.stakeholderId ?? "",
          paidOn: v.on,
          kind: v.kind,
          amountCents: v.amountCents ?? 0,
          jurisdiction: v.jurisdiction.trim() === "" ? null : v.jurisdiction,
          taxYear: v.taxYear.trim() === "" ? null : Number(v.taxYear),
          memo: v.memo.trim() === "" ? null : v.memo,
          documentId: v.documentId,
        });
        if (!parsed.success) {
          const e = issuesByField(parsed.error.issues);
          form.setErrors({ ...e, on: e.paidOn ?? "" });
          return;
        }
        await create.mutateAsync(parsed.data);
      } else {
        const parsed = ZAdvanceRepaymentSchema.safeParse({
          stakeholderId: v.stakeholderId ?? "",
          recoveredOn: v.on,
          amountCents: v.amountCents ?? 0,
        });
        if (!parsed.success) {
          const e = issuesByField(parsed.error.issues);
          form.setErrors({ ...e, on: e.recoveredOn ?? "" });
          return;
        }
        await repay.mutateAsync(parsed.data);
      }
      toast.success(
        mode === "advance" ? "Tax advance recorded." : "Repayment recorded.",
      );
      setOpen(false);
      form.reset();
      router.refresh();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      form.setErrors({ _: message });
      toast.error(message);
    }
  };

  const title =
    mode === "advance" ? "Add tax advance" : "Record advance repayment";

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant={mode === "advance" ? "default" : "outline"}>
          {title}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {mode === "advance"
              ? "Tax paid on a member's behalf is an advance against, and reduces, that member's next distributions (Section 9.2)."
              : "Cash repaid by the member against outstanding tax advances (Section 9.2)."}
          </DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Member" error={errors.stakeholderId}>
            <OptionSelect
              value={v.stakeholderId}
              onChange={(id) => set("stakeholderId", id)}
              options={stakeholders}
              placeholder="Select member"
            />
          </Field>
          <Field
            label={mode === "advance" ? "Paid on" : "Repaid on"}
            error={errors.on || undefined}
          >
            <Input
              type="date"
              max={today}
              value={v.on}
              onChange={(e) => set("on", e.target.value)}
            />
          </Field>
          <Field label="Amount" error={errors.amountCents}>
            <MoneyInput
              value={v.amountCents}
              onChange={(c) => set("amountCents", c)}
            />
          </Field>
          {mode === "advance" ? (
            <>
              <Field label="Kind" error={errors.kind}>
                <EnumSelect
                  value={v.kind}
                  onChange={(k) => set("kind", k)}
                  labels={ADVANCE_KIND_LABELS}
                />
              </Field>
              <Field
                label="Jurisdiction (optional)"
                error={errors.jurisdiction}
              >
                <Input
                  value={v.jurisdiction}
                  onChange={(e) => set("jurisdiction", e.target.value)}
                />
              </Field>
              <Field label="Tax year (optional)" error={errors.taxYear}>
                <Input
                  inputMode="numeric"
                  value={v.taxYear}
                  onChange={(e) => set("taxYear", e.target.value)}
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
              <Field label="Memo" error={errors.memo} className="sm:col-span-2">
                <Textarea
                  value={v.memo}
                  onChange={(e) => set("memo", e.target.value)}
                />
              </Field>
            </>
          ) : null}
        </div>
        {errors._ ? (
          <p className="text-sm text-destructive">{errors._}</p>
        ) : null}
        <DialogFooter>
          <Button onClick={submit} disabled={pending} loading={pending}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
