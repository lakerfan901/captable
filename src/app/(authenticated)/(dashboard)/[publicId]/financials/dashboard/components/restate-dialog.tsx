"use client";

// Restate (04-investor-portal.md 6.3 "Restate dialog", P35): the month
// range, the old and new value of each changed figure, a required reason,
// then a confirmation naming the months and saying investors will see a
// "Restated" note. Server refusals are shown in the dialog.

import { useMemo, useState } from "react";
import { toast } from "sonner";
import {
  type DriftEntry,
  defaultRange,
  driftInRange,
  holdersSentence,
  monthLabel,
  rangeLabel,
  rangeOptions,
  rangeProblem,
  restateConfirmSentence,
  restateResultText,
  restateRows,
} from "@/components/financials/team-dashboard-model";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  RESTATE_REASON_MAX_LENGTH,
  RESTATE_REASON_MIN_LENGTH,
} from "@/lib/llc/financial-dashboard-core";
import { api } from "@/trpc/react";

function MonthSelect({
  id,
  value,
  options,
  onChange,
}: {
  id: string;
  value: string;
  options: string[];
  onChange: (v: string) => void;
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger id={id} className="w-40">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((m) => (
          <SelectItem key={m} value={m}>
            {monthLabel(m)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function MonthChanges({ entry }: { entry: DriftEntry }) {
  const rows = restateRows(entry);
  const holders = holdersSentence(entry);
  return (
    <div
      className="rounded-md border"
      data-testid={`restate-month-${entry.month}`}
    >
      <div className="border-b bg-muted/50 px-3 py-2 text-sm font-medium">
        {monthLabel(entry.month)}
        {entry.published === null ? (
          <span className="ml-2 font-normal text-muted-foreground">
            (not published before)
          </span>
        ) : null}
      </div>
      {rows.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-muted-foreground">
                <th className="px-3 py-1.5 font-medium">Figure</th>
                <th className="px-3 py-1.5 text-right font-medium">
                  Investors see now
                </th>
                <th className="px-3 py-1.5 text-right font-medium">
                  After restating
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.field} className="border-t">
                  <td className="px-3 py-1.5">{r.label}</td>
                  <td className="whitespace-nowrap px-3 py-1.5 text-right tabular-nums">
                    {r.before}
                  </td>
                  <td className="whitespace-nowrap px-3 py-1.5 text-right font-medium tabular-nums">
                    {r.after}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="px-3 py-2 text-sm text-muted-foreground">
          The fund figures are unchanged.
        </p>
      )}
      {holders ? (
        <p className="border-t px-3 py-2 text-sm text-muted-foreground">
          {holders}
        </p>
      ) : null}
    </div>
  );
}

export function RestateDialog({
  drift,
  onClose,
}: {
  drift: DriftEntry[];
  onClose: () => void;
}) {
  const initial = defaultRange(drift);
  const options = useMemo(() => rangeOptions(drift), [drift]);
  const [from, setFrom] = useState(initial?.from ?? "");
  const [to, setTo] = useState(initial?.to ?? "");
  const [reason, setReason] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const utils = api.useUtils();
  const restate = api.financialDashboard.restate.useMutation();

  const inRange = driftInRange(drift, from, to);
  const problem =
    from && to ? rangeProblem(from, to, drift) : "No month differs.";
  const trimmed = reason.trim().length;
  const reasonProblem =
    trimmed < RESTATE_REASON_MIN_LENGTH
      ? `Give a reason of at least ${RESTATE_REASON_MIN_LENGTH} characters.`
      : trimmed > RESTATE_REASON_MAX_LENGTH
        ? `The reason must be at most ${RESTATE_REASON_MAX_LENGTH} characters.`
        : null;
  const blocked = problem ?? reasonProblem;
  const months = inRange.map((d) => d.month);

  const submit = async () => {
    setServerError(null);
    try {
      const res = await restate.mutateAsync({
        fromMonth: from,
        toMonth: to,
        reason: reason.trim(),
      });
      toast.success(restateResultText(res));
      await utils.financialDashboard.invalidate();
      onClose();
    } catch (e) {
      setConfirming(false);
      setServerError(
        e instanceof Error && e.message
          ? e.message
          : "The figures could not be restated.",
      );
    }
  };

  return (
    <Dialog open onOpenChange={(o) => (o ? null : onClose())}>
      <DialogContent className="max-h-[90vh] grid-cols-[minmax(0,1fr)] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Restate published months</DialogTitle>
          <DialogDescription>
            Investors will see the new figures and a &lsquo;Restated&rsquo;
            note.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-end gap-3">
            <div className="grid gap-1">
              <Label htmlFor="restate-from">From</Label>
              <MonthSelect
                id="restate-from"
                value={from}
                options={options}
                onChange={setFrom}
              />
            </div>
            <div className="grid gap-1">
              <Label htmlFor="restate-to">To</Label>
              <MonthSelect
                id="restate-to"
                value={to}
                options={options}
                onChange={setTo}
              />
            </div>
          </div>

          {problem ? (
            <p className="text-sm text-red-600">{problem}</p>
          ) : (
            <div className="flex flex-col gap-3">
              {inRange.map((d) => (
                <MonthChanges key={d.month} entry={d} />
              ))}
            </div>
          )}

          <div className="grid gap-1">
            <Label htmlFor="restate-reason">Reason</Label>
            <Textarea
              id="restate-reason"
              value={reason}
              maxLength={RESTATE_REASON_MAX_LENGTH}
              placeholder="For example: a power invoice for March was entered late, after the books were reopened."
              onChange={(e) => setReason(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Kept in the audit log with the old figures. Investors are not
              shown the reason.
            </p>
          </div>

          {serverError ? (
            <Alert variant="destructive" data-testid="restate-error">
              <AlertDescription>{serverError}</AlertDescription>
            </Alert>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={blocked !== null || restate.isPending}
            onClick={() => setConfirming(true)}
          >
            Restate…
          </Button>
        </DialogFooter>

        <AlertDialog open={confirming} onOpenChange={setConfirming}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                Restate {from && to ? rangeLabel(from, to) : ""}?
              </AlertDialogTitle>
              <AlertDialogDescription>
                {restateConfirmSentence(months)}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={restate.isPending}>
                Back
              </AlertDialogCancel>
              <AlertDialogAction
                disabled={restate.isPending}
                onClick={(e) => {
                  e.preventDefault();
                  void submit();
                }}
              >
                {months.length === 1
                  ? "Restate 1 month"
                  : `Restate ${months.length} months`}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </DialogContent>
    </Dialog>
  );
}
