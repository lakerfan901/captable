// View logic of the team's financial dashboard (04-investor-portal.md 6.3
// "Team side", P35, P39; package P16). Pure: relative imports only, tested.
//
// - The source switch (Live / Published / Preview as investor) kept in the
//   URL, with the permission rules applied: a role without `portal: read`
//   never gets "preview", whatever the URL says (P39; anything a role lacks
//   is absent, never greyed).
// - The status line and the drift banner (`financialDashboard.status`).
// - The rows of the Restate dialog: for each drifted month, the old
//   (published) and new (ledger) value of every changed fund figure, read
//   from the dotted paths `compareFundMonths` produces.

import { formatDateOnly } from "../../lib/date-only";
import {
  addMonthKeys,
  type MonthKey,
  periodKey,
  periodLabel,
} from "../../lib/llc/financial-periods";
import {
  FUND_METRICS,
  type FundMonthJson,
  formatDpi,
} from "../../lib/llc/financial-series";
import { humanizeCategory } from "../../lib/xlsx/report-workbook";
import { formatMoney, formatPercentBps } from "../charts/chart-format";

// ---------------------------------------------------------------------------
// Source switch

export type DashboardSource = "live" | "published" | "preview";
export type DashboardSection = "fund" | "mine";

/** The query keys of the team page (beside the period keys of P14). */
export const SOURCE_QUERY_KEYS = ["source", "holder", "section"] as const;

export interface SourceState {
  source: DashboardSource;
  /** the previewed holder (`Stakeholder.id`); null until one is picked */
  holder: string | null;
  /** preview only: the holder's "Fund performance" or "My investment" */
  section: DashboardSection;
}

export interface SourceRules {
  /** `portal: read`: "Preview as investor" exists */
  canPreview: boolean;
  /** the holders that can be previewed (ids) */
  holderIds: readonly string[];
}

/**
 * The source state from the URL, with the rules applied: preview falls back
 * to Live without `portal: read`; a holder that is not on the list is
 * dropped (the first holder is taken instead); the section is "fund" unless
 * previewing.
 */
export function parseSourceState(
  get: (key: string) => string | null,
  rules: SourceRules,
): SourceState {
  const raw = get("source");
  let source: DashboardSource =
    raw === "published" || raw === "preview" ? raw : "live";
  if (source === "preview" && !rules.canPreview) source = "live";
  let holder: string | null = null;
  if (source === "preview") {
    const wanted = get("holder");
    holder =
      wanted !== null && rules.holderIds.includes(wanted)
        ? wanted
        : (rules.holderIds[0] ?? null);
  }
  const section: DashboardSection =
    source === "preview" && get("section") === "mine" ? "mine" : "fund";
  return { source, holder, section };
}

/** Writes the state into a copy of `base` (period keys and others kept); defaults omitted. */
export function serializeSourceState(
  state: SourceState,
  base: URLSearchParams = new URLSearchParams(),
): URLSearchParams {
  const out = new URLSearchParams(base);
  for (const k of SOURCE_QUERY_KEYS) out.delete(k);
  if (state.source !== "live") out.set("source", state.source);
  if (state.source === "preview") {
    if (state.holder !== null) out.set("holder", state.holder);
    if (state.section === "mine") out.set("section", "mine");
  }
  return out;
}

export function sourceOptions(
  canPreview: boolean,
): { key: DashboardSource; label: string }[] {
  const options: { key: DashboardSource; label: string }[] = [
    { key: "live", label: "Live" },
    { key: "published", label: "Published" },
  ];
  if (canPreview)
    options.push({ key: "preview", label: "Preview as investor" });
  return options;
}

// ---------------------------------------------------------------------------
// Status line and drift

export interface StatusInput {
  snapshotThrough: string | null;
  booksClosedThrough: string | null;
  drift: readonly DriftEntry[];
}

export interface DriftEntry {
  month: MonthKey;
  fields: readonly string[];
  holders: readonly {
    stakeholderId: string;
    name: string;
    fields: readonly string[];
  }[];
  published: FundMonthJson | null;
  ledger: FundMonthJson;
}

/** "Published to investors through Jun 30, 2026 · books closed through Jun 30, 2026". */
export function statusLine(s: StatusInput): string {
  const published = s.snapshotThrough
    ? `Published to investors through ${formatDateOnly(s.snapshotThrough)}`
    : "Nothing published to investors yet";
  const books = s.booksClosedThrough
    ? `books closed through ${formatDateOnly(s.booksClosedThrough)}`
    : "books not closed";
  return `${published} · ${books}`;
}

/** "1 published month differs from the ledger" / "3 published months differ from the ledger". */
export function driftSentence(n: number): string {
  return n === 1
    ? "1 published month differs from the ledger"
    : `${n} published months differ from the ledger`;
}

export function monthLabel(month: MonthKey): string {
  return periodLabel(periodKey(month, "month"));
}

/** "Mar 2026", "Jan 2026 – Mar 2026" (the months of a range, first to last). */
export function rangeLabel(from: MonthKey, to: MonthKey): string {
  return from === to
    ? monthLabel(from)
    : `${monthLabel(from)} – ${monthLabel(to)}`;
}

// ---------------------------------------------------------------------------
// Restate rows

export interface RestateRow {
  /** the dotted path of the field */
  field: string;
  label: string;
  /** the value investors see now; "—" when the month or line has none */
  before: string;
  /** the ledger's value today, what investors will see after the Restate */
  after: string;
}

const METRIC_BY_KEY = new Map(FUND_METRICS.map((m) => [m.key, m]));

type Unit = "cents" | "bps" | "dpiBps";

/**
 * A path's head and the rest. For the breakdown lists, `compareFundMonths`
 * gives "expensesByCategory.POWER" when the line exists on one side only and
 * "expensesByCategory.POWER.amount" when it exists on both; the suffix is
 * dropped so `rest` is the category or kind.
 */
function splitPath(field: string): { head: string; rest: string } {
  const dot = field.indexOf(".");
  const head = dot < 0 ? field : field.slice(0, dot);
  let rest = dot < 0 ? "" : field.slice(dot + 1);
  if (head === "expensesByCategory") rest = rest.replace(/\.amount$/, "");
  if (head === "reservesByKind") rest = rest.replace(/\.balance$/, "");
  return { head, rest };
}

/** The label and unit of a fund field path ("expensesByCategory.POWER" → "Expenses: Power"). */
export function fieldLabel(field: string): { label: string; unit: Unit } {
  const { head, rest } = splitPath(field);
  if (head === "expensesByCategory" && rest) {
    return { label: `Expenses: ${humanizeCategory(rest)}`, unit: "cents" };
  }
  if (head === "reservesByKind" && rest) {
    return { label: `Reserves: ${humanizeCategory(rest)}`, unit: "cents" };
  }
  const metric = METRIC_BY_KEY.get(field);
  if (metric) return { label: metric.label, unit: metric.unit };
  return { label: field, unit: "cents" };
}

/** The raw value of a field path in a month record (null when absent). */
export function fieldValue(
  record: FundMonthJson | null,
  field: string,
): number | null {
  if (record === null) return null;
  const { head, rest } = splitPath(field);
  if (head === "expensesByCategory") {
    return (
      record.expensesByCategory.find((e) => e.category === rest)?.amount ?? null
    );
  }
  if (head === "reservesByKind") {
    return record.reservesByKind.find((r) => r.kind === rest)?.balance ?? null;
  }
  let v: unknown = record;
  for (const part of field.split(".")) {
    if (v === null || typeof v !== "object") return null;
    v = (v as Record<string, unknown>)[part];
  }
  return typeof v === "number" ? v : null;
}

function show(unit: Unit, raw: number | null): string {
  if (raw === null) return "—";
  if (unit === "bps") return formatPercentBps(raw);
  if (unit === "dpiBps") return formatDpi(BigInt(raw));
  return formatMoney(raw);
}

/**
 * The fund figures of a drifted month that a Restate would change. `["*"]`
 * (no published record yet: a month back-dated before the first snapshot)
 * lists every non-zero ledger figure against "—". A month where only holder
 * records differ has no fund row (the caller shows the holders instead).
 */
export function restateRows(entry: DriftEntry): RestateRow[] {
  let fields: readonly string[] = entry.fields;
  if (fields.includes("*")) {
    fields = allFields(entry.ledger).filter(
      (f) => (fieldValue(entry.ledger, f) ?? 0) !== 0,
    );
  }
  return fields
    .filter((f) => f !== "*")
    .map((field) => {
      const { label, unit } = fieldLabel(field);
      return {
        field,
        label,
        before: show(unit, fieldValue(entry.published, field)),
        after: show(unit, fieldValue(entry.ledger, field)),
      };
    });
}

const SKIP = new Set(["schemaVersion", "month", "asOf", "inProgress"]);

/** Every comparable field path of a record, in the order of the record. */
function allFields(record: FundMonthJson): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(record)) {
    if (SKIP.has(k)) continue;
    if (k === "expensesByCategory") {
      for (const e of record.expensesByCategory) out.push(`${k}.${e.category}`);
    } else if (k === "reservesByKind") {
      for (const r of record.reservesByKind) out.push(`${k}.${r.kind}`);
    } else if (v !== null && typeof v === "object") {
      for (const sub of Object.keys(v)) out.push(`${k}.${sub}`);
    } else {
      out.push(k);
    }
  }
  return out;
}

/** "2 holders' own figures change: A, B." (null when none) */
export function holdersSentence(entry: DriftEntry): string | null {
  const n = entry.holders.length;
  if (n === 0) return null;
  const names = entry.holders.map((h) => h.name).join(", ");
  return n === 1
    ? `1 holder's own figures change: ${names}.`
    : `${n} holders' own figures change: ${names}.`;
}

// ---------------------------------------------------------------------------
// Restate range

/** The drifted months inside [from, to]. */
export function driftInRange(
  drift: readonly DriftEntry[],
  from: MonthKey,
  to: MonthKey,
): DriftEntry[] {
  return drift.filter((d) => d.month >= from && d.month <= to);
}

/**
 * The range a Restate starts with: from the first to the last drifted month
 * (months in between that equal the ledger are left as they are by the
 * server and reported as unchanged). Null without drift.
 */
export function defaultRange(
  drift: readonly DriftEntry[],
): { from: MonthKey; to: MonthKey } | null {
  const months = drift.map((d) => d.month).sort();
  const first = months[0];
  const last = months[months.length - 1];
  return first && last ? { from: first, to: last } : null;
}

/** Problems of a chosen range before asking the server (null: none). */
export function rangeProblem(
  from: MonthKey,
  to: MonthKey,
  drift: readonly DriftEntry[],
): string | null {
  if (from > to) return "The first month must not be after the last month.";
  if (driftInRange(drift, from, to).length === 0) {
    return "No month in this range differs from the ledger: nothing would change.";
  }
  return null;
}

/** The sentence of the confirmation step (names the months; says "Restated"). */
export function restateConfirmSentence(months: readonly MonthKey[]): string {
  const names = months.map(monthLabel);
  const list =
    names.length <= 1
      ? (names[0] ?? "")
      : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return `${list}: investors will see the new figures for ${
    months.length === 1 ? "this month" : "these months"
  }, marked "Restated" with today's date. The figures they saw before are kept on record but no longer shown. Released reports are not changed.`;
}

/** The result toast of a restate. */
export function restateResultText(res: {
  months: readonly { month: MonthKey }[];
  unchanged: readonly MonthKey[];
}): string {
  const n = res.months.length;
  const lead =
    n === 1
      ? `Restated ${monthLabel(res.months[0]?.month as MonthKey)}.`
      : `Restated ${n} months.`;
  const u = res.unchanged.length;
  if (u === 0) return lead;
  return u === 1
    ? `${lead} 1 month already matched the ledger and was left as it is.`
    : `${lead} ${u} months already matched the ledger and were left as they are.`;
}

/** The month options of the range pickers: every month from the first to the last drifted one (inclusive). */
export function rangeOptions(drift: readonly DriftEntry[]): MonthKey[] {
  const r = defaultRange(drift);
  if (r === null) return [];
  const out: MonthKey[] = [];
  for (let m = r.from; m <= r.to; m = addMonthKeys(m, 1)) out.push(m);
  return out;
}
