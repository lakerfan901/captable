import { RiPieChartFill } from "@remixicon/react";
import type { Metadata } from "next";
import EmptyState from "@/components/common/empty-state";
import { MemberScheduleView } from "@/components/llc/schedule/member-schedule-view";
import { ScheduleIndicators } from "@/components/llc/schedule/schedule-indicators";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { UnAuthorizedState } from "@/components/ui/un-authorized-state";
import { isValidDateOnly, todayInTimeZone } from "@/lib/date-only";
import { serverAccessControl } from "@/lib/rbac/access-control";
import { getVocabulary } from "@/lib/vocabulary";
import { getSessionEntity, type SessionEntity } from "@/server/entity";
import { api } from "@/trpc/server";

export async function generateMetadata(): Promise<Metadata> {
  const entity = await getSessionEntity();
  return { title: getVocabulary(entity.entityType).schedule };
}

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const MemberSchedulePage = async ({
  entity,
  searchParams,
}: {
  entity: SessionEntity;
  searchParams: SearchParams;
}) => {
  const raw = (await searchParams).asOf;
  const requested = typeof raw === "string" ? raw : undefined;
  const today = todayInTimeZone(entity.timezone);
  const asOfError =
    requested !== undefined &&
    (!isValidDateOnly(requested) || requested > today)
      ? "The as-of date must be a valid date that is not after today. Showing today."
      : null;
  const asOf = asOfError === null ? requested : undefined;

  const { allow } = await serverAccessControl();
  const schedule = await allow(api.memberSchedule.get({ asOf }), [
    "stakeholder",
    "read",
  ]);
  if (!schedule) {
    return <UnAuthorizedState />;
  }

  const exportHref = (format: "pdf" | "csv") =>
    `/${entity.publicId}/captable/export?format=${format}&asOf=${schedule.asOf}`;
  const isEmpty =
    schedule.common.rows.length === 0 && schedule.preferred.rows.length === 0;

  return (
    <div className="flex flex-col gap-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="gap-y-3">
          <h3 className="font-medium">Member schedule</h3>
          <p className="text-sm text-muted-foreground">
            Exhibit A to the Operating Agreement, kept current under Section
            12.1(a)
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <form method="get" className="flex items-end gap-2">
            <label
              htmlFor="schedule-as-of"
              className="flex flex-col text-xs text-muted-foreground"
            >
              As of
              <Input
                id="schedule-as-of"
                type="date"
                name="asOf"
                defaultValue={schedule.asOf}
                max={today}
                className="w-40"
              />
            </label>
            <Button type="submit" variant="outline">
              Show
            </Button>
          </form>
          <a
            href={exportHref("pdf")}
            className={buttonVariants({ variant: "outline" })}
          >
            Export PDF
          </a>
          <a
            href={exportHref("csv")}
            className={buttonVariants({ variant: "outline" })}
          >
            Export CSV
          </a>
        </div>
      </div>

      {asOfError ? <p className="text-sm text-red-600">{asOfError}</p> : null}

      <ScheduleIndicators
        indicators={schedule.indicators}
        publicId={entity.publicId}
      />

      {isEmpty ? (
        <EmptyState
          icon={<RiPieChartFill />}
          title="No members yet."
          subtitle="Members appear here once they have a commitment or units."
        />
      ) : (
        <MemberScheduleView schedule={schedule} publicId={entity.publicId} />
      )}
    </div>
  );
};

const CaptablePage = async (props: { searchParams: SearchParams }) => {
  const entity = await getSessionEntity();
  if (entity.isLlc) {
    return (
      <MemberSchedulePage entity={entity} searchParams={props.searchParams} />
    );
  }

  return (
    <EmptyState
      icon={<RiPieChartFill />}
      title="Work in progress."
      subtitle="This page is not yet available."
    >
      <Button>Import existing captable</Button>
    </EmptyState>
  );
};

export default CaptablePage;
