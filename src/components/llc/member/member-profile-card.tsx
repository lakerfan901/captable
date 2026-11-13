"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Allow } from "@/components/rbac/allow";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { formatDateOnly } from "@/lib/date-only";
import { api } from "@/trpc/react";
import type { MemberDTO } from "@/trpc/routers/stakeholder-router/member-schema";

export const HOLDER_TYPE_LABELS: Record<
  NonNullable<MemberDTO["holderType"]>,
  string
> = {
  INDIVIDUAL: "Individual",
  JOINT: "Joint",
  TRUST: "Trust",
  ENTITY: "Entity",
};

export const ACCREDITATION_LABELS: Record<
  NonNullable<MemberDTO["accreditationBasis"]>,
  string
> = {
  NET_WORTH: "Net worth over $1,000,000",
  INCOME: "Income over $200,000 / $300,000",
  LICENSE: "Series 7, 65 or 82 license",
  ENTITY_ASSETS: "Entity with assets over $5,000,000",
  ENTITY_ALL_OWNERS_ACCREDITED: "Entity whose owners are all accredited",
  TRUST_ASSETS: "Trust with assets over $5,000,000",
};

export const MEMBER_STATUS_LABELS: Record<MemberDTO["memberStatus"], string> = {
  PROSPECT: "Prospect",
  MEMBER: "Member",
  FINANCIAL_INTEREST_ONLY: "Financial interest only",
};

const STATUS_VARIANTS = {
  PROSPECT: "warning",
  MEMBER: "success",
  FINANCIAL_INTEREST_ONLY: "info",
} as const;

/**
 * `committed`: the holder has a subscription the Manager has not yet accepted.
 * Such a prospect has signed but is not admitted until the Initial Installment
 * is received and the subscription is accepted, so it is shown as "Committed".
 */
export function MemberStatusBadge({
  status,
  committed = false,
}: {
  status: MemberDTO["memberStatus"];
  committed?: boolean;
}) {
  if (status === "PROSPECT" && committed) {
    return <Badge variant="info">Committed</Badge>;
  }
  return (
    <Badge variant={STATUS_VARIANTS[status]}>
      {MEMBER_STATUS_LABELS[status]}
    </Badge>
  );
}

export function InsiderBadge() {
  return <Badge variant="outline">Insider</Badge>;
}

function StatusChangeDialog({ member }: { member: MemberDTO }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const toFinancialInterest = member.memberStatus === "MEMBER";
  const label = toFinancialInterest
    ? "Set as financial interest only"
    : "Restore member rights";

  const mutation = api.stakeholder.setMemberStatus.useMutation({
    onSuccess: () => {
      toast.success("Member status updated.");
      setOpen(false);
      setReason("");
      router.refresh();
    },
    onError: (error) => toast.error(error.message),
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          {label}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{label}</DialogTitle>
          <DialogDescription>
            {toFinancialInterest
              ? "A holder of only a Financial Interest is not a Member: no vote and no information rights (Sections 1.8, 1.11, 7.9.2)."
              : "The holder becomes a Member again, with voting and information rights."}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2">
          <Label htmlFor="status-reason">Reason</Label>
          <Textarea
            id="status-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            At least 5 characters.
          </p>
        </div>
        <DialogFooter>
          <Button
            disabled={reason.trim().length < 5 || mutation.isPending}
            loading={mutation.isPending}
            onClick={() =>
              mutation.mutate({
                id: member.id,
                memberStatus: toFinancialInterest
                  ? "FINANCIAL_INTEREST_ONLY"
                  : "MEMBER",
                reason,
              })
            }
          >
            Confirm
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function MemberProfileCard({ member }: { member: MemberDTO }) {
  const m = member;
  const dash = (v: string | null) => v ?? "—";
  const rows: [string, string][] = [
    ["Name", m.name],
    ["Email", m.email],
    ["Notice email", dash(m.noticeEmail)],
    ["Effective notice email", m.effectiveNoticeEmail],
    ["Holder type", m.holderType ? HOLDER_TYPE_LABELS[m.holderType] : "—"],
    ["State of residence or formation", dash(m.residenceState)],
    [
      "Accreditation basis",
      m.accreditationBasis ? ACCREDITATION_LABELS[m.accreditationBasis] : "—",
    ],
    ["Status", MEMBER_STATUS_LABELS[m.memberStatus]],
    ["Admitted", m.admittedOn ? formatDateOnly(m.admittedOn) : "—"],
    ["Signer name", dash(m.signerName)],
    ["Signer title", dash(m.signerTitle)],
    ["Phone", dash(m.phone)],
    ["Street address", dash(m.streetAddress)],
    ["City", dash(m.city)],
    ["State", dash(m.state)],
    ["ZIP code", dash(m.zipcode)],
    ["Insider", m.isInsider ? "Yes" : "No"],
    ["Created", new Date(m.createdAt).toLocaleDateString("en-US")],
  ];

  return (
    <Card className="p-6">
      <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
        {rows.map(([term, value]) => (
          <div key={term}>
            <dt className="text-xs text-muted-foreground">{term}</dt>
            <dd className="text-sm">{value}</dd>
          </div>
        ))}
      </dl>
      {m.memberStatus !== "PROSPECT" && (
        <Allow subject="stakeholder" action="update">
          <div className="mt-6">
            <StatusChangeDialog member={m} />
          </div>
        </Allow>
      )}
    </Card>
  );
}
