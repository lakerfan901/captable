// Development-only demo of the chart kit and dashboard components (P14),
// fed by P12's fixture world. NOT a product page.
//
// Guard: in a production build (NODE_ENV === "production") this route
// answers 404 unless the server process has FINANCIAL_DASHBOARD_DEMO=1 in
// its environment at REQUEST time. The page is force-dynamic and reads the
// flag with a computed key, so `next build` cannot bake the flag in and no
// HTML of this page is prerendered. Nothing here reads a database or a
// session; the figures are generated in memory from the fixture.

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { addMonths } from "@/lib/llc/dates";
import { fundMonthToJson, holderMonthToJson } from "@/lib/llc/financial-series";
import { buildSeries } from "@/lib/llc/financial-series-build";
import { generateWorld } from "@/lib/llc/fixtures/series-world";
import { DemoClient, type DemoWorld } from "./demo-client";
import { DEMO_FLAG, demoAllowed } from "./guard";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Financial dashboard demo",
  robots: { index: false, follow: false },
};

function world(
  seed: number,
  months: number,
  inProgress: boolean,
  label: string,
): DemoWorld {
  const w = generateWorld(seed, { months, inProgress });
  const { fundMonths, holderMonths } = buildSeries(w.input, {
    from: w.inception,
    to: w.lastMonth,
  });
  return {
    label,
    inception: w.inception,
    fundMonths: fundMonths.map(fundMonthToJson),
    holderMonths: holderMonths.map(holderMonthToJson),
    holderIds: w.holderIds,
    restatements: [{ month: addMonths(w.inception, 7), at: "2027-11-14" }],
  };
}

export default function FinancialDashboardDemoPage() {
  if (!demoAllowed(process.env.NODE_ENV, process.env[DEMO_FLAG])) notFound();
  const worlds: Record<string, DemoWorld> = {
    published: world(7, 20, false, "Published"),
    live: world(7, 15, true, "Live (month in progress)"),
  };
  return (
    <div className="mx-auto max-w-[1240px] px-4 py-8 sm:px-8">
      <Suspense fallback={null}>
        <DemoClient worlds={worlds} targetSaleDate="2031-06-30" />
      </Suspense>
    </div>
  );
}
