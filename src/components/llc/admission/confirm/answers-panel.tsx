"use client";

import { toast } from "sonner";
import {
  ACCREDITATION_LABELS,
  HOLDER_TYPE_LABELS,
} from "@/components/llc/member/member-profile-card";
import { Allow } from "@/components/rbac/allow";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatDateOnly } from "@/lib/date-only";
import { SUBSCRIPTION_FIELD_KEYS } from "@/lib/esign/subscription-fields";
import { api } from "@/trpc/react";
import { useReview } from "./review-context";

// Section 1 of the confirmation screen (F13): the investor's Exhibit B
// answers exactly as signed, next to what the member record holds now, with
// the reader's issues as amber notes.

const dash = (v: string | null | undefined) =>
  v === null || v === undefined || v.trim() === "" ? "—" : v;

/** Signed answer → readable text (SELECT answers are stored as enum names). */
function signedText(key: string, raw: string | undefined): string {
  if (raw === undefined || raw.trim() === "") return "—";
  const def = SUBSCRIPTION_FIELD_KEYS.find((k) => k.key === key);
  const option = def?.options?.find((o) => o.id === raw);
  if (option) return option.value;
  if (def?.type === "DATE" && /^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return formatDateOnly(raw);
  }
  return raw;
}

export function AnswersPanel() {
  const { view, busy, onError, reload } = useReview();
  const { packet, answers, stakeholder: m, commitment } = view;

  const resend = api.admission.resend.useMutation({
    onSuccess: () => {
      toast.success("The signing link was sent again.");
      reload();
    },
    onError,
  });

  if (!answers) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Investor's answers</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 text-sm">
          {packet.stage === "AWAITING_INVESTOR" ? (
            <>
              <p>
                Waiting for the investor to sign (sent to{" "}
                {packet.investorEmail ?? m.effectiveNoticeEmail}).
              </p>
              <Allow subject="commitments" action="update">
                <div>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    loading={resend.isPending}
                    onClick={() => resend.mutate({ publicId: packet.publicId })}
                  >
                    Resend
                  </Button>
                </div>
              </Allow>
            </>
          ) : (
            <p className="text-muted-foreground">
              The investor did not sign this subscription.
            </p>
          )}
        </CardContent>
      </Card>
    );
  }

  const raw = answers.raw;
  const memberAddress = [m.streetAddress, m.city, m.state, m.zipcode]
    .filter((p) => p && p.trim() !== "")
    .join(", ");
  const rows: { label: string; signed: string; record: string }[] = [
    {
      label: "Capital Contribution committed",
      signed: signedText("commitment_amount", raw.commitment_amount),
      record: commitment ? "see the commitment below" : "—",
    },
    {
      label: "Paid with this signature page",
      signed: signedText("amount_paid", raw.amount_paid),
      record: "—",
    },
    {
      label: "Legal name",
      signed: signedText("legal_name", raw.legal_name),
      record: m.name,
    },
    {
      label: "Holder type",
      signed: signedText("holder_type", raw.holder_type),
      record: m.holderType ? HOLDER_TYPE_LABELS[m.holderType] : "—",
    },
    {
      label: "State of residence (or formation)",
      signed: signedText("residence_state", raw.residence_state),
      record: dash(m.residenceState),
    },
    {
      label: "Accredited investor basis",
      signed: signedText("accreditation_basis", raw.accreditation_basis),
      record: m.accreditationBasis
        ? ACCREDITATION_LABELS[m.accreditationBasis]
        : "—",
    },
    {
      label: "Investment Summary date",
      signed: signedText(
        "investment_summary_date",
        raw.investment_summary_date,
      ),
      record: "—",
    },
    {
      label: "Address",
      signed: dash(
        [
          raw.address_street,
          raw.address_city,
          raw.address_state,
          raw.address_zip,
        ]
          .filter((p) => p && p.trim() !== "")
          .join(", "),
      ),
      record: dash(memberAddress),
    },
    {
      label: "Email",
      signed: signedText("email", raw.email),
      record: m.noticeEmail
        ? `${m.email} (notices: ${m.noticeEmail})`
        : m.email,
    },
    {
      label: "Name and title (if entity)",
      signed: signedText("signer_name_title", raw.signer_name_title),
      record: dash(
        [m.signerName, m.signerTitle].filter((p) => p?.trim()).join(", "),
      ),
    },
    {
      label: "Signed on",
      signed: signedText("investor_sign_date", raw.investor_sign_date),
      record: "—",
    },
  ];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Investor's answers</CardTitle>
        <CardDescription>
          Exactly as signed on Exhibit B, next to the member record as it is
          now. Nothing here is saved until you confirm the details below.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {answers.issues.length > 0 ? (
          <Alert className="border-amber-300 bg-amber-50 text-amber-900 dark:bg-amber-950 dark:text-amber-100">
            <AlertTitle>Check before confirming</AlertTitle>
            <AlertDescription>
              <ul className="list-disc pl-4">
                {answers.issues.map((issue) => (
                  <li key={issue}>{issue}</li>
                ))}
              </ul>
            </AlertDescription>
          </Alert>
        ) : null}
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-1/4">Question</TableHead>
              <TableHead>As signed</TableHead>
              <TableHead>Member record</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.label}>
                <TableCell className="text-muted-foreground">
                  {row.label}
                </TableCell>
                <TableCell className="font-medium">{row.signed}</TableCell>
                <TableCell>{row.record}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
