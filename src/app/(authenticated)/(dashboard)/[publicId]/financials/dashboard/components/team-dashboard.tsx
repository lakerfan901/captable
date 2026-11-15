"use client";

// The team's financial dashboard (04-investor-portal.md 6.3, P39; package
// P16): the P14 components fed by one of three sources, chosen in the URL:
// Live (`financialDashboard.live`, the ledger through today), Published (the
// snapshots, `published()`) and, with `portal: read`, Preview as investor
// (`published({ asHolder })`, exactly what that holder sees). Only the
// active source is fetched; the status line (`status`, as expensive as Live)
// is fetched once per visit and again only after a Restate.

import { useSearchParams } from "next/navigation";
import { useCallback, useMemo } from "react";
import { SegmentedControl } from "@/components/charts/chart-frame";
import { ThroughLine } from "@/components/financials/dashboard-header";
import { FundDashboard } from "@/components/financials/fund-dashboard";
import { InvestmentDashboard } from "@/components/financials/investment-dashboard";
import {
  type DashboardSource,
  parseSourceState,
  type SourceState,
  serializeSourceState,
  sourceOptions,
} from "@/components/financials/team-dashboard-model";
import { usePeriodState } from "@/components/financials/use-period-state";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  fundMonthFromJson,
  holderMonthFromJson,
} from "@/lib/llc/financial-series";
import { api } from "@/trpc/react";
import type { RouterOutputs } from "@/trpc/shared";
import { DashboardStatus } from "./dashboard-status";

type View = RouterOutputs["financialDashboard"]["live"];

export interface PreviewHolder {
  id: string;
  name: string;
}

const QUERY_OPTS = { refetchOnWindowFocus: false, staleTime: 60_000 } as const;

export function TeamDashboard({
  canPreview,
  canRestate,
  holders,
}: {
  canPreview: boolean;
  canRestate: boolean;
  holders: PreviewHolder[];
}) {
  const params = useSearchParams();
  const holderIds = useMemo(() => holders.map((h) => h.id), [holders]);
  const src = useMemo(
    () => parseSourceState((k) => params.get(k), { canPreview, holderIds }),
    [params, canPreview, holderIds],
  );
  const [period, setPeriod] = usePeriodState();

  const setSource = useCallback((next: SourceState) => {
    const qs = serializeSourceState(
      next,
      new URLSearchParams(window.location.search),
    ).toString();
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}${qs ? `?${qs}` : ""}`,
    );
  }, []);

  const live = api.financialDashboard.live.useQuery(undefined, {
    ...QUERY_OPTS,
    enabled: src.source === "live",
  });
  const published = api.financialDashboard.published.useQuery(undefined, {
    ...QUERY_OPTS,
    enabled: src.source === "published",
  });
  const preview = api.financialDashboard.published.useQuery(
    { asHolder: src.holder ?? "" },
    {
      ...QUERY_OPTS,
      enabled: src.source === "preview" && src.holder !== null,
    },
  );
  const query =
    src.source === "live"
      ? live
      : src.source === "published"
        ? published
        : preview;
  const holderName =
    holders.find((h) => h.id === src.holder)?.name ?? "this holder";

  return (
    <div className="flex flex-col gap-6" data-testid="team-dashboard">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="font-medium">Financials dashboard</h3>
          <p className="text-sm text-muted-foreground">
            Fund performance from the books, by month, quarter and year
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <SegmentedControl
            options={sourceOptions(canPreview)}
            value={src.source}
            onChange={(k: DashboardSource) =>
              setSource({ source: k, holder: src.holder, section: "fund" })
            }
            label="Source"
            size="sm"
            testId="source-switch"
          />
          {src.source === "preview" && holders.length > 0 ? (
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground">Holder</span>
              <Select
                value={src.holder ?? undefined}
                onValueChange={(v) => setSource({ ...src, holder: v })}
              >
                <SelectTrigger
                  className="w-56 max-w-[70vw]"
                  aria-label="Holder"
                  data-testid="preview-holder"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {holders.map((h) => (
                    <SelectItem key={h.id} value={h.id}>
                      {h.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : null}
        </div>
      </div>

      <DashboardStatus canRestate={canRestate} />

      {src.source === "preview" && holders.length === 0 ? (
        <Empty
          title="No holder has a published period yet."
          note="Preview shows what one holder sees. It becomes available when a quarterly or annual report is released."
        />
      ) : query.error ? (
        <Alert variant="destructive">
          <AlertDescription>{query.error.message}</AlertDescription>
        </Alert>
      ) : !query.data ? (
        <div
          className="h-96 animate-pulse rounded-lg bg-muted"
          aria-hidden
          data-testid="dashboard-loading"
        />
      ) : (
        <SourceBody
          view={query.data}
          src={src}
          holderName={holderName}
          period={period}
          setPeriod={setPeriod}
          setSource={setSource}
        />
      )}
    </div>
  );
}

function Empty({ title, note }: { title: string; note: string }) {
  return (
    <div className="rounded-lg border p-6" data-testid="dashboard-empty">
      <p className="text-sm font-medium">{title}</p>
      <p className="mt-1 text-sm text-muted-foreground">{note}</p>
    </div>
  );
}

function SourceBody({
  view,
  src,
  holderName,
  period,
  setPeriod,
  setSource,
}: {
  view: View;
  src: SourceState;
  holderName: string;
  period: ReturnType<typeof usePeriodState>[0];
  setPeriod: ReturnType<typeof usePeriodState>[1];
  setSource: (next: SourceState) => void;
}) {
  const fundMonths = useMemo(
    () => view.fundMonths.map(fundMonthFromJson),
    [view.fundMonths],
  );
  const holderMonths = useMemo(
    () => view.holderMonths.map(holderMonthFromJson),
    [view.holderMonths],
  );
  const inception = view.inceptionMonth ?? undefined;
  const targetSaleDate = view.termClock?.targetSaleDate ?? null;

  if (fundMonths.length === 0 || view.publishedThrough === null) {
    if (src.source === "live") {
      return (
        <Empty
          title="The ledger has no figures yet."
          note="Figures appear here from the month of the first capital receipt or ledger entry."
        />
      );
    }
    if (src.source === "published") {
      return (
        <Empty
          title="Nothing has been published to investors yet."
          note="Releasing a quarterly or annual report publishes its months to the holders it is released to."
        />
      );
    }
    return (
      <Empty
        title={`No financial period has been released to ${holderName} yet.`}
        note="Figures appear here when the Manager releases a quarterly or annual report to this holder."
      />
    );
  }

  const inProgress = fundMonths.some((m) => m.inProgress);
  return (
    <div className="flex flex-col gap-6">
      {src.source === "live" ? (
        <ThroughLine
          publishedThrough={view.publishedThrough}
          variant="books"
          note={`Live from the ledger: every month, including periods not yet released.${
            inProgress ? " The current month is in progress." : ""
          }`}
        />
      ) : src.source === "published" ? (
        <ThroughLine
          publishedThrough={view.publishedThrough}
          note="Every published month, as stored at release. Each holder sees the months of the reports released to them."
        />
      ) : (
        <>
          <Alert data-testid="preview-banner">
            <AlertDescription>
              Preview: what <span className="font-medium">{holderName}</span>{" "}
              sees in the investor portal.
            </AlertDescription>
          </Alert>
          <ThroughLine
            publishedThrough={view.publishedThrough}
            note="Figures run through the latest period the Manager has released. Later periods appear when they are released."
          />
          <SegmentedControl
            options={[
              { key: "fund", label: "Fund performance" },
              { key: "mine", label: "My investment" },
            ]}
            value={src.section}
            onChange={(k) => setSource({ ...src, section: k })}
            label="Section"
            className="self-start"
            testId="preview-section"
          />
        </>
      )}
      {src.source === "preview" && src.section === "mine" ? (
        <InvestmentDashboard
          holderMonths={holderMonths}
          fundMonths={fundMonths}
          inceptionMonth={inception}
          state={period}
          onStateChange={setPeriod}
          restatements={view.restatements}
        />
      ) : (
        <FundDashboard
          fundMonths={fundMonths}
          inceptionMonth={inception}
          state={period}
          onStateChange={setPeriod}
          restatements={view.restatements}
          targetSaleDate={targetSaleDate}
        />
      )}
    </div>
  );
}
