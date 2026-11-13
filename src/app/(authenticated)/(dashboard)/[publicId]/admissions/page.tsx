import { RiFileTextLine, RiMailSendLine } from "@remixicon/react";
import type { Metadata } from "next";
import EmptyState from "@/components/common/empty-state";
import { MasterList } from "@/components/llc/admission/master-list";
import { PacketTable } from "@/components/llc/admission/packet-table";
import { SendSubscriptionDialog } from "@/components/llc/admission/send-subscription-dialog";
import { UploadMasterDialog } from "@/components/llc/admission/upload-master-dialog";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { UnAuthorizedState } from "@/components/ui/un-authorized-state";
import { TEST_MODE_TEXT } from "@/lib/mail-delivery";
import { serverAccessControl } from "@/lib/rbac/access-control";
import { requireLlc } from "@/server/entity";
import { currentMailDelivery } from "@/server/mail-delivery";
import { api } from "@/trpc/server";

export const metadata: Metadata = {
  title: "Admissions",
};

// Admissions (01-foundation.md F12): Exhibit B masters and the subscription
// packets sent from them. Reading needs `commitments: read`; the send dialog's
// people, Manager signatories and Final Closing Date come from procedures
// with their own policies and are simply empty without them.

export default async function AdmissionsPage(props: {
  params: Promise<{ publicId: string }>;
}) {
  await requireLlc();
  const { publicId } = await props.params;
  const { allow } = await serverAccessControl();
  const data = await allow(
    Promise.all([api.admission.masters(), api.admission.list()]),
    ["commitments", "read"],
  );

  if (!data) {
    return <UnAuthorizedState />;
  }
  const [masters, packets] = data;

  const canCreate = allow(true, ["commitments", "create"], false);
  const mailDelivery = currentMailDelivery("MEMBER_EMAIL");

  let sendDialog: React.ReactNode = null;
  if (canCreate) {
    const canReadPeople = allow(true, ["stakeholder", "read"], false);
    const canReadMembers = allow(true, ["members", "read"], false);
    const canReadClasses = allow(true, ["unit-classes", "read"], false);
    const [stakeholders, members, unitClasses] = await Promise.all([
      canReadPeople ? api.stakeholder.getStakeholders() : null,
      canReadMembers ? api.member.getMembers() : null,
      canReadClasses ? api.unitClass.list() : null,
    ]);
    const people = (stakeholders ?? [])
      .map((s) => ({ id: s.id, name: s.name, email: s.noticeEmail ?? s.email }))
      .sort((a, b) => a.name.localeCompare(b.name, "en"));
    const managers = (members?.data ?? []).flatMap((m) =>
      m.status === "ACTIVE" && m.user?.name && m.user.email
        ? [{ memberId: m.id, name: m.user.name, email: m.user.email }]
        : [],
    );
    const finalClosingDate =
      unitClasses?.classes.find((c) => c.kind === "PREFERRED")
        ?.finalClosingDate ?? null;
    const readyMasters = masters
      .filter((m) => m.ready)
      .map((m) => ({ publicId: m.publicId, name: m.name }));

    sendDialog = (
      <SendSubscriptionDialog
        trigger={
          <Button disabled={readyMasters.length === 0}>
            Send subscription
          </Button>
        }
        masters={readyMasters}
        people={people}
        managers={managers}
        finalClosingDate={finalClosingDate}
        mailDelivery={mailDelivery}
      />
    );
  }

  const uploadMaster = canCreate ? (
    <UploadMasterDialog
      trigger={<Button variant="outline">Upload master</Button>}
      companyPublicId={publicId}
    />
  ) : null;

  return (
    <div className="flex flex-col gap-y-6">
      <div className="flex items-center justify-between gap-y-3">
        <div className="gap-y-3">
          <h3 className="font-medium">Admissions</h3>
          <p className="text-sm text-muted-foreground">
            Send the Exhibit B signature page to investors and collect their
            Form W-9
          </p>
        </div>
        <div className="flex flex-wrap gap-2">{sendDialog}</div>
      </div>

      {mailDelivery.blockedReason ? (
        <Alert variant="destructive">
          <AlertTitle>Sending is blocked</AlertTitle>
          <AlertDescription>{mailDelivery.blockedReason}</AlertDescription>
        </Alert>
      ) : mailDelivery.testMode ? (
        <Alert variant="destructive">
          <AlertTitle>Test mode</AlertTitle>
          <AlertDescription>{TEST_MODE_TEXT}</AlertDescription>
        </Alert>
      ) : null}

      <section className="flex flex-col gap-y-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h4 className="font-medium">Subscription masters</h4>
            <p className="text-sm text-muted-foreground">
              Place one field per Exhibit B blank and choose its meaning. To let
              a different Manager signatory sign on their own line, keep one
              master per signatory.
            </p>
          </div>
          {masters.length > 0 ? uploadMaster : null}
        </div>
        {masters.length === 0 ? (
          <EmptyState
            icon={<RiFileTextLine />}
            title="No masters"
            subtitle="Upload the Exhibit B signature page to start."
          >
            {uploadMaster}
          </EmptyState>
        ) : (
          <Card className="w-full">
            <MasterList masters={masters} companyPublicId={publicId} />
          </Card>
        )}
      </section>

      <section className="flex flex-col gap-y-3">
        <h4 className="font-medium">Subscriptions</h4>
        {packets.length === 0 ? (
          <EmptyState
            icon={<RiMailSendLine />}
            title="No subscriptions"
            subtitle="No subscriptions have been sent."
          />
        ) : (
          <Card className="w-full">
            <PacketTable
              packets={packets}
              companyPublicId={publicId}
              mailBlocked={mailDelivery.blockedReason !== null}
            />
          </Card>
        )}
      </section>
    </div>
  );
}
