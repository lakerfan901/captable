"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { IsoDateText, Money } from "@/components/llc/money";
import { MoneyInput } from "@/components/llc/money-input";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { roundDiv } from "@/lib/llc/money";
import { api } from "@/trpc/react";
import type { RouterOutputs } from "@/trpc/shared";

type Eligible = RouterOutputs["callNotice"]["eligible"];

export type DraftInput = {
  id: string;
  purpose: string | null;
  bankAccountId: string | null;
  lines: { commitmentId: string; amountCalled: number }[];
};

type Row = { checked: boolean; cents: number | null };

/** `roundDiv(uncalled × pct, 100)` in integer cents. */
export function percentOf(uncalled: number, pct: number): number {
  return Number(roundDiv(BigInt(uncalled) * BigInt(pct), 100n));
}

export function NoticeForm({
  base,
  eligible,
  draft,
}: {
  base: string;
  eligible: Eligible;
  draft: DraftInput | null;
}) {
  const router = useRouter();
  const primary =
    eligible.bankAccounts.find((a) => a.primary) ?? eligible.bankAccounts[0];
  const [bankAccountId, setBankAccountId] = useState<string | undefined>(
    draft?.bankAccountId ?? primary?.id,
  );
  const [purpose, setPurpose] = useState(draft?.purpose ?? "");
  const [pct, setPct] = useState("50");
  const [error, setError] = useState<string | null>(null);
  const [rows, setRows] = useState<Record<string, Row>>(() => {
    const out: Record<string, Row> = {};
    for (const s of eligible.states) {
      const line = draft?.lines.find((l) => l.commitmentId === s.commitmentId);
      out[s.commitmentId] = line
        ? { checked: true, cents: line.amountCalled }
        : { checked: false, cents: null };
    }
    return out;
  });
  const mutation = api.callNotice.saveDraft.useMutation();

  const callable = eligible.states.filter(
    (s) => s.uncalled > 0 && s.noticeEmail !== null,
  );
  const fill = (percent: number) => {
    setRows((prev) => {
      const next = { ...prev };
      for (const s of callable) {
        const cents = percentOf(s.uncalled, percent);
        next[s.commitmentId] = { checked: cents > 0, cents };
      }
      return next;
    });
  };

  const selected = eligible.states.filter((s) => rows[s.commitmentId]?.checked);
  const total = selected.reduce(
    (sum, s) => sum + (rows[s.commitmentId]?.cents ?? 0),
    0,
  );

  const save = async () => {
    setError(null);
    if (!bankAccountId) {
      setError("Choose the bank account whose wire instructions are printed.");
      return;
    }
    if (selected.length === 0) {
      setError("Select at least one member.");
      return;
    }
    for (const s of selected) {
      const cents = rows[s.commitmentId]?.cents ?? 0;
      if (cents <= 0 || cents > s.uncalled) {
        setError(
          `${s.name}: the amount must be more than $0 and not more than the uncalled Balance.`,
        );
        return;
      }
    }
    try {
      const r = await mutation.mutateAsync({
        id: draft?.id,
        purpose: purpose.trim() === "" ? undefined : purpose.trim(),
        bankAccountId,
        lines: selected.map((s) => ({
          commitmentId: s.commitmentId,
          amountCalledCents: rows[s.commitmentId]?.cents ?? 0,
        })),
      });
      toast.success(`Draft Call Notice No. ${r.number} saved.`);
      router.push(`${base}/${r.id}`);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 md:grid-cols-2">
        <div className="grid gap-1.5">
          <Label>Bank account (wire instructions)</Label>
          {eligible.bankAccounts.length === 0 ? (
            <p className="text-sm text-destructive">
              Add a bank account under Settings first.
            </p>
          ) : (
            <Select value={bankAccountId} onValueChange={setBankAccountId}>
              <SelectTrigger>
                <SelectValue placeholder="Select" />
              </SelectTrigger>
              <SelectContent>
                {eligible.bankAccounts.map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.bankName} ••••{a.last4}
                    {a.primary ? " (primary)" : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="cn-purpose">Purpose (printed in the notice)</Label>
          <Textarea
            id="cn-purpose"
            value={purpose}
            onChange={(e) => setPurpose(e.target.value)}
          />
        </div>
      </div>

      <div className="flex flex-wrap items-end gap-2">
        <Button variant="outline" onClick={() => fill(100)}>
          Call 100% of uncalled Balance
        </Button>
        <div className="flex items-end gap-2">
          <div className="grid gap-1">
            <Label htmlFor="cn-pct">N%</Label>
            <Input
              id="cn-pct"
              className="w-20"
              inputMode="numeric"
              value={pct}
              onChange={(e) => setPct(e.target.value.replace(/\D/g, ""))}
            />
          </div>
          <Button
            variant="outline"
            onClick={() => {
              const n = Number(pct);
              if (Number.isInteger(n) && n >= 1 && n <= 100) fill(n);
              else setError("N must be a whole number from 1 to 100.");
            }}
          >
            Call {pct || "N"}% of each uncalled Balance
          </Button>
        </div>
      </div>

      <p className="text-sm">
        {eligible.proposedDueOn ? (
          <>
            If sent today the due date is{" "}
            <strong>
              <IsoDateText date={eligible.proposedDueOn} />
            </strong>
            .
          </>
        ) : (
          <span className="text-destructive">
            The Balance outside date has passed; Call Notices can no longer be
            sent.
          </span>
        )}
      </p>

      <Card>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead />
              <TableHead>Member</TableHead>
              <TableHead className="text-right">Committed</TableHead>
              <TableHead className="text-right">Paid</TableHead>
              <TableHead className="text-right">Uncalled Balance</TableHead>
              <TableHead className="text-right">Prepaid</TableHead>
              <TableHead className="w-48">Amount to call</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {eligible.states.map((s) => {
              const row = rows[s.commitmentId] ?? {
                checked: false,
                cents: null,
              };
              const reason =
                s.noticeEmail === null
                  ? "No email address on Exhibit A"
                  : s.uncalled <= 0
                    ? "Nothing left to call"
                    : null;
              const set = (r: Partial<Row>) =>
                setRows((prev) => ({
                  ...prev,
                  [s.commitmentId]: { ...row, ...r },
                }));
              return (
                <TableRow key={s.commitmentId}>
                  <TableCell>
                    <Checkbox
                      checked={row.checked}
                      disabled={reason !== null}
                      onCheckedChange={(c) =>
                        set({
                          checked: c === true,
                          cents: row.cents ?? s.uncalled,
                        })
                      }
                      aria-label={`Call ${s.name}`}
                    />
                  </TableCell>
                  <TableCell>
                    <div className="font-medium">{s.name}</div>
                    {reason ? (
                      <div className="text-xs text-muted-foreground">
                        {reason}
                      </div>
                    ) : null}
                  </TableCell>
                  <TableCell className="text-right">
                    <Money cents={s.acceptedCents} />
                  </TableCell>
                  <TableCell className="text-right">
                    <Money cents={s.totalPaid} />
                  </TableCell>
                  <TableCell className="text-right">
                    <Money cents={s.uncalled} />
                  </TableCell>
                  <TableCell className="text-right">
                    <Money cents={s.prepaidUnallocated} />
                  </TableCell>
                  <TableCell>
                    <MoneyInput
                      aria-label={`Amount called from ${s.name}`}
                      value={row.cents}
                      disabled={reason !== null || !row.checked}
                      onChange={(cents) => set({ cents })}
                    />
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </Card>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm">
          {selected.length} member{selected.length === 1 ? "" : "s"}, total{" "}
          <Money cents={total} />
        </p>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => router.back()}>
            Back
          </Button>
          <Button
            onClick={save}
            loading={mutation.isPending}
            disabled={mutation.isPending}
          >
            Save draft
          </Button>
        </div>
      </div>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
    </div>
  );
}
