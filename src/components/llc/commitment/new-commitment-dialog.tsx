"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { NumericFormat } from "react-number-format";
import { toast } from "sonner";
import { z } from "zod";
import { ACCREDITATION_LABELS } from "@/components/llc/member/member-profile-card";
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
import { formatCents } from "@/lib/money";
import { api } from "@/trpc/react";
import { ZAccreditationBasis } from "@/trpc/routers/commitment-router/schema";
import type { UnitClassDTO } from "@/trpc/routers/unit-class-router/schema";

const NONE = "none";

const formSchema = z.object({
  stakeholderId: z.string().min(1, "Choose a member."),
  amountDollars: z.number().positive("The amount must be more than zero."),
  signedOn: z.string(),
  investmentSummaryDate: z.string(),
  accreditationBasis: z.union([ZAccreditationBasis, z.literal(NONE)]),
  notes: z.string().max(2000),
});

type FormValues = z.infer<typeof formSchema>;

const EMPTY: FormValues = {
  stakeholderId: "",
  amountDollars: 0,
  signedOn: "",
  investmentSummaryDate: "",
  accreditationBasis: NONE,
  notes: "",
};

export function NewCommitmentDialog({
  trigger,
  stakeholders,
  unitClass,
  acceptedTotalCents,
}: {
  trigger: React.ReactNode;
  stakeholders: { id: string; name: string }[];
  /** The PREFERRED class, for the minimum and cap hints. */
  unitClass: UnitClassDTO | null;
  /** Σ acceptedCents of ACCEPTED/REDUCED commitments of the class. */
  acceptedTotalCents: number;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: EMPTY,
  });

  const { mutateAsync, isPending } = api.commitment.create.useMutation({
    onSuccess: () => {
      toast.success("Commitment created.");
      setOpen(false);
      form.reset(EMPTY);
      router.refresh();
    },
    onError: (error) => {
      toast.error(error.message);
    },
  });

  async function onSubmit(values: FormValues) {
    await mutateAsync({
      stakeholderId: values.stakeholderId,
      committedCents: Math.round(values.amountDollars * 100),
      signedOn: values.signedOn || undefined,
      investmentSummaryDate: values.investmentSummaryDate || undefined,
      accreditationBasis:
        values.accreditationBasis === NONE
          ? undefined
          : values.accreditationBasis,
      notes: values.notes.trim() || undefined,
    }).catch(() => undefined);
  }

  const hints: string[] = [];
  if (
    unitClass?.minCommitmentCents != null &&
    unitClass.minCommitmentFloorCents != null
  ) {
    hints.push(
      `Minimum ${formatCents(unitClass.minCommitmentCents)} (waivable to ${formatCents(unitClass.minCommitmentFloorCents)})`,
    );
  }
  if (unitClass?.offeringCapCents != null) {
    hints.push(
      `Remaining under the cap: ${formatCents(Math.max(0, unitClass.offeringCapCents - acceptedTotalCents))}`,
    );
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New commitment</DialogTitle>
          <DialogDescription>
            A subscription for {unitClass?.name ?? "Preferred Units"}.
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form
            onSubmit={form.handleSubmit(onSubmit)}
            className="flex flex-col gap-4"
          >
            <FormField
              control={form.control}
              name="stakeholderId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Member</FormLabel>
                  <Select value={field.value} onValueChange={field.onChange}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="Choose a member" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {stakeholders.map((s) => (
                        <SelectItem key={s.id} value={s.id}>
                          {s.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="amountDollars"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Amount committed</FormLabel>
                  <FormControl>
                    <NumericFormat
                      customInput={Input}
                      thousandSeparator
                      decimalScale={2}
                      allowNegative={false}
                      prefix="$"
                      value={field.value || ""}
                      onValueChange={(v) => field.onChange(v.floatValue ?? 0)}
                    />
                  </FormControl>
                  {hints.map((hint) => (
                    <p key={hint} className="text-xs text-muted-foreground">
                      {hint}
                    </p>
                  ))}
                  <FormMessage />
                </FormItem>
              )}
            />
            <div className="grid grid-cols-2 gap-4">
              <FormField
                control={form.control}
                name="signedOn"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Signature date</FormLabel>
                    <FormControl>
                      <Input type="date" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="investmentSummaryDate"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Investment Summary date</FormLabel>
                    <FormControl>
                      <Input type="date" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            <FormField
              control={form.control}
              name="accreditationBasis"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Accreditation basis</FormLabel>
                  <Select value={field.value} onValueChange={field.onChange}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value={NONE}>Not given</SelectItem>
                      {ZAccreditationBasis.options.map((basis) => (
                        <SelectItem key={basis} value={basis}>
                          {ACCREDITATION_LABELS[basis]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="notes"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Notes</FormLabel>
                  <FormControl>
                    <Textarea {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <DialogFooter>
              <Button type="submit" loading={isPending}>
                Create commitment
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
