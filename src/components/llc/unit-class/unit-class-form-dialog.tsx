"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { type Control, useForm } from "react-hook-form";
import { NumericFormat } from "react-number-format";
import { toast } from "sonner";
import { z } from "zod";
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
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/trpc/react";
import type { UnitClassDTO } from "@/trpc/routers/unit-class-router/schema";

const UNITS_RE = /^\d+(\.\d{1,6})?$/;

const formSchema = z.object({
  name: z.string().trim().min(1).max(60),
  priceDollars: z.number().nullable(),
  authorizedUnits: z
    .string()
    .refine((s) => s === "" || UNITS_RE.test(s), "Up to 6 decimals"),
  fractionalUnitsAllowed: z.boolean(),
  votesPerUnit: z.string().regex(UNITS_RE, "Up to 6 decimals"),
  prefReturnPct: z.number().min(0).max(100),
  balanceReturnStartRule: z.enum(["LATER_OF_RECEIPT_AND_DUE", "RECEIPT_DATE"]),
  residualSplitPct: z.number().min(0).max(100),
  minDollars: z.number().nullable(),
  floorDollars: z.number().nullable(),
  capDollars: z.number().nullable(),
  initialInstallmentPct: z.number().min(0.01).max(100),
  finalClosingDate: z.string(),
  balanceOutsideDate: z.string(),
  acceptanceBusinessDays: z.number().int().min(1).max(60),
  refundBusinessDays: z.number().int().min(1).max(60),
  confirmAmendment: z.boolean(),
  amendmentReason: z.string(),
});

type FormValues = z.infer<typeof formSchema>;

const centsToDollars = (c: number | null) => (c === null ? null : c / 100);
const dollarsToCents = (d: number | null) =>
  d === null ? null : Math.round(d * 100);
const pctToBps = (p: number) => Math.round(p * 100);

function MoneyField({
  control,
  name,
  label,
  disabled,
}: {
  control: Control<FormValues>;
  name: "priceDollars" | "minDollars" | "floorDollars" | "capDollars";
  label: string;
  disabled: boolean;
}) {
  return (
    <FormField
      control={control}
      name={name}
      render={({ field }) => (
        <FormItem>
          <FormLabel>{label}</FormLabel>
          <FormControl>
            <NumericFormat
              customInput={Input}
              thousandSeparator
              decimalScale={2}
              prefix="$"
              disabled={disabled}
              value={field.value ?? ""}
              onValueChange={(v) => field.onChange(v.floatValue ?? null)}
            />
          </FormControl>
          <FormMessage />
        </FormItem>
      )}
    />
  );
}

function PercentField({
  control,
  name,
  label,
  disabled,
}: {
  control: Control<FormValues>;
  name: "prefReturnPct" | "residualSplitPct" | "initialInstallmentPct";
  label: string;
  disabled: boolean;
}) {
  return (
    <FormField
      control={control}
      name={name}
      render={({ field }) => (
        <FormItem>
          <FormLabel>{label}</FormLabel>
          <FormControl>
            <NumericFormat
              customInput={Input}
              decimalScale={2}
              suffix="%"
              disabled={disabled}
              value={field.value}
              onValueChange={(v) => field.onChange(v.floatValue ?? 0)}
            />
          </FormControl>
          <FormMessage />
        </FormItem>
      )}
    />
  );
}

function TextField({
  control,
  name,
  label,
  disabled,
  type = "text",
}: {
  control: Control<FormValues>;
  name:
    | "name"
    | "authorizedUnits"
    | "votesPerUnit"
    | "finalClosingDate"
    | "balanceOutsideDate";
  label: string;
  disabled: boolean;
  type?: "text" | "date";
}) {
  return (
    <FormField
      control={control}
      name={name}
      render={({ field }) => (
        <FormItem>
          <FormLabel>{label}</FormLabel>
          <FormControl>
            <Input type={type} disabled={disabled} {...field} />
          </FormControl>
          <FormMessage />
        </FormItem>
      )}
    />
  );
}

function DaysField({
  control,
  name,
  label,
}: {
  control: Control<FormValues>;
  name: "acceptanceBusinessDays" | "refundBusinessDays";
  label: string;
}) {
  return (
    <FormField
      control={control}
      name={name}
      render={({ field }) => (
        <FormItem>
          <FormLabel>{label}</FormLabel>
          <FormControl>
            <NumericFormat
              customInput={Input}
              decimalScale={0}
              allowNegative={false}
              value={field.value}
              onValueChange={(v) => field.onChange(v.floatValue ?? 0)}
            />
          </FormControl>
          <FormMessage />
        </FormItem>
      )}
    />
  );
}

export function UnitClassFormDialog({
  unitClass,
}: {
  unitClass: UnitClassDTO;
}) {
  const c = unitClass;
  const isPreferred = c.kind === "PREFERRED";
  const [open, setOpen] = useState(false);
  const router = useRouter();

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      name: c.name,
      priceDollars: centsToDollars(c.pricePerUnitCents),
      authorizedUnits: c.authorizedUnits ?? "",
      fractionalUnitsAllowed: c.fractionalUnitsAllowed,
      votesPerUnit: c.votesPerUnit,
      prefReturnPct: c.prefReturnBps / 100,
      balanceReturnStartRule: c.balanceReturnStartRule,
      residualSplitPct: c.residualSplitBps / 100,
      minDollars: centsToDollars(c.minCommitmentCents),
      floorDollars: centsToDollars(c.minCommitmentFloorCents),
      capDollars: centsToDollars(c.offeringCapCents),
      initialInstallmentPct: c.initialInstallmentBps / 100,
      finalClosingDate: c.finalClosingDate ?? "",
      balanceOutsideDate: c.balanceOutsideDate ?? "",
      acceptanceBusinessDays: c.acceptanceBusinessDays,
      refundBusinessDays: c.refundBusinessDays,
      confirmAmendment: false,
      amendmentReason: "",
    },
  });

  const confirmAmendment = form.watch("confirmAmendment");
  const lockedDisabled = c.termsLocked && !confirmAmendment;

  const { mutateAsync, isPending } = api.unitClass.update.useMutation({
    onSuccess: () => {
      toast.success("Unit class updated.");
      setOpen(false);
      router.refresh();
    },
    onError: (error) => {
      toast.error(error.message);
    },
  });

  const onSubmit = async (v: FormValues) => {
    await mutateAsync({
      id: c.id,
      name: v.name,
      pricePerUnitCents: isPreferred ? dollarsToCents(v.priceDollars) : null,
      authorizedUnits: v.authorizedUnits === "" ? null : v.authorizedUnits,
      fractionalUnitsAllowed: v.fractionalUnitsAllowed,
      votesPerUnit: v.votesPerUnit,
      prefReturnBps: pctToBps(v.prefReturnPct),
      balanceReturnStartRule: v.balanceReturnStartRule,
      residualSplitBps: pctToBps(v.residualSplitPct),
      minCommitmentCents: isPreferred ? dollarsToCents(v.minDollars) : null,
      minCommitmentFloorCents: isPreferred
        ? dollarsToCents(v.floorDollars)
        : null,
      offeringCapCents: isPreferred ? dollarsToCents(v.capDollars) : null,
      initialInstallmentBps: pctToBps(v.initialInstallmentPct),
      finalClosingDate:
        isPreferred && v.finalClosingDate !== "" ? v.finalClosingDate : null,
      balanceOutsideDate:
        isPreferred && v.balanceOutsideDate !== ""
          ? v.balanceOutsideDate
          : null,
      acceptanceBusinessDays: v.acceptanceBusinessDays,
      refundBusinessDays: v.refundBusinessDays,
      confirmAmendment: v.confirmAmendment,
      amendmentReason: v.confirmAmendment ? v.amendmentReason : undefined,
    });
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          Edit
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Edit {c.name}</DialogTitle>
          <DialogDescription>
            {c.termsLocked
              ? "Units have been issued in this class. Terms fixed by the Operating Agreement can only change through an approved amendment."
              : "Offering terms for this class."}
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form
            onSubmit={form.handleSubmit(onSubmit)}
            className="flex flex-col gap-4"
          >
            <TextField
              control={form.control}
              name="name"
              label="Name"
              disabled={false}
            />

            {c.termsLocked && (
              <FormField
                control={form.control}
                name="confirmAmendment"
                render={({ field }) => (
                  <FormItem className="flex items-center gap-2 space-y-0">
                    <FormControl>
                      <Checkbox
                        checked={field.value}
                        onCheckedChange={(v) => field.onChange(v === true)}
                      />
                    </FormControl>
                    <FormLabel>
                      This change implements an approved amendment
                    </FormLabel>
                  </FormItem>
                )}
              />
            )}
            {c.termsLocked && confirmAmendment && (
              <FormField
                control={form.control}
                name="amendmentReason"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Amendment reason</FormLabel>
                    <FormControl>
                      <Textarea {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            )}

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              {isPreferred && (
                <MoneyField
                  control={form.control}
                  name="priceDollars"
                  label="Price per unit"
                  disabled={lockedDisabled}
                />
              )}
              <TextField
                control={form.control}
                name="authorizedUnits"
                label={
                  isPreferred
                    ? "Authorized units (empty = limited by cap)"
                    : "Authorized units"
                }
                disabled={lockedDisabled}
              />
              <TextField
                control={form.control}
                name="votesPerUnit"
                label="Votes per unit"
                disabled={lockedDisabled}
              />
              <FormField
                control={form.control}
                name="fractionalUnitsAllowed"
                render={({ field }) => (
                  <FormItem className="flex items-center gap-2 space-y-0 pt-8">
                    <FormControl>
                      <Checkbox
                        checked={field.value}
                        disabled={lockedDisabled}
                        onCheckedChange={(v) => field.onChange(v === true)}
                      />
                    </FormControl>
                    <FormLabel>Fractional units allowed</FormLabel>
                  </FormItem>
                )}
              />
              <PercentField
                control={form.control}
                name="prefReturnPct"
                label="Preferred Return rate"
                disabled={lockedDisabled}
              />
              <FormField
                control={form.control}
                name="balanceReturnStartRule"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Balance return start</FormLabel>
                    <Select
                      value={field.value}
                      onValueChange={field.onChange}
                      disabled={lockedDisabled}
                    >
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="LATER_OF_RECEIPT_AND_DUE">
                          Later of receipt and due date
                        </SelectItem>
                        <SelectItem value="RECEIPT_DATE">
                          Receipt date
                        </SelectItem>
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <PercentField
                control={form.control}
                name="residualSplitPct"
                label="Residual split"
                disabled={lockedDisabled}
              />
              {isPreferred && (
                <>
                  <MoneyField
                    control={form.control}
                    name="minDollars"
                    label="Minimum commitment"
                    disabled={lockedDisabled}
                  />
                  <MoneyField
                    control={form.control}
                    name="floorDollars"
                    label="Minimum waiver floor"
                    disabled={lockedDisabled}
                  />
                  <MoneyField
                    control={form.control}
                    name="capDollars"
                    label="Offering cap"
                    disabled={lockedDisabled}
                  />
                  <PercentField
                    control={form.control}
                    name="initialInstallmentPct"
                    label="Initial installment"
                    disabled={lockedDisabled}
                  />
                  <TextField
                    control={form.control}
                    name="finalClosingDate"
                    label="Final Closing Date"
                    type="date"
                    disabled={lockedDisabled}
                  />
                  <TextField
                    control={form.control}
                    name="balanceOutsideDate"
                    label="Balance outside date"
                    type="date"
                    disabled={lockedDisabled}
                  />
                  <DaysField
                    control={form.control}
                    name="acceptanceBusinessDays"
                    label="Acceptance window (business days)"
                  />
                  <DaysField
                    control={form.control}
                    name="refundBusinessDays"
                    label="Refund window (business days)"
                  />
                </>
              )}
            </div>

            <DialogFooter>
              <Button type="submit" loading={isPending}>
                Save
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
