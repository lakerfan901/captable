import type { Metadata } from "next";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { UnAuthorizedState } from "@/components/ui/un-authorized-state";
import { serverAccessControl } from "@/lib/rbac/access-control";
import { requireLlc } from "@/server/entity";
import { api } from "@/trpc/server";
import { LineTable } from "../components/line-table";
import { KIND_LABEL, NoticeStatusBadge } from "../components/notice-table";
import { CancelDraftButton, SendDialog } from "../components/send-dialog";
import { SendResolution } from "../components/send-resolution";

export const metadata: Metadata = { title: "Call Notice" };

export default async function CallNoticePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const entity = await requireLlc();
  const { id } = await params;
  const { allow } = await serverAccessControl();
  const data = await allow(api.callNotice.get({ id }), [
    "capital-calls",
    "read",
  ]);
  if (!data) return <UnAuthorizedState />;
  const eligible = await api.callNotice.eligible();
  const canCreate = allow(true, ["capital-calls", "create"], false);
  const canDelete = allow(true, ["capital-calls", "delete"], false);
  const canUpdate = allow(true, ["capital-calls", "update"], false);
  const mailCatcher = allow(true, ["emails", "read"], false)
    ? (await api.emailLog.deliveryStatus()).mailCatcher
    : false;
  const base = `/${entity.publicId}/capital-calls`;
  const { notice, wire, lines } = data;
  const isCall = notice.kind === "CALL";
  // A failed line whose email the log shows as accepted is resolved, not resent.
  const sendable = lines.filter(
    (l) =>
      l.status === "UNSENT" ||
      (l.status === "SEND_FAILED" && l.sentEmailLog === null),
  );
  // Kept mounted after the last line is sent so the dialog can show the
  // per-line results; it renders nothing when closed with no recipients.
  const canSend = canCreate && isCall && notice.status !== "CANCELLED";
  const emails = new Map(eligible.states.map((s) => [s.commitmentId, s]));

  return (
    <div className="flex flex-col gap-y-4">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <Link href={base} className="text-sm text-muted-foreground">
            ← Capital calls
          </Link>
          <h3 className="flex items-center gap-2 font-medium">
            {KIND_LABEL[notice.kind]} No. {notice.number}
            <NoticeStatusBadge status={notice.status} />
          </h3>
          {notice.purpose ? (
            <p className="max-w-2xl text-sm text-muted-foreground">
              {notice.purpose}
            </p>
          ) : null}
          {notice.status === "CANCELLED" && notice.cancelReason ? (
            <p className="text-sm text-muted-foreground">
              Cancelled: {notice.cancelReason}
            </p>
          ) : null}
        </div>
        <div className="flex flex-wrap gap-2">
          {canCreate && notice.status === "DRAFT" ? (
            <Button variant="outline" asChild>
              <Link href={`${base}/new?id=${notice.id}`}>Edit draft</Link>
            </Button>
          ) : null}
          {canDelete && notice.status === "DRAFT" ? (
            <CancelDraftButton id={notice.id} number={notice.number} />
          ) : null}
          {canSend ? (
            <SendDialog
              noticeId={notice.id}
              noticeNumber={notice.number}
              proposedDueOn={eligible.proposedDueOn}
              sendBlockedReason={eligible.sendBlockedReason}
              mailCatcher={mailCatcher}
              noticeTerms={eligible.noticeTerms}
              recipients={sendable
                .slice()
                .sort((a, b) => a.name.localeCompare(b.name))
                .map((l) => ({
                  lineId: l.lineId,
                  name: l.name,
                  email: emails.get(l.commitmentId)?.noticeEmail ?? null,
                  amountCalled: l.amountCalled,
                  failed: l.status === "SEND_FAILED",
                }))}
            />
          ) : null}
        </div>
      </div>

      <SendResolution lines={lines} canUpdate={canUpdate} />

      <LineTable
        noticeId={notice.id}
        lines={lines}
        today={data.today}
        canPreview={isCall}
        canRecordPayment={canCreate}
      />

      {wire ? (
        <Card>
          <CardHeader>
            <CardTitle>Wire instructions printed in the notice</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-1 text-sm md:grid-cols-2">
            <div>Beneficiary: {wire.beneficiaryName}</div>
            <div>Beneficiary address: {wire.beneficiaryAddress}</div>
            <div>Bank: {wire.bankName}</div>
            <div>Bank address: {wire.bankAddress}</div>
            <div>Routing number: {wire.routingNumber}</div>
            <div>Account: ••••{wire.accountLast4}</div>
            {wire.swiftCode ? <div>SWIFT: {wire.swiftCode}</div> : null}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
