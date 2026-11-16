import { portalPageCall } from "@/components/portal/portal-call";
import { requirePortalHolder } from "@/components/portal/portal-me";
import { PortalReportList } from "@/components/portal/report-list";
import { PortalSectionHeading } from "@/components/portal/section-heading";
import { GOVERNANCE_TIME_ZONE } from "@/lib/governance/dates";
import { api } from "@/trpc/server";

// /portal/[access]/reports (04-investor-portal.md 6.1; package P8b): the
// reports released and published to this holder (P11), newest first,
// through `portal.reports.list`. Rendered per request (the gate reads the
// portal cookie); a page answered with `Cache-Control: no-store`.

export default async function PortalReportsPage(props: {
  params: Promise<{ access: string }>;
}) {
  const { access } = await props.params;
  const { holder } = await requirePortalHolder(access);
  const [reports, home] = await Promise.all([
    portalPageCall(() => api.portal.reports.list({ access })),
    portalPageCall(() => api.portal.home({ access })),
  ]);
  return (
    <section className="flex flex-col gap-y-3" aria-labelledby="reports-title">
      <PortalSectionHeading
        title="Reports"
        id="reports-title"
        description={`Reports released to ${holder.holderName}`}
      />
      <PortalReportList
        access={access}
        timeZone={home.timeZone || GOVERNANCE_TIME_ZONE}
        reports={reports.map((r) => ({
          id: r.id,
          title: r.title,
          type: r.type,
          periodStart: r.periodStart,
          periodEnd: r.periodEnd,
          releasedAt: r.releasedAt,
        }))}
      />
    </section>
  );
}
