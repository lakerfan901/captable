"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { api } from "@/trpc/react";

type EntitySettingsProps = {
  entityType: "CORPORATION" | "LLC";
  timezone: string;
};

export function EntitySettings({ entityType, timezone }: EntitySettingsProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [zone, setZone] = useState(timezone);
  const isLlc = entityType === "LLC";
  const target = isLlc ? "CORPORATION" : "LLC";

  const timeZones = useMemo(() => {
    const zones = Intl.supportedValuesOf("timeZone");
    return zones.includes(timezone) ? zones : [timezone, ...zones];
  }, [timezone]);

  const setEntityType = api.company.setEntityType.useMutation({
    onSuccess: () => {
      setOpen(false);
      toast.success(
        target === "LLC"
          ? "The company is now an LLC."
          : "The company is now a corporation.",
      );
      router.refresh();
    },
    onError: (error) => {
      setOpen(false);
      toast.error(error.message);
    },
  });

  const setTimezone = api.company.setTimezone.useMutation({
    onSuccess: () => {
      toast.success("Time zone saved.");
      router.refresh();
    },
    onError: (error) => toast.error(error.message),
  });

  return (
    <div className="space-y-8">
      <section className="space-y-2">
        <h3 className="text-lg font-medium">Entity type</h3>
        <p className="text-sm text-muted-foreground">
          This company is set up as{" "}
          <span className="font-semibold">
            {isLlc ? "an LLC" : "a corporation"}
          </span>
          .
        </p>

        <AlertDialog open={open} onOpenChange={setOpen}>
          <AlertDialogTrigger asChild>
            <Button variant="outline">
              {isLlc ? "Switch to corporation" : "Switch to LLC"}
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {isLlc ? "Switch to corporation?" : "Switch to LLC?"}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {isLlc
                  ? "A company can switch back to a corporation only while it has no LLC commitments. Unit classes are kept; nothing is deleted."
                  : "A company can switch to LLC only while it has no shares, options, SAFEs, convertible notes or investments. Preferred and Common unit classes are created if missing; nothing is deleted. Cap-table pages are hidden for LLC companies."}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={setEntityType.isPending}>
                Cancel
              </AlertDialogCancel>
              <Button
                loading={setEntityType.isPending}
                disabled={setEntityType.isPending}
                onClick={() => setEntityType.mutate({ entityType: target })}
              >
                {isLlc ? "Switch to corporation" : "Switch to LLC"}
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </section>

      <section className="space-y-2">
        <h3 className="text-lg font-medium">Time zone</h3>
        <p className="text-sm text-muted-foreground">
          Used to decide what &quot;today&quot; is for dates and deadlines.
        </p>
        <div className="flex items-center gap-2">
          <Select value={zone} onValueChange={setZone}>
            <SelectTrigger className="w-80">
              <SelectValue placeholder="Select a time zone" />
            </SelectTrigger>
            <SelectContent>
              {timeZones.map((tz) => (
                <SelectItem key={tz} value={tz}>
                  {tz}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            loading={setTimezone.isPending}
            disabled={setTimezone.isPending || zone === timezone}
            onClick={() => setTimezone.mutate({ timezone: zone })}
          >
            Save
          </Button>
        </div>
      </section>
    </div>
  );
}
