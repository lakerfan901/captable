// The Excel export of a financial dashboard view (04-investor-portal.md 5.9
// "Export of the current view", P37; package P17): the P7 workbook model
// built from the month records the viewer already has, aggregated with the
// same `aggregate` / `aggregateHolder` the page uses, so the file and the
// screen cannot disagree.
//
// Pure: relative imports only, no clock, no database. The caller decides
// what the viewer may see (the investor's snapshots through the
// published-through date, the team's live or published months, or a
// previewed holder) and passes only that; this module never reads anything
// else and never names a holder unless the caller passes `holderName`
// (the team's preview).
//
// Sheets:
// - fund view: Summary (the KPI tiles of the selected period with the
//   comparison), Income, Expenses (category × period), Distributions,
//   Capital (capital, preferred return, reserves);
// - "mine" view: Summary (the holder's tiles), My investment (the holder's
//   figures × period), My distributions and My contributions (by month, as
//   the tables of the My investment page).
// Period sheets have one column per period of the chosen grain over the
// range and a Total column: SUM across for flows, a reference to the last
// period with figures for balances, the mean of the months for
// utilization. Every total's cached result is computed in integers here.

import {
  FUND_TILES,
  HOLDER_TILES,
  type TileDef,
  tileViews,
} from "../../components/financials/dashboard-model";
import { formatDateOnly } from "../date-only";
import { compareIso, type IsoDate } from "../llc/dates";
import {
  comparisonPeriod,
  type Grain,
  type MonthKey,
  type MonthRange,
  monthsBetween,
  type Period,
  periodByKey,
  periodLabel,
} from "../llc/financial-periods";
import {
  type AggregatedPeriod,
  aggregate,
  aggregateHolder,
  comparePeriodValues,
  FUND_METRICS,
  type FundMonth,
  type FundPeriodValues,
  fundComparison,
  HOLDER_METRICS,
  type HolderMonth,
  type HolderPeriodValues,
  holderComparison,
  type MetricDef,
  type MetricRule,
  type MetricUnit,
  meanBps,
} from "../llc/financial-series";
import { contributionRows, distributionRows } from "../portal/portal-dashboard";
import { humanizeCategory } from "./report-workbook";
import {
  type Cell,
  type Column,
  columnLetter,
  formula,
  type HeadingLine,
  integer,
  money,
  multiple,
  percent,
  type SheetModel,
  type SheetRow,
  sheetLayout,
  sheetName,
  text,
  units,
  type WorkbookModel,
  workbookFileName,
} from "./workbook-model";

export type FinancialsView = "fund" | "mine";
/** Who is looking: the investor (portal), or the team's Live, Published or Preview source. */
export type FinancialsSource = "portal" | "live" | "published" | "preview";
export type TrendGrain = Exclude<Grain, "inception">;
export type ExportCompare = "previous" | "yearAgo" | "none";

export interface FinancialsWorkbookInput {
  companyName: string;
  view: FinancialsView;
  source: FinancialsSource;
  /** the previewed holder's name (team preview only; never the investor's own export) */
  holderName?: string | null;
  /**
   * Portal / Published / Preview: the published-through date. Live: the
   * date the figures are taken at (`asOf` of the last month).
   */
  publishedThrough: IsoDate;
  inceptionMonth: MonthKey | null;
  /** every fund month the viewer may see, from inception */
  fundMonths: readonly FundMonth[];
  /** the holder's own months (view "mine"), one holder only */
  holderMonths?: readonly HolderMonth[];
  restatements?: readonly { month: MonthKey; at: IsoDate }[];
  targetSaleDate?: IsoDate | null;
  /** the columns: periods of `grain` over `from`–`to` (cut to the months that exist) */
  grain: TrendGrain;
  from: MonthKey;
  to: MonthKey;
  /** the selected period of the Summary: a period key or "inception"; default the last column */
  focus?: string | null;
  compare?: ExportCompare;
}

export class FinancialsWorkbookError extends Error {
  constructor(
    readonly code: "NO_MONTHS" | "EMPTY_RANGE" | "BAD_PERIOD",
    message: string,
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// Cells

function centsNumber(v: bigint): number {
  const n = Number(v);
  if (!Number.isSafeInteger(n)) {
    throw new RangeError(`Value out of the safe integer range: ${v}`);
  }
  return n;
}

type RowUnit = MetricUnit | "units" | "count";

/** A metric value as a cell of its unit; null is blank (a period without figures). */
function valueCell(unit: RowUnit, raw: bigint | number | null): Cell {
  if (raw === null) return null;
  const n = typeof raw === "bigint" ? centsNumber(raw) : raw;
  switch (unit) {
    case "cents":
      return money(n);
    case "bps":
      return percent(n);
    case "dpiBps":
      return multiple(n);
    case "units":
      return units(n);
    case "count":
      return integer(n);
  }
}

const fmtDate = (d: IsoDate) => formatDateOnly(d);

// ---------------------------------------------------------------------------
// Periods and the view

interface Span {
  inception: MonthKey;
  last: MonthKey;
}

function within(range: MonthRange, span: Span): MonthRange | null {
  const from =
    compareIso(range.from, span.inception) < 0 ? span.inception : range.from;
  const to = compareIso(range.to, span.last) > 0 ? span.last : range.to;
  return compareIso(from, to) > 0 ? null : { from, to };
}

function focusPeriodOf(
  key: string | null | undefined,
  columns: readonly Period[],
  span: Span,
): { period: Pick<Period, "key" | "grain" | "start">; range: MonthRange } {
  if (key === "inception") {
    return {
      period: { key: "inception", grain: "inception", start: span.inception },
      range: { from: span.inception, to: span.last },
    };
  }
  let p: Period | null = null;
  if (key) {
    try {
      p = periodByKey(key);
    } catch {
      throw new FinancialsWorkbookError("BAD_PERIOD", `Not a period: ${key}`);
    }
  }
  const range = p
    ? within(
        { from: p.start, to: p.months[p.months.length - 1] as MonthKey },
        span,
      )
    : null;
  if (p && range) return { period: p, range };
  // unknown or outside the months that exist: the last column, as the page's "latest"
  const lastColumn = columns[columns.length - 1] as Period;
  return {
    period: lastColumn,
    range: within(
      {
        from: lastColumn.start,
        to: lastColumn.months[lastColumn.months.length - 1] as MonthKey,
      },
      span,
    ) as MonthRange,
  };
}

/** "Q1 2026 – Q4 2026 by quarter" / "Jan 2026 – Dec 2026 by month". */
export function columnsCaption(periods: readonly Period[], grain: TrendGrain) {
  const first = periods[0];
  const last = periods[periods.length - 1];
  if (!first || !last) return "";
  const range =
    first.key === last.key
      ? periodLabel(first.key)
      : `${periodLabel(first.key)} – ${periodLabel(last.key)}`;
  return `${range}, by ${grain}`;
}

/** Column header of a period: its label and why it is not whole. */
export function periodHeader(p: AggregatedPeriod<unknown>): string {
  const label = periodLabel(p.key);
  if (!p.hasData) return `${label} (no figures)`;
  if (p.inProgress) return `${label} (in progress)`;
  if (p.partial) {
    return `${label} (${p.presentMonths.length} of ${p.months.length} months)`;
  }
  return label;
}

// ---------------------------------------------------------------------------
// Period sheets (one row per figure, one column per period, a Total)

interface RowSpec<V> {
  label: string;
  unit: RowUnit;
  rule: MetricRule;
  get: (v: V) => bigint | number | null;
  strong?: boolean;
  indent?: boolean;
  /** the value of the Total column for a "mean" row (computed from the months) */
  mean?: () => number | null;
}

type Line<V> = RowSpec<V> | { section: string };

function fromCatalogue<V>(
  catalogue: readonly MetricDef<V>[],
  key: string,
  opts: {
    label?: string;
    strong?: boolean;
    indent?: boolean;
    mean?: () => number | null;
    audience: FinancialsSource;
  },
): RowSpec<V> | null {
  const def = catalogue.find((m) => m.key === key);
  if (!def) throw new Error(`Unknown metric ${key}`);
  // Decision 9.2 #16: a metric switched off for the portal is absent there.
  if (
    !def.portal &&
    (opts.audience === "portal" || opts.audience === "preview")
  ) {
    return null;
  }
  return {
    label: opts.label ?? def.label,
    unit: def.unit,
    rule: def.rule,
    get: def.get,
    strong: opts.strong,
    indent: opts.indent,
    mean: opts.mean,
  };
}

const BASIS: Record<MetricRule, string> = {
  sum: "Sum",
  end: "End",
  derived: "End",
  mean: "Average",
};

/** A figure that is summed over its months (its Total is a SUM across). */
function summed(rule: MetricRule): boolean {
  return rule === "sum";
}

function periodSheet<V>(args: {
  name: string;
  heading: HeadingLine[];
  periods: readonly AggregatedPeriod<V>[];
  lines: readonly (Line<V> | null)[];
}): SheetModel {
  const { periods } = args;
  const lines = args.lines.filter((l): l is Line<V> => l !== null);
  const firstPeriodCol = 2; // A: figure, B: basis
  const totalCol = firstPeriodCol + periods.length;
  const columns: Column[] = [
    { header: "Figure", width: 46, kind: "text" },
    { header: "Basis", width: 9, kind: "text" },
    ...periods.map((p) => ({
      header: periodHeader(p),
      width: 16,
      kind: "money" as const,
    })),
    { header: "Total", width: 17, kind: "money" },
  ];
  const sheet: SheetModel = {
    name: sheetName(args.name),
    heading: args.heading,
    columns,
    rows: [],
    freezeColumns: 1,
  };
  const layout = sheetLayout({
    ...sheet,
    rows: lines.map(() => ({ cells: [] })),
  });
  sheet.rows = lines.map((line, i): SheetRow => {
    if ("section" in line) {
      return { cells: [text(line.section)], strong: true };
    }
    const rowNumber = layout.firstRow + i;
    const raws = periods.map((p) =>
      p.values === null ? null : line.get(p.values),
    );
    const cells: Cell[] = raws.map((r) => valueCell(line.unit, r));
    let total: Cell = null;
    if (summed(line.rule)) {
      let sum = 0n;
      let any = false;
      for (const r of raws) {
        if (r === null) continue;
        any = true;
        sum += BigInt(r);
      }
      const result = any ? valueCell(line.unit, sum) : null;
      total =
        result === null
          ? null
          : formula(
              `SUM(${columnLetter(firstPeriodCol)}${rowNumber}:${columnLetter(totalCol - 1)}${rowNumber})`,
              result,
            );
    } else if (line.rule === "mean") {
      total = valueCell(line.unit, line.mean ? line.mean() : null);
    } else {
      // end of the range: the last period that has figures
      let idx = -1;
      for (let k = raws.length - 1; k >= 0; k--) {
        if (raws[k] !== null && raws[k] !== undefined) {
          idx = k;
          break;
        }
      }
      if (idx >= 0) {
        const result = valueCell(line.unit, raws[idx] ?? null);
        total =
          result === null
            ? null
            : formula(
                `${columnLetter(firstPeriodCol + idx)}${rowNumber}`,
                result,
              );
      }
    }
    return {
      cells: [text(line.label), text(BASIS[line.rule]), ...cells, total],
      strong: line.strong,
      indent: line.indent,
    };
  });
  return sheet;
}

// ---------------------------------------------------------------------------
// Summary (the KPI tiles)

interface SummaryRow {
  label: string;
  unit: RowUnit;
  value: bigint | number | null;
  previous?: bigint | number | null;
  amount?: bigint | null;
  pctBps?: bigint | null;
  note: string | null;
}

function tileRows<V>(
  defs: readonly TileDef<V>[],
  focus: AggregatedPeriod<V>,
  comparison: AggregatedPeriod<V> | null,
  comparisonLabel: string | null,
  trend: readonly AggregatedPeriod<V>[],
): SummaryRow[] {
  // the strings of the page's tiles (notes), and the numbers behind them
  const views = tileViews(defs, focus, comparison, comparisonLabel, trend);
  const changes = comparePeriodValues(
    defs.map((d) => ({
      key: d.key,
      label: d.label,
      unit: "cents" as const,
      rule: "sum" as const,
      portal: true,
      get: d.get,
    })),
    focus,
    comparison,
  );
  return defs.map((d, i) => {
    const view = views[i];
    const change = changes[d.key];
    const shown =
      comparisonLabel !== null &&
      change !== undefined &&
      (change.status === "OK" || change.status === "PREVIOUS_ZERO");
    const notes = [view?.sub, view?.deltaNote].filter(
      (s): s is string => typeof s === "string" && s !== "",
    );
    return {
      label: d.label,
      unit: d.unit,
      value: focus.values === null ? null : d.get(focus.values),
      previous:
        comparison?.values === null || comparison === null
          ? null
          : d.get(comparison.values),
      amount: shown ? (change?.amount ?? null) : null,
      pctBps:
        shown && d.unit === "cents" && change?.status === "OK"
          ? change.pctBps
          : null,
      note: notes.length > 0 ? notes.join(". ") : null,
    };
  });
}

function summarySheet(args: {
  heading: HeadingLine[];
  focusLabel: string;
  comparisonLabel: string | null;
  rows: SummaryRow[];
}): SheetModel {
  const compared = args.comparisonLabel !== null;
  const columns: Column[] = [
    { header: "Figure", width: 40, kind: "text" },
    { header: args.focusLabel, width: 18, kind: "money" },
    ...(compared
      ? ([
          { header: args.comparisonLabel as string, width: 18, kind: "money" },
          { header: "Change", width: 16, kind: "money" },
          { header: "Change %", width: 11, kind: "percent" },
        ] as Column[])
      : []),
    { header: "Notes", width: 52, kind: "text" },
  ];
  return {
    name: "Summary",
    heading: args.heading,
    columns,
    freezeColumns: 1,
    rows: args.rows.map((r) => ({
      cells: [
        text(r.label),
        valueCell(r.unit, r.value),
        ...(compared
          ? [
              valueCell(r.unit, r.previous ?? null),
              valueCell(r.unit, r.amount ?? null),
              r.pctBps === null || r.pctBps === undefined
                ? null
                : percent(centsNumber(r.pctBps)),
            ]
          : []),
        r.note === null ? null : text(r.note),
      ],
    })),
  };
}

// ---------------------------------------------------------------------------
// Headings

function sourceLine(
  input: FinancialsWorkbookInput,
  inProgress: boolean,
): string {
  const through = fmtDate(input.publishedThrough);
  switch (input.source) {
    case "portal":
      return `Figures published through ${through}. Later periods appear when the Manager releases them.`;
    case "preview":
      return `Preview of the investor portal${
        input.holderName ? ` for ${input.holderName}` : ""
      }: figures published through ${through}.`;
    case "published":
      return `Published to investors through ${through}, as stored at release. Each holder sees the months of the reports released to them.`;
    case "live":
      return `Live from the ledger, figures as of ${through}, including periods not yet released to investors.${
        inProgress
          ? " The current month is in progress: its figures are not final."
          : ""
      }`;
  }
}

function restatedLine(
  restatements: readonly { month: MonthKey; at: IsoDate }[],
  months: readonly MonthKey[],
): string | null {
  const shown = restatements.filter((r) => months.includes(r.month));
  if (shown.length === 0) return null;
  const parts = shown.map(
    (r) => `${periodLabel(r.month.slice(0, 7))} (on ${fmtDate(r.at)})`,
  );
  return `Restated: ${parts.join(", ")}.`;
}

// ---------------------------------------------------------------------------
// The workbook

function sortedFund(months: readonly FundMonth[]): FundMonth[] {
  return [...months].sort((a, b) => compareIso(a.month, b.month));
}

/** The months of `range` that have a fund record. */
function monthsIn(
  months: readonly FundMonth[],
  range: MonthRange,
): FundMonth[] {
  return months.filter(
    (m) =>
      compareIso(m.month, range.from) >= 0 &&
      compareIso(m.month, range.to) <= 0,
  );
}

export function financialsWorkbook(
  input: FinancialsWorkbookInput,
): WorkbookModel {
  const fund = sortedFund(input.fundMonths);
  const first = fund[0];
  const lastRecord = fund[fund.length - 1];
  if (!first || !lastRecord) {
    throw new FinancialsWorkbookError("NO_MONTHS", "No months to export.");
  }
  const span: Span = {
    inception: input.inceptionMonth ?? first.month,
    last: lastRecord.month,
  };
  const range = within({ from: input.from, to: input.to }, span);
  if (range === null) {
    throw new FinancialsWorkbookError(
      "EMPTY_RANGE",
      "No published month in the range.",
    );
  }
  const opts = { inceptionMonth: span.inception };
  const compare = input.compare ?? "previous";
  const restatements = input.restatements ?? [];
  const mine = input.view === "mine";
  const holderMonths = input.holderMonths ?? [];

  // the columns, exactly as the page's charts aggregate them
  const fundPeriods = aggregate(fund, input.grain, range, opts);
  const focusSel = focusPeriodOf(input.focus, fundPeriods, span);
  const focusFund = aggregate(
    fund,
    focusSel.period.grain,
    focusSel.range,
    opts,
  )[0] as AggregatedPeriod<FundPeriodValues>;
  const cmpPeriod =
    compare === "none" ? null : comparisonPeriod(focusSel.period, compare);
  const comparisonLabel = cmpPeriod ? periodLabel(cmpPeriod.key) : null;
  const focusLabel = periodLabel(focusSel.period.key);
  const inProgress = fund.some((m) => m.inProgress);

  const colsCaption = columnsCaption(fundPeriods, input.grain);
  const subject = mine ? "My investment" : "Financials";
  const subjectLine = (sheet: string): HeadingLine[] => {
    const out: HeadingLine[] = [
      { text: `${input.companyName}: ${sheet}`, style: "title" },
    ];
    if (input.source === "preview" && input.holderName) {
      out.push({
        text: `What ${input.holderName} sees in the investor portal`,
        style: "subtitle",
      });
    }
    return out;
  };
  const meta = (extra: string[]): HeadingLine[] => [
    ...extra.map((t) => ({ text: t, style: "subtitle" as const })),
    { text: sourceLine(input, inProgress), style: "meta" },
    ...(() => {
      const r = restatedLine(
        restatements,
        monthsBetween(span.inception, span.last),
      );
      return r ? [{ text: r, style: "meta" as const }] : [];
    })(),
    {
      text: "Amounts in US dollars. Total: the sum of the periods for amounts of a period; for balances (End), the value at the end of the last period; for utilization, the average of the months reported.",
      style: "meta",
    },
  ];

  const summaryHeading = (alert: string | null): HeadingLine[] => [
    ...subjectLine(`${subject} summary`),
    {
      text: `Selected period: ${focusLabel}${
        comparisonLabel ? `, compared with ${comparisonLabel}` : ""
      }`,
      style: "subtitle",
    },
    { text: sourceLine(input, inProgress), style: "meta" },
    ...(alert ? [{ text: alert, style: "alert" as const }] : []),
  ];

  const partialNote = (p: AggregatedPeriod<unknown>) =>
    p.partial && p.grain !== "inception"
      ? `${periodLabel(p.key)} is not complete (${
          p.inProgress
            ? "it includes the month in progress"
            : `${p.presentMonths.length} of ${p.months.length} months`
        }), so it is not compared with a full ${p.grain}.`
      : null;

  const sheets: SheetModel[] = [];
  const audience = input.source;

  if (!mine) {
    // --- Summary: the fund tiles of the selected period
    const comparison =
      cmpPeriod && compare !== "none"
        ? fundComparison(fund, focusSel.period, compare, opts)
        : null;
    const showUtilization = fund.some((m) => m.utilizationBps !== null);
    const defs = FUND_TILES.filter(
      (d) => d.key !== "utilizationBps" || showUtilization,
    );
    const rows = tileRows(
      defs,
      focusFund,
      comparison,
      comparisonLabel,
      fundPeriods,
    );
    if (input.targetSaleDate) {
      const lastOfFocus =
        focusFund.presentMonths[focusFund.presentMonths.length - 1] ??
        span.last;
      const target = `${input.targetSaleDate.slice(0, 8)}01`;
      const n =
        compareIso(target, lastOfFocus) <= 0
          ? 0
          : monthsBetween(lastOfFocus, target).length - 1;
      rows.push({
        label: "Months to the Target Sale Date",
        unit: "count",
        value: n,
        note: `Target Sale Date ${fmtDate(input.targetSaleDate)}`,
      });
    }
    sheets.push(
      summarySheet({
        heading: summaryHeading(partialNote(focusFund)),
        focusLabel,
        comparisonLabel,
        rows,
      }),
    );

    const F = FUND_METRICS;
    const f = (
      key: string,
      o: {
        label?: string;
        strong?: boolean;
        indent?: boolean;
        mean?: () => number | null;
      } = {},
    ) => fromCatalogue(F, key, { ...o, audience });
    const heading = (title: string) => [
      ...subjectLine(title),
      ...meta([`Periods: ${colsCaption}`]),
    ];

    // --- Income
    const utilRangeMean = () =>
      meanBps(monthsIn(fund, range).map((m) => m.utilizationBps));
    const proceeds: RowSpec<FundPeriodValues> = {
      label: "Asset-sale and insurance proceeds",
      unit: "cents",
      rule: "sum",
      get: (v) => v.assetSaleProceeds + v.insuranceProceeds,
    };
    sheets.push(
      periodSheet<FundPeriodValues>({
        name: "Income",
        heading: heading("Income"),
        periods: fundPeriods,
        lines: [
          { section: "Revenue" },
          f("grossRevenue"),
          f("otherIncome"),
          proceeds,
          { section: "Costs" },
          f("operatingExpenses"),
          f("managementFeeAccrued"),
          f("managementFeePaid", { indent: true }),
          f("netOperatingIncome", { strong: true }),
          { section: "Cash" },
          f("reservesEstablished"),
          f("reservesReleased"),
          f("availableCash", { strong: true }),
          ...(showUtilization
            ? [
                { section: "Operations" } as Line<FundPeriodValues>,
                f("utilizationBps", { mean: utilRangeMean }),
              ]
            : []),
        ],
      }),
    );

    // --- Expenses: category × period (every category, none folded)
    const categoryTotals = new Map<string, bigint>();
    for (const p of fundPeriods) {
      for (const c of p.values?.expensesByCategory ?? []) {
        categoryTotals.set(
          c.category,
          (categoryTotals.get(c.category) ?? 0n) + c.amount,
        );
      }
    }
    const categories = [...categoryTotals.entries()]
      .sort(([a, x], [b, y]) => {
        const ax = x < 0n ? -x : x;
        const by = y < 0n ? -y : y;
        if (ax !== by) return by > ax ? 1 : -1;
        return a < b ? -1 : a > b ? 1 : 0;
      })
      .map(([c]) => c);
    const expenseSheet = periodSheet<FundPeriodValues>({
      name: "Expenses",
      heading: heading("Expenses by category"),
      periods: fundPeriods,
      lines: categories.map((category) => ({
        label: humanizeCategory(category),
        unit: "cents" as const,
        rule: "sum" as const,
        get: (v: FundPeriodValues) =>
          v.expensesByCategory.find((c) => c.category === category)?.amount ??
          0n,
      })),
    });
    expenseSheet.emptyText = "No expenses in these periods.";
    expenseSheet.totals = {
      label: "Total expenses",
      columns: expenseSheet.columns.map((_, i) => i).filter((i) => i >= 2),
    };
    sheets.push(expenseSheet);

    // --- Distributions
    sheets.push(
      periodSheet<FundPeriodValues>({
        name: "Distributions",
        heading: heading("Distributions"),
        periods: fundPeriods,
        lines: [
          f("distributions.preferredReturn", { label: "Preferred return" }),
          f("distributions.returnOfCapital", { label: "Return of capital" }),
          f("distributions.residualPreferred", {
            label: "Residual (Preferred)",
          }),
          f("distributions.residualCommon", { label: "Residual (Common)" }),
          f("distributions.gross", { strong: true }),
          f("cumulativeDistributions"),
        ],
      }),
    );

    // --- Capital: capital, preferred return, reserves
    const kindSet = new Set<string>();
    for (const p of fundPeriods) {
      for (const k of p.values?.reservesByKind ?? []) kindSet.add(k.kind);
    }
    const kinds = [...kindSet].sort();
    sheets.push(
      periodSheet<FundPeriodValues>({
        name: "Capital",
        heading: heading("Capital, preferred return and reserves"),
        periods: fundPeriods,
        lines: [
          { section: "Capital" },
          f("committed"),
          f("paidInCapital"),
          f("unreturnedCapital"),
          f("cumulativeDistributionsToPreferred"),
          f("dpiBps"),
          { section: "Preferred return" },
          f("preferredReturnAccruedToDate"),
          f("preferredReturnPaidToDate"),
          f("preferredReturnUnpaid"),
          { section: "Reserves" },
          ...kinds.map(
            (kind): RowSpec<FundPeriodValues> => ({
              label: humanizeCategory(kind),
              unit: "cents",
              rule: "end",
              indent: true,
              get: (v) =>
                v.reservesByKind.find((k) => k.kind === kind)?.balance ?? 0n,
            }),
          ),
          f("reserveBalance", { label: "Total reserve balance", strong: true }),
          f("minimumReserve", { label: "Minimum required" }),
        ],
      }),
    );
  } else {
    // --- the holder's own view
    const calendar = fund.map((m) => ({
      month: m.month,
      inProgress: m.inProgress,
    }));
    const myPeriods = aggregateHolder(
      holderMonths,
      calendar,
      input.grain,
      range,
      opts,
    );
    const myFocus = aggregateHolder(
      holderMonths,
      calendar,
      focusSel.period.grain,
      focusSel.range,
      opts,
    )[0] as AggregatedPeriod<HolderPeriodValues>;
    const myComparison =
      cmpPeriod && compare !== "none"
        ? holderComparison(
            holderMonths,
            calendar,
            focusSel.period,
            compare,
            opts,
          )
        : null;
    const rows = tileRows(
      HOLDER_TILES,
      myFocus,
      myComparison,
      comparisonLabel,
      myPeriods,
    );
    const v = myFocus.values;
    if (v !== null) {
      rows.splice(2, 0, {
        label: "Preferred units",
        unit: "units",
        value: v.preferredUnits,
        note:
          v.preferredUnits !== 0n
            ? `${v.preferredPct}% of the Preferred class at the end of the period`
            : null,
      });
      if (v.commonUnits !== 0n) {
        rows.splice(3, 0, {
          label: "Common units",
          unit: "units",
          value: v.commonUnits,
          note: null,
        });
      }
    }
    sheets.push(
      summarySheet({
        heading: summaryHeading(partialNote(myFocus)),
        focusLabel,
        comparisonLabel,
        rows,
      }),
    );

    const H = HOLDER_METRICS;
    const h = (
      key: string,
      o: { label?: string; strong?: boolean; indent?: boolean } = {},
    ) => fromCatalogue(H, key, { ...o, audience });
    sheets.push(
      periodSheet<HolderPeriodValues>({
        name: "My investment",
        heading: [
          ...subjectLine("My investment by period"),
          ...meta([`Periods: ${columnsCaption(myPeriods, input.grain)}`]),
        ],
        periods: myPeriods,
        lines: [
          { section: "Capital" },
          h("committed"),
          h("uncalled"),
          h("contributions"),
          h("credits"),
          h("paidIn"),
          h("unreturnedCapital"),
          { section: "Distributions" },
          h("preferredReturnPaid", { label: "Preferred return" }),
          h("capitalReturned", { label: "Return of capital" }),
          h("residualPaid", { label: "Residual" }),
          h("grossDistributions", { strong: true }),
          h("defaultOffsets"),
          h("taxAdvanceOffsets"),
          h("netPaid", { strong: true }),
          h("cumulativeGrossDistributions"),
          h("dpiBps"),
          { section: "Preferred return" },
          h("preferredReturnAccrued"),
          h("preferredReturnUnpaid"),
          { section: "Units" },
          {
            label: "Preferred units",
            unit: "units",
            rule: "end",
            get: (x) => x.preferredUnits,
          },
          {
            label: "Common units",
            unit: "units",
            rule: "end",
            get: (x) => x.commonUnits,
          },
        ],
      }),
    );

    // the tables of the My investment page: every month of the holder
    const dist = distributionRows(holderMonths, restatements);
    const showOffsets = dist.total.offsets !== 0n;
    const anyRestated = dist.rows.some((r) => r.restatedOn !== null);
    const tableHeading = (title: string) => [
      ...subjectLine(title),
      { text: sourceLine(input, inProgress), style: "meta" as const },
    ];
    sheets.push({
      name: "My distributions",
      heading: tableHeading("My distributions by month"),
      columns: [
        { header: "Month", width: 14, kind: "text" },
        { header: "Preferred return", width: 17, kind: "money" },
        { header: "Return of capital", width: 17, kind: "money" },
        { header: "Residual", width: 15, kind: "money" },
        { header: "Total", width: 16, kind: "money" },
        ...(showOffsets
          ? [{ header: "Offsets", width: 15, kind: "money" as const }]
          : []),
        { header: "Net paid", width: 16, kind: "money" },
        ...(anyRestated
          ? [{ header: "Restated", width: 18, kind: "text" as const }]
          : []),
      ],
      rows: dist.rows.map((r) => ({
        cells: [
          text(r.label),
          money(centsNumber(r.preferredReturn)),
          money(centsNumber(r.returnOfCapital)),
          money(centsNumber(r.residual)),
          money(centsNumber(r.gross)),
          ...(showOffsets ? [money(centsNumber(-r.offsets))] : []),
          money(centsNumber(r.net)),
          ...(anyRestated
            ? [r.restatedOn ? text(`On ${fmtDate(r.restatedOn)}`) : null]
            : []),
        ],
      })),
      emptyText: "No distributions in the published periods.",
      totals: {
        label: "Total",
        columns: [1, 2, 3, 4, 5, ...(showOffsets ? [6] : [])],
      },
      freezeColumns: 1,
    });
    const contrib = contributionRows(holderMonths, restatements);
    const showCredits = contrib.total.credits !== 0n;
    const contribRestated = contrib.rows.some((r) => r.restatedOn !== null);
    sheets.push({
      name: "My contributions",
      heading: tableHeading("My contributions by month"),
      columns: [
        { header: "Month", width: 14, kind: "text" },
        { header: "Contributed", width: 17, kind: "money" },
        ...(showCredits
          ? [{ header: "Credited", width: 17, kind: "money" as const }]
          : []),
        ...(contribRestated
          ? [{ header: "Restated", width: 18, kind: "text" as const }]
          : []),
      ],
      rows: contrib.rows.map((r) => ({
        cells: [
          text(r.label),
          money(centsNumber(r.contributions)),
          ...(showCredits ? [money(centsNumber(r.credits))] : []),
          ...(contribRestated
            ? [r.restatedOn ? text(`On ${fmtDate(r.restatedOn)}`) : null]
            : []),
        ],
      })),
      emptyText: "No contributions in the published periods.",
      totals: { label: "Total", columns: showCredits ? [1, 2] : [1] },
      freezeColumns: 1,
    });
  }

  const firstCol = fundPeriods[0];
  const lastCol = fundPeriods[fundPeriods.length - 1];
  return {
    fileName: workbookFileName([
      input.companyName,
      mine ? "my-investment" : "financials",
      firstCol && lastCol && firstCol.key !== lastCol.key
        ? `${firstCol.key}-to-${lastCol.key}`
        : (firstCol?.key ?? ""),
    ]),
    title: `${input.companyName}: ${subject}, ${colsCaption}`,
    author: input.companyName,
    // the figures' date, not "now": two exports of one view have the same content
    createdAt: new Date(`${input.publishedThrough}T00:00:00.000Z`),
    sheets,
  };
}
