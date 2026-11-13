import { RiFilePdf2Fill } from "@remixicon/react";
import type { Metadata } from "next";
import EmptyState from "@/components/common/empty-state";
import { PageLayout } from "@/components/dashboard/page-layout";
import { NewReportMenu } from "@/components/governance/report-editor";
import { ReportTable } from "@/components/governance/report-table";
import { UnAuthorizedState } from "@/components/ui/un-authorized-state";
import { GOVERNANCE_TIME_ZONE, todayInZone } from "@/lib/governance/dates";
import { serverAccessControl } from "@/lib/rbac/access-control";
import { getSessionEntity } from "@/server/entity";
import { api } from "@/trpc/server";

export const metadata: Metadata = {
  title: "Reports",
};

// Member reports (03-governance.md G13): quarterly and annual reports,
// Schedules K-1 and notices to Members (Section 8.2). Corporations have no
// reports page yet.

export default async function ReportsPage() {
  const entity = await getSessionEntity();
  if (!entity.isLlc) {
    return (
      <EmptyState
        icon={<RiFilePdf2Fill />}
        title="No reports available."
        subtitle="Reports are available for LLCs."
      />
    );
  }

  const { allow } = await serverAccessControl();
  const rows = await allow(api.memberReport.list({}), ["governance", "read"]);
  if (!rows) return <UnAuthorizedState />;
  const canCreate = allow(true, ["governance", "create"], false);
  const base = `/${entity.publicId}/reports`;
  const timeZone = entity.timezone || GOVERNANCE_TIME_ZONE;
  const today = todayInZone(new Date(), timeZone);

  const action = canCreate ? <NewReportMenu base={base} today={today} /> : null;

  return (
    <PageLayout
      title="Reports"
      description="Quarterly and annual reports, Schedules K-1 and notices to Members (Section 8.2)"
      action={action}
    >
      {rows.length === 0 ? (
        <EmptyState
          icon={<RiFilePdf2Fill />}
          title="No reports yet."
          subtitle="Reports sent to Members appear here."
        />
      ) : (
        <ReportTable
          rows={rows}
          base={base}
          timeZone={timeZone}
          today={today}
        />
      )}
    </PageLayout>
  );
}
