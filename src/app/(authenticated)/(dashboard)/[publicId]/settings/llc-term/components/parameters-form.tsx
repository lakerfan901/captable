"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { IsoDateText, Money } from "@/components/llc/money";
import { MoneyInput } from "@/components/llc/money-input";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { isIsoDate } from "@/lib/llc/dates";
import { api } from "@/trpc/react";
import {
  LOCKED_TERM_FIELDS,
  ZLlcTermUpdateSchema,
} from "@/trpc/routers/llc-term/schema";
import type { RouterOutputs } from "@/trpc/shared";

type TermData = RouterOutputs["llcTerm"]["get"];

const INT_FIELDS = [
  {
    key: "callNoticeBusinessDays",
    label: "Call Notice period (business days)",
    section: "4.9",
  },
  {
    key: "forfeitureCureBusinessDays",
    label: "Cure period before the Forfeiture Date (business days)",
    section: "4.9(iv)",
  },
  {
    key: "creditDateMaxDays",
    label: "Credit Date at the latest (days after the due date)",
    section: "4.9(iv)",
  },
  {
    key: "defaultInterestBps",
    label: "Default interest (basis points a year)",
    section: "4.9(i)",
  },
  {
    key: "defaultInterestDayBasis",
    label: "Default interest day basis (days a year)",
    section: "4.9(i)",
  },
  {
    key: "forfeitureBps",
    label: "Forfeited share of the unpaid Balance (basis points)",
    section: "4.9(iv)",
  },
  {
    key: "replacementCreditBps",
    label:
      "Share of the Forfeited Amount for Replacement Funders (basis points)",
    section: "4.9(iv)",
  },
  {
    key: "managementFeeBps",
    label: "Management Fee (basis points of Gross Revenue)",
    section: "6.18",
  },
  {
    key: "distributionDeadlineDays",
    label: "Distribution and report deadline (days after quarter end)",
    section: "5.6(a), 8.2",
  },
  {
    key: "targetSaleYears",
    label: "Years from the OCD to the Target Sale Date",
    section: "2.4",
  },
  {
    key: "loiExtensionMaxDays",
    label: "Maximum LOI extension (days)",
    section: "2.4",
  },
  {
    key: "extensionRequestMonthsBefore",
    label: "Extension request (months before the Target Sale Date)",
    section: "2.5",
  },
  {
    key: "extensionConsentWindowDays",
    label: "Consent window before deemed against (days)",
    section: "2.5",
  },
  {
    key: "dissolutionElectionDays",
    label: "Dissolution election (days after the Target Sale Date)",
    section: "11.1(d)",
  },
  {
    key: "ocdNoticeBusinessDays",
    label: "OCD notice period (business days)",
    section: "1.21",
  },
] as const;

const formSchema = ZLlcTermUpdateSchema.pick({
  replacementFunderOutsideDate: true,
  callNoticeBusinessDays: true,
  forfeitureCureBusinessDays: true,
  creditDateMaxDays: true,
  defaultInterestBps: true,
  defaultInterestDayBasis: true,
  forfeitureBps: true,
  replacementCreditBps: true,
  managementFeeBps: true,
  minimumOperatingReserveCents: true,
  orgExpenseCapCents: true,
  distributionDeadlineDays: true,
  targetSaleYears: true,
  loiExtensionMaxDays: true,
  extensionRequestMonthsBefore: true,
  extensionConsentWindowDays: true,
  dissolutionElectionDays: true,
  ocdNoticeBusinessDays: true,
  holidayCalendar: true,
  saturdayHolidayObservedFriday: true,
})
  .required()
  .extend({ extraHolidaysText: z.string().max(2000) });
type FormValues = z.infer<typeof formSchema>;

const LOCKED = new Set<string>(LOCKED_TERM_FIELDS);
const LOCKED_NOTE =
  "Locked: a Call Notice, default or distribution exists, and changing it would rewrite history.";

function parseHolidays(text: string): string[] | null {
  const parts = text
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length > 50 || parts.some((p) => !isIsoDate(p))) return null;
  return parts;
}

function ReopenBooksDialog({
  closedThrough,
  canEdit,
}: {
  closedThrough: string;
  canEdit: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [through, setThrough] = useState("");
  const [reason, setReason] = useState("");
  const mutation = api.llcTerm.reopenBooks.useMutation({
    onSuccess: () => {
      toast.success("Books reopened.");
      setOpen(false);
      router.refresh();
    },
    onError: (error) => toast.error(error.message),
  });
  const reasonOk = reason.trim().length >= 10;
  const throughOk = through === "" || isIsoDate(through);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" disabled={!canEdit}>
          Reopen books
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Reopen books</DialogTitle>
          <DialogDescription>
            Books are closed through <IsoDateText date={closedThrough} />. Leave
            the date empty to reopen them completely. A finalized distribution
            for a later period must be reversed first.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="reopen-through">Closed through (optional)</Label>
            <Input
              id="reopen-through"
              type="date"
              value={through}
              onChange={(e) => setThrough(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="reopen-reason">Reason</Label>
            <Textarea
              id="reopen-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="At least 10 characters"
            />
          </div>
        </div>
        <DialogFooter>
          <Button
            disabled={!reasonOk || !throughOk || mutation.isPending}
            loading={mutation.isPending}
            onClick={() =>
              mutation.mutate({
                through: through === "" ? null : through,
                reason: reason.trim(),
              })
            }
          >
            Reopen
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ParametersForm({
  term,
  unitClassTerms,
  unitClassesHref,
  locked,
  canEdit,
}: {
  term: TermData["term"];
  unitClassTerms: TermData["unitClassTerms"];
  unitClassesHref: string;
  locked: boolean;
  canEdit: boolean;
}) {
  const router = useRouter();
  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      replacementFunderOutsideDate: term.replacementFunderOutsideDate,
      callNoticeBusinessDays: term.callNoticeBusinessDays,
      forfeitureCureBusinessDays: term.forfeitureCureBusinessDays,
      creditDateMaxDays: term.creditDateMaxDays,
      defaultInterestBps: term.defaultInterestBps,
      defaultInterestDayBasis: term.defaultInterestDayBasis,
      forfeitureBps: term.forfeitureBps,
      replacementCreditBps: term.replacementCreditBps,
      managementFeeBps: term.managementFeeBps,
      minimumOperatingReserveCents: term.minimumOperatingReserveCents,
      orgExpenseCapCents: term.orgExpenseCapCents,
      distributionDeadlineDays: term.distributionDeadlineDays,
      targetSaleYears: term.targetSaleYears,
      loiExtensionMaxDays: term.loiExtensionMaxDays,
      extensionRequestMonthsBefore: term.extensionRequestMonthsBefore,
      extensionConsentWindowDays: term.extensionConsentWindowDays,
      dissolutionElectionDays: term.dissolutionElectionDays,
      ocdNoticeBusinessDays: term.ocdNoticeBusinessDays,
      holidayCalendar: term.holidayCalendar,
      saturdayHolidayObservedFriday: term.saturdayHolidayObservedFriday,
      extraHolidaysText: term.extraHolidays.join("\n"),
    },
  });
  const mutation = api.llcTerm.update.useMutation({
    onSuccess: () => {
      toast.success("Parameters saved.");
      router.refresh();
    },
    onError: (error) => toast.error(error.message),
  });
  const isLocked = (key: string) => locked && LOCKED.has(key);

  const onSubmit = async ({ extraHolidaysText, ...values }: FormValues) => {
    const extraHolidays = parseHolidays(extraHolidaysText);
    if (extraHolidays === null) {
      form.setError("extraHolidaysText", {
        message: "Enter up to 50 dates as YYYY-MM-DD, one per line.",
      });
      return;
    }
    await mutation.mutateAsync({ ...values, extraHolidays });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">Agreement parameters</CardTitle>
        <CardDescription>
          Defaults follow the Operating Agreement. Offering terms live on the
          Preferred unit class.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Form {...form}>
          <form
            onSubmit={form.handleSubmit(onSubmit)}
            className="flex flex-col gap-8"
          >
            <section className="space-y-4">
              <h4 className="font-medium">Dates</h4>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <FormField
                  control={form.control}
                  name="replacementFunderOutsideDate"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>
                        Replacement Funder units issued by (§4.8(b))
                      </FormLabel>
                      <FormControl>
                        <Input type="date" disabled={!canEdit} {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <div className="space-y-2">
                  <Label>Books closed through</Label>
                  <div className="flex items-center gap-3 text-sm">
                    <IsoDateText date={term.booksClosedThrough} />
                    {term.booksClosedThrough !== null ? (
                      <ReopenBooksDialog
                        closedThrough={term.booksClosedThrough}
                        canEdit={canEdit}
                      />
                    ) : (
                      <span className="text-muted-foreground">(open)</span>
                    )}
                  </div>
                </div>
              </div>
              <div className="rounded-md border p-4 text-sm">
                <div className="mb-2 flex items-center justify-between">
                  <span className="font-medium">
                    Preferred unit class terms (read-only)
                  </span>
                  <Link className="underline" href={unitClassesHref}>
                    Edit on the unit classes page
                  </Link>
                </div>
                {unitClassTerms === null ? (
                  <p className="text-muted-foreground">
                    No Preferred unit class.
                  </p>
                ) : (
                  <dl className="grid grid-cols-1 gap-x-6 gap-y-1 sm:grid-cols-2">
                    <dt className="text-muted-foreground">Price per unit</dt>
                    <dd>
                      <Money cents={unitClassTerms.pricePerUnitCents} />
                    </dd>
                    <dt className="text-muted-foreground">
                      Final Closing Date
                    </dt>
                    <dd>
                      <IsoDateText date={unitClassTerms.finalClosingDate} />
                    </dd>
                    <dt className="text-muted-foreground">
                      Balance outside date (§4.9)
                    </dt>
                    <dd>
                      <IsoDateText date={unitClassTerms.balanceOutsideDate} />
                    </dd>
                    <dt className="text-muted-foreground">
                      Preferred Return (§5.6(b))
                    </dt>
                    <dd>{(unitClassTerms.prefReturnBps / 100).toFixed(2)}%</dd>
                    <dt className="text-muted-foreground">
                      Residual split to Preferred (§5.6(e))
                    </dt>
                    <dd>
                      {(unitClassTerms.residualSplitBps / 100).toFixed(2)}%
                    </dd>
                    <dt className="text-muted-foreground">Fractional units</dt>
                    <dd>
                      {unitClassTerms.fractionalUnitsAllowed ? "Yes" : "No"}
                    </dd>
                    <dt className="text-muted-foreground">
                      Balance return starts
                    </dt>
                    <dd>
                      {unitClassTerms.balanceReturnStartRule === "RECEIPT_DATE"
                        ? "On receipt"
                        : "Later of receipt and due date"}
                    </dd>
                  </dl>
                )}
              </div>
            </section>

            <section className="space-y-4">
              <h4 className="font-medium">Parameters</h4>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                {INT_FIELDS.map((f) => (
                  <FormField
                    key={f.key}
                    control={form.control}
                    name={f.key}
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>
                          {f.label} (§{f.section})
                        </FormLabel>
                        <FormControl>
                          <Input
                            type="number"
                            min={0}
                            step={1}
                            disabled={!canEdit || isLocked(f.key)}
                            name={field.name}
                            ref={field.ref}
                            onBlur={field.onBlur}
                            value={Number.isNaN(field.value) ? "" : field.value}
                            onChange={(e) =>
                              field.onChange(e.target.valueAsNumber)
                            }
                          />
                        </FormControl>
                        {isLocked(f.key) ? (
                          <FormDescription>{LOCKED_NOTE}</FormDescription>
                        ) : null}
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                ))}
                <FormField
                  control={form.control}
                  name="minimumOperatingReserveCents"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Minimum operating reserve (§5.6(a))</FormLabel>
                      <FormControl>
                        <MoneyInput
                          value={field.value}
                          onChange={(cents) => field.onChange(cents ?? 0)}
                          disabled={!canEdit}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="orgExpenseCapCents"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>
                        Organizational and offering expense cap (§6.21)
                      </FormLabel>
                      <FormControl>
                        <MoneyInput
                          value={field.value}
                          onChange={(cents) => field.onChange(cents ?? 0)}
                          disabled={!canEdit}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
            </section>

            <section className="space-y-4">
              <h4 className="font-medium">Calendar</h4>
              <p className="text-sm text-muted-foreground">
                Business days are Monday to Friday except the holidays below.
                The time zone for &quot;today&quot; is the company time zone in
                Settings.
              </p>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <FormField
                  control={form.control}
                  name="holidayCalendar"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Holiday calendar</FormLabel>
                      <Select
                        value={field.value}
                        onValueChange={field.onChange}
                        disabled={!canEdit || isLocked("holidayCalendar")}
                      >
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="US_FEDERAL">
                            US federal holidays (observed dates)
                          </SelectItem>
                          <SelectItem value="NONE">No holidays</SelectItem>
                        </SelectContent>
                      </Select>
                      {isLocked("holidayCalendar") ? (
                        <FormDescription>{LOCKED_NOTE}</FormDescription>
                      ) : null}
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="saturdayHolidayObservedFriday"
                  render={({ field }) => (
                    <FormItem className="flex flex-col gap-2">
                      <FormLabel>
                        Saturday holidays observed on the Friday before
                      </FormLabel>
                      <FormControl>
                        <Switch
                          checked={field.value}
                          onCheckedChange={field.onChange}
                          disabled={
                            !canEdit ||
                            isLocked("saturdayHolidayObservedFriday")
                          }
                        />
                      </FormControl>
                      {isLocked("saturdayHolidayObservedFriday") ? (
                        <FormDescription>{LOCKED_NOTE}</FormDescription>
                      ) : null}
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="extraHolidaysText"
                  render={({ field }) => (
                    <FormItem className="sm:col-span-2">
                      <FormLabel>Extra closures</FormLabel>
                      <FormControl>
                        <Textarea
                          rows={3}
                          placeholder="2026-12-24"
                          disabled={!canEdit}
                          {...field}
                        />
                      </FormControl>
                      <FormDescription>
                        One date per line (YYYY-MM-DD), at most 50.
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
            </section>

            <div>
              <Button
                type="submit"
                disabled={!canEdit || mutation.isPending}
                loading={mutation.isPending}
              >
                Save parameters
              </Button>
            </div>
          </form>
        </Form>
      </CardContent>
    </Card>
  );
}
