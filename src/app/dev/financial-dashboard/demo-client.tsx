"use client";

// Development-only demo client (see page.tsx for the production guard).

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useMemo } from "react";
import { SegmentedControl } from "@/components/charts/chart-frame";
import { ThroughLine } from "@/components/financials/dashboard-header";
import { FundDashboard } from "@/components/financials/fund-dashboard";
import { InvestmentDashboard } from "@/components/financials/investment-dashboard";
import { usePeriodState } from "@/components/financials/use-period-state";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { monthEnd } from "@/lib/llc/financial-periods";
import {
  type FundMonthJson,
  fundMonthFromJson,
  type HolderMonthJson,
  holderMonthFromJson,
  holderSlice,
} from "@/lib/llc/financial-series";

export interface DemoWorld {
  label: string;
  inception: string;
  fundMonths: FundMonthJson[];
  holderMonths: HolderMonthJson[];
  holderIds: string[];
  restatements: { month: string; at: string }[];
}

const HOLDER_NAMES: Record<string, string> = {
  A: "Holder A (Preferred)",
  B: "Holder B (Preferred)",
  C: "Holder C (Preferred)",
  D: "Holder D (admitted mid-history)",
  E: "Holder E (admitted by transfer)",
  M: "Common Member",
};

export function DemoClient({
  worlds,
  targetSaleDate,
}: {
  worlds: Record<string, DemoWorld>;
  targetSaleDate: string;
}) {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const [state, setState] = usePeriodState();
  const worldKey = params.get("world") ?? "published";
  const gap = params.get("gap") === "1";
  const tab = params.get("tab") === "mine" ? "mine" : "fund";
  const holder = params.get("holder") ?? "A";
  const w = worlds[worldKey] ?? (worlds.published as DemoWorld);

  const setParam = (k: string, v: string | null) => {
    const p = new URLSearchParams(params.toString());
    if (v === null) p.delete(k);
    else p.set(k, v);
    router.replace(`${pathname}?${p.toString()}`, { scroll: false });
  };

  const { fundMonths, holderMonths, gapMonth } = useMemo(() => {
    const f = w.fundMonths.map(fundMonthFromJson);
    const h = w.holderMonths.map(holderMonthFromJson);
    // "gap": drop the 9th month's records, as if that month had none
    const g = gap ? (f[8]?.month ?? null) : null;
    return {
      fundMonths: g ? f.filter((m) => m.month !== g) : f,
      holderMonths: g ? h.filter((m) => m.month !== g) : h,
      gapMonth: g,
    };
  }, [w, gap]);
  const last = fundMonths[fundMonths.length - 1];
  const live = worldKey === "live";

  return (
    <div className="flex flex-col gap-6">
      <div className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
        Development demo of the P14 chart kit, fed by the P12 fixture world. Not
        a product page.
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <SegmentedControl
            options={Object.entries(worlds).map(([key, x]) => ({
              key,
              label: x.label,
            }))}
            value={worldKey}
            onChange={(k) => setParam("world", k)}
            label="Data"
            size="sm"
            testId="demo-world"
          />
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={gap}
              onChange={(e) => setParam("gap", e.target.checked ? "1" : null)}
              data-testid="demo-gap"
            />
            Drop a month (gap{gapMonth ? `: ${gapMonth.slice(0, 7)}` : ""})
          </label>
        </div>
      </div>

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="font-medium">Financials</h3>
          <p className="text-sm text-muted-foreground">Fixture Fund I LLC</p>
        </div>
        {tab === "mine" ? (
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">Viewing</span>
            <Select value={holder} onValueChange={(v) => setParam("holder", v)}>
              <SelectTrigger
                className="w-64"
                aria-label="Holder"
                data-testid="holder-select"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {w.holderIds.map((id) => (
                  <SelectItem key={id} value={id}>
                    {HOLDER_NAMES[id] ?? id}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ) : null}
      </div>

      {last ? (
        <ThroughLine
          publishedThrough={live ? last.asOf : monthEnd(last.month)}
          variant={live ? "books" : "published"}
          note={
            live
              ? "Live from the ledger; the current month is in progress."
              : "Figures run through the latest period the Manager has released. Later periods appear when they are released."
          }
        />
      ) : null}

      <SegmentedControl
        options={[
          { key: "fund", label: "Fund performance" },
          { key: "mine", label: "My investment" },
        ]}
        value={tab}
        onChange={(k) => setParam("tab", k === "fund" ? null : k)}
        label="Section"
        className="self-start"
        testId="demo-tab"
      />

      {tab === "fund" ? (
        <FundDashboard
          fundMonths={fundMonths}
          inceptionMonth={w.inception}
          state={state}
          onStateChange={setState}
          restatements={w.restatements}
          targetSaleDate={targetSaleDate}
        />
      ) : (
        <InvestmentDashboard
          holderMonths={holderSlice(holderMonths, holder)}
          fundMonths={fundMonths}
          inceptionMonth={w.inception}
          state={state}
          onStateChange={setState}
          restatements={w.restatements}
        />
      )}
    </div>
  );
}
