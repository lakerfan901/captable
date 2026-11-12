"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { NumericFormat } from "react-number-format";
import { toast } from "sonner";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
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
import { Textarea } from "@/components/ui/textarea";
import {
  deriveReceiptKind,
  prefReturnStartDate,
  validateCashReceipt,
} from "@/lib/admission/commitment-rules";
import {
  formatDateOnly,
  isValidDateOnly,
  todayInTimeZone,
} from "@/lib/date-only";
import { unitsForAmount } from "@/lib/llc/units";
import { useEntity } from "@/providers/entity-provider";
import { trimUnits } from "@/server/llc/serialize";
import { api } from "@/trpc/react";
import type { CommitmentDTO } from "@/trpc/routers/commitment-router/dto";
import type { UnitClassDTO } from "@/trpc/routers/unit-class-router/schema";

const formSchema = z.object({
  receivedOn: z.string().refine(isValidDateOnly, "Enter a date."),
  amountDollars: z.number().positive("The amount must be more than zero."),
  reference: z.string().max(120),
  note: z.string().max(500),
});

type FormValues = z.infer<typeof formSchema>;

function defaultAmountCents(c: CommitmentDTO): number {
  if (c.status === "PENDING") {
    return Math.max(0, c.requiredInitialCents - c.heldCents);
  }
  return c.outstandingBalanceCents;
}

/** What the server will do with this receipt (the server result is authoritative). */
function preview(
  c: CommitmentDTO,
  unitClass: UnitClassDTO | null,
  receivedOn: string,
  amountCents: number,
  today: string,
): { lines: string[]; errors: string[] } {
  if (!isValidDateOnly(receivedOn)) return { lines: [], errors: [] };
  const errors = validateCashReceipt({
    status: c.status,
    acceptedCents: BigInt(c.acceptedCents),
    cashAppliedCents: BigInt(c.cashAppliedCents),
    amountCents: BigInt(amountCents),
    receivedOn,
    today,
  }).map((e) => e.message);
  if (c.status === "PENDING") {
    return { lines: ["Held until the commitment is decided."], errors };
  }
  if (c.status === "REJECTED" || !unitClass || amountCents <= 0) {
    return { lines: [], errors };
  }
  const kind = deriveReceiptKind({
    status: c.status,
    acceptedOn: c.acceptedOn,
    receivedOn,
  });
  const units =
    unitClass.pricePerUnitCents && unitClass.pricePerUnitCents > 0
      ? trimUnits(
          unitsForAmount(
            BigInt(amountCents),
            BigInt(unitClass.pricePerUnitCents),
            unitClass.fractionalUnitsAllowed,
          ),
        )
      : null;
  const start = prefReturnStartDate({
    kind,
    receivedOn,
    dueDate: null,
    terms: unitClass,
  });
  const label = kind === "BALANCE" ? "Balance payment" : "Initial installment";
  const startText =
    start === undefined
      ? "Preferred Return start needs the Balance outside date of the unit class"
      : start === null
        ? "no Preferred Return"
        : `Preferred Return starts ${formatDateOnly(start)}`;
  return {
    lines: [`${label}: ${units ?? "?"} units; ${startText}.`],
    errors,
  };
}

export function RecordReceiptDialog({
  commitment,
  unitClass,
  open,
  onOpenChange,
}: {
  commitment: CommitmentDTO;
  unitClass: UnitClassDTO | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const { timezone } = useEntity();
  const today = todayInTimeZone(timezone);

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      receivedOn: today,
      amountDollars: defaultAmountCents(commitment) / 100,
      reference: "",
      note: "",
    },
  });

  useEffect(() => {
    if (open) {
      form.reset({
        receivedOn: today,
        amountDollars: defaultAmountCents(commitment) / 100,
        reference: "",
        note: "",
      });
    }
  }, [open, commitment, today, form]);

  const { mutateAsync, isPending } = api.commitment.recordReceipt.useMutation({
    onSuccess: () => {
      toast.success("Receipt recorded.");
      onOpenChange(false);
      router.refresh();
    },
    onError: (error) => {
      toast.error(error.message);
    },
  });

  const receivedOn = form.watch("receivedOn");
  const amountDollars = form.watch("amountDollars");
  const amountCents = Number.isFinite(amountDollars)
    ? Math.round(amountDollars * 100)
    : 0;
  const { lines, errors } = preview(
    commitment,
    unitClass,
    receivedOn,
    amountCents,
    today,
  );

  async function onSubmit(values: FormValues) {
    await mutateAsync({
      commitmentId: commitment.id,
      receivedOn: values.receivedOn,
      amountCents: Math.round(values.amountDollars * 100),
      reference: values.reference.trim() || undefined,
      note: values.note.trim() || undefined,
    }).catch(() => undefined);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Record receipt</DialogTitle>
          <DialogDescription>
            Money received from {commitment.stakeholderName}.
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form
            onSubmit={form.handleSubmit(onSubmit)}
            className="flex flex-col gap-4"
          >
            <FormField
              control={form.control}
              name="receivedOn"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Date received</FormLabel>
                  <FormControl>
                    <Input type="date" max={today} {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="amountDollars"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Amount</FormLabel>
                  <FormControl>
                    <NumericFormat
                      customInput={Input}
                      thousandSeparator
                      decimalScale={2}
                      allowNegative={false}
                      prefix="$"
                      value={field.value}
                      onValueChange={(v) => field.onChange(v.floatValue ?? 0)}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="reference"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Wire reference</FormLabel>
                  <FormControl>
                    <Input {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="note"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Note</FormLabel>
                  <FormControl>
                    <Textarea {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            {lines.map((line) => (
              <p key={line} className="text-sm text-muted-foreground">
                {line}
              </p>
            ))}
            {errors.map((message) => (
              <p key={message} className="text-sm text-red-600">
                {message}
              </p>
            ))}
            <DialogFooter>
              <Button
                type="submit"
                loading={isPending}
                disabled={errors.length > 0}
              >
                Record receipt
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
