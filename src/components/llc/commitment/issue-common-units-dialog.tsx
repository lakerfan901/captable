"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";
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
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { isValidDateOnly, todayInTimeZone } from "@/lib/date-only";
import {
  microUnitsFromDecimal,
  microUnitsToDecimalString,
} from "@/lib/llc/money";
import { useEntity } from "@/providers/entity-provider";
import { trimUnits } from "@/server/llc/serialize";
import { api } from "@/trpc/react";
import type { UnitClassDTO } from "@/trpc/routers/unit-class-router/schema";

const UNITS_RE = /^\d+(\.\d{1,6})?$/;

/** Authorized − issued as a trimmed decimal; null when nothing is authorized. */
function remainingUnits(unitClass: UnitClassDTO | null): string | null {
  if (!unitClass?.authorizedUnits) return null;
  const left =
    microUnitsFromDecimal(unitClass.authorizedUnits) -
    microUnitsFromDecimal(unitClass.issuedUnits);
  return trimUnits(microUnitsToDecimalString(left > 0n ? left : 0n));
}

export function IssueCommonUnitsDialog({
  trigger,
  stakeholders,
  unitClass,
}: {
  trigger: React.ReactNode;
  stakeholders: { id: string; name: string }[];
  /** The COMMON class; null when missing. */
  unitClass: UnitClassDTO | null;
}) {
  const router = useRouter();
  const { timezone } = useEntity();
  const today = todayInTimeZone(timezone);
  const remaining = remainingUnits(unitClass);
  const [open, setOpen] = useState(false);
  const [stakeholderId, setStakeholderId] = useState("");
  const [units, setUnits] = useState(remaining ?? "");
  const [issuedOn, setIssuedOn] = useState(today);

  useEffect(() => {
    if (open) {
      setStakeholderId("");
      setUnits(remaining ?? "");
      setIssuedOn(today);
    }
  }, [open, remaining, today]);

  const { mutateAsync, isPending } =
    api.commitment.issueCommonUnits.useMutation({
      onSuccess: () => {
        toast.success("Common units issued.");
        setOpen(false);
        router.refresh();
      },
      onError: (error) => {
        toast.error(error.message);
      },
    });

  const errors: string[] = [];
  if (!unitClass) errors.push("The company has no Common unit class.");
  if (!stakeholderId) errors.push("Choose a member.");
  const trimmed = units.trim();
  if (!UNITS_RE.test(trimmed))
    errors.push("Enter the number of units with at most 6 decimals.");
  else if (microUnitsFromDecimal(trimmed) <= 0n)
    errors.push("The number of units must be more than zero.");
  else if (
    unitClass &&
    !unitClass.fractionalUnitsAllowed &&
    microUnitsFromDecimal(trimmed) % 1_000_000n !== 0n
  )
    errors.push("Common Units must be issued in whole units.");
  if (!isValidDateOnly(issuedOn)) errors.push("Enter the issue date.");
  else if (issuedOn > today)
    errors.push("The issue date cannot be in the future.");

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (errors.length > 0) return;
    await mutateAsync({ stakeholderId, units: trimmed, issuedOn }).catch(
      () => undefined,
    );
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Issue common units</DialogTitle>
          <DialogDescription>
            {remaining === null
              ? "Set the authorized units of the Common class first."
              : `${remaining} ${unitClass?.name ?? "Common Units"} remain authorized.`}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label>Member</Label>
            <Select value={stakeholderId} onValueChange={setStakeholderId}>
              <SelectTrigger>
                <SelectValue placeholder="Choose a member" />
              </SelectTrigger>
              <SelectContent>
                {stakeholders.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="commonUnits">Units</Label>
            <Input
              id="commonUnits"
              inputMode="decimal"
              value={units}
              onChange={(e) => setUnits(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="issuedOn">Issue date</Label>
            <Input
              id="issuedOn"
              type="date"
              max={today}
              value={issuedOn}
              onChange={(e) => setIssuedOn(e.target.value)}
            />
          </div>
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
              Issue units
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
