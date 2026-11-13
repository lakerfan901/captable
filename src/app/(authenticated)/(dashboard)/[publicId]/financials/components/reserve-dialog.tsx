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
import type { FundingSourceEnum, ReserveKindEnum } from "@/prisma/enums";
import { api } from "@/trpc/react";
import {
  ZReserveEstablishSchema,
  ZReserveReleaseSchema,
} from "@/trpc/routers/llc-financials/schema";
import {
  EnumSelect,
  Field,
  FUNDING_SOURCE_LABELS,
  issuesByField,
  RESERVE_KIND_LABELS,
  useLedgerForm,
} from "./shared";

/** Establish (mode "establish") or release (mode "release") a reserve (R21). */
export function ReserveDialog({
  mode,
  today,
}: {
  mode: "establish" | "release";
  today: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const form = useLedgerForm({
    effectiveOn: today,
    kind: "MINIMUM_OPERATING" as ReserveKindEnum,
    amountCents: null as number | null,
    fundingSource: "OPERATING_CASH" as FundingSourceEnum,
    releaseTo: "OPERATING_CASH" as FundingSourceEnum,
    reason: "",
    allowBelowMinimum: false,
  });
  const { values: v, set, errors } = form;
  const establish = api.llcFinancials.reserve.establish.useMutation();
  const release = api.llcFinancials.reserve.release.useMutation();
  const pending = establish.isPending || release.isPending;
  const crossPool = mode === "release" && v.releaseTo !== v.fundingSource;

  const submit = async () => {
    const base = {
      effectiveOn: v.effectiveOn,
      kind: v.kind,
      amountCents: v.amountCents ?? 0,
      fundingSource: v.fundingSource,
      reason: v.reason,
    };
    try {
      if (mode === "establish") {
        const parsed = ZReserveEstablishSchema.safeParse(base);
        if (!parsed.success) {
          form.setErrors(issuesByField(parsed.error.issues));
          return;
        }
        await establish.mutateAsync(parsed.data);
      } else {
        const parsed = ZReserveReleaseSchema.safeParse({
          ...base,
          releaseTo: v.releaseTo,
          allowBelowMinimum: v.allowBelowMinimum,
        });
        if (!parsed.success) {
          form.setErrors(issuesByField(parsed.error.issues));
          return;
        }
        await release.mutateAsync(parsed.data);
      }
      toast.success(
        mode === "establish" ? "Reserve established." : "Reserve released.",
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

  const title = mode === "establish" ? "Establish reserve" : "Release reserve";

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant={mode === "establish" ? "default" : "outline"}>
          {title}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {mode === "establish"
              ? "A reserve funded from operating cash reduces Available Cash; one funded from capital contributions reduces unused capital (Section 5.6(a), Section 1.15)."
              : "Released cash returns to the pool the reserve was funded from. To send it to the other pool, choose it below and give the reason; such a release cannot be reversed."}
          </DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Reserve" error={errors.kind}>
            <EnumSelect
              value={v.kind}
              onChange={(k) => set("kind", k)}
              labels={RESERVE_KIND_LABELS}
            />
          </Field>
          <Field label="Effective on" error={errors.effectiveOn}>
            <Input
              type="date"
              max={today}
              value={v.effectiveOn}
              onChange={(e) => set("effectiveOn", e.target.value)}
            />
          </Field>
          <Field label="Amount" error={errors.amountCents}>
            <MoneyInput
              value={v.amountCents}
              onChange={(c) => set("amountCents", c)}
            />
          </Field>
          <Field
            label={mode === "establish" ? "Funded from" : "Release from pool"}
            error={errors.fundingSource}
          >
            <EnumSelect
              value={v.fundingSource}
              onChange={(s) => {
                set("fundingSource", s);
                set("releaseTo", s);
              }}
              labels={FUNDING_SOURCE_LABELS}
            />
          </Field>
          {mode === "release" ? (
            <Field
              label="Release to"
              error={errors.releaseTo}
              hint={
                crossPool
                  ? "Released into the other pool: this cannot be reversed."
                  : "Same pool as funded (default)."
              }
            >
              <EnumSelect
                value={v.releaseTo}
                onChange={(s) => set("releaseTo", s)}
                labels={FUNDING_SOURCE_LABELS}
              />
            </Field>
          ) : null}
          {mode === "release" && v.kind === "MINIMUM_OPERATING" ? (
            <div className="flex items-center gap-2 sm:col-span-2">
              <Checkbox
                id="reserve-below-min"
                checked={v.allowBelowMinimum}
                onCheckedChange={(c) => set("allowBelowMinimum", c === true)}
              />
              <Label htmlFor="reserve-below-min">
                Allow the minimum operating reserve to fall below its minimum
                (winding up only)
              </Label>
            </div>
          ) : null}
          <Field label="Reason" error={errors.reason} className="sm:col-span-2">
            <Textarea
              value={v.reason}
              onChange={(e) => set("reason", e.target.value)}
            />
          </Field>
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
