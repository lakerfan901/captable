import { RiCalendarCheckLine } from "@remixicon/react";
import type { Metadata } from "next";
import EmptyState from "@/components/common/empty-state";
import { PageLayout } from "@/components/dashboard/page-layout";
import { AddDeadlineDialog } from "@/components/governance/compliance-dialogs";
import { ComplianceTable } from "@/components/governance/compliance-table";
import { UnAuthorizedState } from "@/components/ui/un-authorized-state";
import { serverAccessControl } from "@/lib/rbac/access-control";
import { requireLlc } from "@/server/entity";
import { api } from "@/trpc/server";

export const metadata: Metadata = { title: "Compliance calendar" };

// Compliance calendar (03-governance.md G15). One `compliance.list` call per
// render (each call runs the ledger sync), with the closed rows included; the
// client groups them and collapses the closed group.

export default async function CompliancePage() {
  const entity = await requireLlc();
  const { allow } = await serverAccessControl();
  const rows = await allow(api.compliance.list({ includeClosed: true }), [
    "governance",
    "read",
  ]);
  if (!rows) return <UnAuthorizedState />;
  const canCreate = allow(true, ["governance", "create"], false);
  const action = canCreate ? <AddDeadlineDialog /> : null;

  return (
    <PageLayout
      title="Compliance calendar"
      description="Deadlines under the Operating Agreement, with reminders to the Manager"
      action={action}
    >
      {rows.length === 0 ? (
        <EmptyState
          icon={<RiCalendarCheckLine />}
          title="No deadlines yet."
          subtitle="Deadlines appear once the first Member is admitted."
        />
      ) : (
        <ComplianceTable rows={rows} companyPublicId={entity.publicId} />
      )}
    </PageLayout>
  );
}
