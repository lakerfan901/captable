// The export request of the view on screen (04-investor-portal.md 5.9
// "Export of the current view"; package P17). Pure: relative imports only,
// tested. The columns are the periods the charts plot (the trend of
// `resolveView`), the Summary is the period the tiles describe; the server
// clamps the range to what the viewer may see.

import type { FinancialsExportView } from "../../lib/xlsx/financials-export-input";
import { type PeriodState, resolveView, type Span } from "./period-state";

export function exportRequestOf(
  state: PeriodState,
  span: Span,
  view: FinancialsExportView["view"],
): FinancialsExportView {
  const v = resolveView(state, span);
  return {
    view,
    grain: v.trendGrain,
    from: v.trendRange.from,
    to: v.trendRange.to,
    focus: v.focus.key,
    compare: v.comparison === null ? "none" : state.compare,
  };
}

/** The print route of a dashboard page with the page's query (period, source, holder). */
export function printHref(pagePath: string, search: string): string {
  const params = new URLSearchParams(search);
  params.set("autoprint", "1");
  return `${pagePath.replace(/\/$/, "")}/print?${params.toString()}`;
}

/** The dashboard page of a print route, with the same view (`autoprint` dropped). */
export function backFromPrint(printPath: string, search: string): string {
  const params = new URLSearchParams(search);
  params.delete("autoprint");
  const qs = params.toString();
  return `${printPath.replace(/\/print\/?$/, "")}${qs ? `?${qs}` : ""}`;
}
