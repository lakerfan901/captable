"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatVoteBps, type VoteBasis } from "@/lib/llc/voting";
import { api } from "@/trpc/react";
import type { RouterOutputs } from "@/trpc/shared";

// Live tally against the frozen thresholds (03-governance.md G11). One card
// per requirement. Percentages are DISPLAY ONLY and always truncated: the
// Approved / Pending chip comes from the server's requirement `state`, never
// from comparing a percentage with a threshold.

export type ResolutionGetOutput = RouterOutputs["resolution"]["get"];
export type RequirementView = ResolutionGetOutput["requirements"][number];

/** Threshold of each basis in percent (where the bar's marker sits). */
export const BASIS_THRESHOLD: Record<VoteBasis, number> = {
  PREFERRED_MAJORITY: 50,
  PREFERRED_SUPERMAJORITY: 70,
  DISINTERESTED_MAJORITY: 50,
  DISINTERESTED_67: 67,
  DISINTERESTED_70: 70,
};

const BASIS_WORDING: Record<VoteBasis, string> = {
  PREFERRED_MAJORITY: "more than 50%",
  PREFERRED_SUPERMAJORITY: "at least 70%",
  DISINTERESTED_MAJORITY: "more than 50%",
  DISINTERESTED_67: "at least 67%",
  DISINTERESTED_70: "at least 70%",
};

/**
 * Basis points (already floored by `tallyBasis`) as a percentage with two
 * decimals, by integer arithmetic so it can never round up: 6666 -> "66.66".
 */
export function formatBps(bps: number): string {
  return formatVoteBps(bps);
}

/** A 6-decimal units string with thousands separators: "1050.000000" -> "1,050.000000". */
export function formatUnits(units: string | null | undefined): string {
  if (units === null || units === undefined || units === "") return "—";
  const negative = units.startsWith("-");
  const body = negative ? units.slice(1) : units;
  const [int = "0", frac] = body.split(".");
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}${grouped}${frac !== undefined ? `.${frac}` : ""}`;
}

/** An instant as date and time with the zone abbreviation ("Dec 13, 2026, 11:59 PM MST"). */
export function formatInstant(
  at: Date | string | null | undefined,
  timeZone: string,
): string {
  if (at === null || at === undefined) return "—";
  const d = typeof at === "string" ? new Date(at) : at;
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    dateStyle: "medium",
    timeStyle: "short",
  })
    .format(d)
    .concat(" ", zoneAbbreviation(d, timeZone));
}

function zoneAbbreviation(d: Date, timeZone: string): string {
  const part = new Intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: "short",
  })
    .formatToParts(d)
    .find((p) => p.type === "timeZoneName");
  return part?.value ?? timeZone;
}

function StateChip({ state }: { state: RequirementView["state"] }) {
  if (state === "PASSED") return <Badge variant="success">Approved</Badge>;
  if (state === "CANNOT_PASS")
    return <Badge variant="destructive">Cannot be reached</Badge>;
  return <Badge variant="warning">Pending</Badge>;
}

function UnitVoteCard({ req }: { req: RequirementView }) {
  const t = req.tally;
  const basis = req.basis as VoteBasis | null;
  const threshold = basis ? BASIS_THRESHOLD[basis] : null;
  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0 pb-2">
        <CardTitle className="text-base">
          {req.label}{" "}
          <span className="text-sm font-normal text-muted-foreground">
            (Section {req.section})
          </span>
        </CardTitle>
        <StateChip state={req.state} />
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {t ? (
          <>
            <div
              className="relative h-3 w-full overflow-hidden rounded bg-muted"
              role="img"
              aria-label={`For ${formatBps(t.forBps)}% against a threshold of ${threshold ?? "?"}%`}
            >
              <div
                className="h-full bg-primary"
                style={{ width: `${Math.min(100, t.forBps / 100)}%` }}
              />
              {threshold !== null ? (
                <div
                  className="absolute top-0 h-full w-0.5 bg-foreground"
                  style={{ left: `${threshold}%` }}
                />
              ) : null}
            </div>
            <p className="tabular-nums">
              For {formatUnits(t.for)} of {formatUnits(t.denominator)} units (
              {formatBps(t.forBps)}%)
            </p>
            <p className="tabular-nums">
              Needs {t.minimumFor === null ? "—" : formatUnits(t.minimumFor)} (
              {basis ? BASIS_WORDING[basis] : "—"})
            </p>
            <p className="tabular-nums text-muted-foreground">
              Against {formatUnits(t.against)} · Abstain{" "}
              {formatUnits(t.abstain)} · No response {formatUnits(t.notVoted)}
            </p>
          </>
        ) : (
          <p className="text-muted-foreground">No tally available.</p>
        )}
      </CardContent>
    </Card>
  );
}

function ApprovalCard({
  req,
  timeZone,
  action,
}: {
  req: RequirementView;
  timeZone: string;
  action: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0 pb-2">
        <CardTitle className="text-base">
          {req.label}{" "}
          <span className="text-sm font-normal text-muted-foreground">
            (Section {req.section})
          </span>
        </CardTitle>
        <StateChip state={req.state} />
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        {req.approvedAt ? (
          <>
            <p>
              Signed by <span className="font-medium">{req.approverName}</span>
              {req.approverCapacity ? `, ${req.approverCapacity}` : ""}
            </p>
            <p className="text-muted-foreground">
              {formatInstant(req.approvedAt, timeZone)}
            </p>
          </>
        ) : (
          <>
            <p className="text-muted-foreground">Pending</p>
            {action}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function CommonMemberSignDialog({
  publicId,
  bodyHash,
  defaultSignerName,
  onDone,
}: {
  publicId: string;
  bodyHash: string;
  defaultSignerName: string;
  onDone: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(defaultSignerName);
  const [capacity, setCapacity] = useState(
    "Authorized signatory of the Common Member",
  );
  const approve = api.resolution.approve.useMutation();
  const valid =
    name.trim().length >= 2 &&
    name.trim().length <= 200 &&
    capacity.trim().length >= 2 &&
    capacity.trim().length <= 200;

  const submit = async () => {
    try {
      await approve.mutateAsync({
        publicId,
        role: "COMMON_MEMBER",
        signerName: name.trim(),
        signerCapacity: capacity.trim(),
        bodyHash,
      });
      toast.success("The Common Member's approval was recorded.");
      setOpen(false);
      onDone();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not sign.");
      onDone();
    }
  };

  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        Sign for the Common Member
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Sign for the Common Member</DialogTitle>
            <DialogDescription>
              By signing, I approve this resolution electronically on behalf of
              the Common Member (Sections 12.1(d), 6.12 and 13.9). The signature
              is final.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="cm-signer-name">Signer name</Label>
              <Input
                id="cm-signer-name"
                value={name}
                maxLength={200}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="cm-signer-capacity">Title / capacity</Label>
              <Input
                id="cm-signer-capacity"
                value={capacity}
                maxLength={200}
                onChange={(e) => setCapacity(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={!valid || approve.isPending}
              onClick={() => void submit()}
            >
              {approve.isPending ? "Signing…" : "Sign"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function TallyPanel({
  publicId,
  status,
  frozenHash,
  requirements,
  memberNames,
  ballotStates,
  timeZone,
  canSign,
  defaultSignerName,
  onChanged,
}: {
  publicId: string;
  status: string;
  frozenHash: string | null;
  requirements: RequirementView[];
  /** stakeholderId -> name (frozen register). */
  memberNames: Record<string, string>;
  /** stakeholderId -> the affected Member's response, for AFFECTED_MEMBER_CONSENT. */
  ballotStates: Record<string, string>;
  timeZone: string;
  canSign: boolean;
  defaultSignerName: string;
  onChanged: () => void;
}) {
  if (requirements.length === 0) return null;
  return (
    <div className="grid gap-4 md:grid-cols-2">
      {requirements.map((req) => {
        const key = req.id ?? `${req.kind}-${req.position}`;
        if (req.kind === "UNIT_VOTE")
          return <UnitVoteCard key={key} req={req} />;
        if (
          req.kind === "MANAGER_APPROVAL" ||
          req.kind === "COMMON_MEMBER_APPROVAL"
        ) {
          const action =
            req.kind === "COMMON_MEMBER_APPROVAL" &&
            status === "SENT" &&
            canSign &&
            frozenHash ? (
              <CommonMemberSignDialog
                publicId={publicId}
                bodyHash={frozenHash}
                defaultSignerName={defaultSignerName}
                onDone={onChanged}
              />
            ) : null;
          return (
            <ApprovalCard
              key={key}
              req={req}
              timeZone={timeZone}
              action={action}
            />
          );
        }
        // AFFECTED_MEMBER_CONSENT
        const sid = req.stakeholderId ?? "";
        return (
          <Card key={key}>
            <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0 pb-2">
              <CardTitle className="text-base">
                {req.label}{" "}
                <span className="text-sm font-normal text-muted-foreground">
                  (Section {req.section})
                </span>
              </CardTitle>
              <StateChip state={req.state} />
            </CardHeader>
            <CardContent className="text-sm">
              <p>
                <span className="font-medium">
                  {memberNames[sid] ?? "Unknown Member"}
                </span>
                : {ballotStates[sid] ?? "No response"}
              </p>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
