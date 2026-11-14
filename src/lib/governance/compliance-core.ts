// Compliance calendar core (03-governance.md G14). Pure: no database, no
// clock, relative imports only (vitest has no `@/` alias).

import type { AddBusinessDays, DeadlineSpec, Ymd } from "./dates";

export type ComplianceDeadlineStatus = "OPEN" | "DONE" | "NOT_APPLICABLE";

/** `ComplianceDeadline.source` values. */
export type ComplianceSource =
  | "RULE"
  | "ECONOMICS"
  | "RESOLUTION"
  | "TRANSFER"
  | "MANUAL";

/** Only rows of these sources are kept in sync; every other row is left alone. */
export const SYNCED_SOURCES: readonly ComplianceSource[] = [
  "RULE",
  "ECONOMICS",
];

export interface ExistingDeadline {
  id: string;
  /** For ECONOMICS rows: the ECONOMICS kind. */
  ruleKey: string;
  dedupeKey: string;
  dueOn: Ymd;
  title: string;
  status: ComplianceDeadlineStatus;
  source: string;
  /** Closed by the sync itself, not by a user (see `isSyncClosure`). */
  closedBySync: boolean;
}

/** Note on a row the sync completed because the ledger says it is done. */
export const LEDGER_COMPLETION_NOTE = "Completed according to the ledger";
/** Prefix of the note on a row the sync superseded (its date moved). */
export const SUPERSEDED_NOTE_PREFIX = "Superseded: date changed to ";

export function supersededNote(newDueOn: Ymd): string {
  return `${SUPERSEDED_NOTE_PREFIX}${newDueOn}`;
}

/**
 * ECONOMICS kinds whose key carries the due date (`${kind}:${dueOn}`): when
 * the date moves the key changes, so the old row is superseded by the new one.
 */
export const DATE_KEYED_KINDS: readonly string[] = [
  "BALANCE_OUTSIDE_DATE",
  "REPLACEMENT_FUNDER_OUTSIDE_DATE",
  "OCD_NOTICE_DUE",
  "EXTENSION_REQUEST_DUE",
  "TARGET_SALE_DATE",
  "FINAL_CLOSING_DATE",
];

/**
 * True for a row the sync closed (never one a user closed): no
 * `completedById`, and the ledger completion marking or the superseded note.
 */
export function isSyncClosure(row: {
  status: ComplianceDeadlineStatus;
  completedById: string | null;
  satisfiedByType: string | null;
  note: string | null;
}): boolean {
  if (row.completedById !== null) return false;
  if (row.status === "DONE") {
    return (
      row.satisfiedByType === "MANUAL" && row.note === LEDGER_COMPLETION_NOTE
    );
  }
  if (row.status === "NOT_APPLICABLE") {
    return (
      row.satisfiedByType === null &&
      (row.note ?? "").startsWith(SUPERSEDED_NOTE_PREFIX)
    );
  }
  return false;
}

export interface IncomingDeadline {
  ruleKey: string;
  dedupeKey: string;
  title: string;
  section: string | null;
  dueOn: Ymd;
  source: "RULE" | "ECONOMICS";
  done: boolean;
}

export interface DeadlineSyncPlan {
  /** New rows. One with `done: true` is created already completed. */
  create: IncomingDeadline[];
  update: { id: string; dueOn: Ymd; title: string; resetReminders: boolean }[];
  /** ids of existing OPEN rows the ledger reports done. */
  complete: string[];
  /** ids of OPEN ECONOMICS rows in the feed's range that left the feed (satisfied). */
  closeMissing: string[];
  /** OPEN date-keyed ECONOMICS rows replaced by a row of the same kind with another date. */
  supersede: { id: string; note: string }[];
  /** Rows the sync closed that the ledger reports open again. */
  reopen: { id: string; dueOn: Ymd; title: string; resetReminders: boolean }[];
}

/**
 * Plans one idempotent sync of the generated deadlines:
 * - an incoming key with no row → create;
 * - an OPEN RULE/ECONOMICS row whose incoming item is done → complete;
 * - an OPEN RULE/ECONOMICS row with another `dueOn` or title → update
 *   (`resetReminders` when `dueOn` changed);
 * - a row the sync closed (`closedBySync`) whose incoming item is not done →
 *   reopen; DONE and NOT_APPLICABLE rows a user closed are never touched;
 * - rows of any other source (CUSTOM, RESOLUTION, TRANSFER) are never touched;
 * - with `ledgerRange` (the range the ECONOMICS feed was read for): an OPEN
 *   ECONOMICS row absent from the feed whose `dueOn` lies in that range is
 *   superseded (NOT_APPLICABLE) when it is of a date-keyed kind and the feed
 *   (or `farReplacements`) has a row of the same kind with another key, and
 *   otherwise completed (the ledger no longer reports it, so it is satisfied);
 * - `farReplacements` (see `splitLedgerFeed`) are date-keyed ledger items
 *   beyond the calendar horizon: they only count as replacements and are
 *   never created;
 * - nothing is ever deleted.
 */
export function planDeadlineSync(
  existing: ExistingDeadline[],
  incoming: IncomingDeadline[],
  ledgerRange?: { from: Ymd; to: Ymd },
  farReplacements: IncomingDeadline[] = [],
): DeadlineSyncPlan {
  const byKey = new Map(existing.map((e) => [e.dedupeKey, e]));
  const plan: DeadlineSyncPlan = {
    create: [],
    update: [],
    complete: [],
    closeMissing: [],
    supersede: [],
    reopen: [],
  };
  const seen = new Set<string>();

  for (const item of incoming) {
    if (seen.has(item.dedupeKey)) continue;
    seen.add(item.dedupeKey);

    const row = byKey.get(item.dedupeKey);
    if (row === undefined) {
      plan.create.push(item);
      continue;
    }
    if (!SYNCED_SOURCES.includes(row.source as ComplianceSource)) continue;
    const dueChanged = row.dueOn !== item.dueOn;

    if (row.status !== "OPEN") {
      if (row.closedBySync && !item.done) {
        plan.reopen.push({
          id: row.id,
          dueOn: item.dueOn,
          title: item.title,
          resetReminders: dueChanged,
        });
      }
      continue;
    }

    if (item.done) {
      plan.complete.push(row.id);
      continue;
    }
    if (dueChanged || row.title !== item.title) {
      plan.update.push({
        id: row.id,
        dueOn: item.dueOn,
        title: item.title,
        resetReminders: dueChanged,
      });
    }
  }

  if (ledgerRange !== undefined) {
    const ledger = [
      ...incoming.filter((d) => d.source === "ECONOMICS"),
      ...farReplacements,
    ];
    for (const row of existing) {
      if (row.source !== "ECONOMICS" || row.status !== "OPEN") continue;
      if (seen.has(row.dedupeKey)) continue;
      if (row.dueOn < ledgerRange.from || row.dueOn > ledgerRange.to) continue;
      const replacement = DATE_KEYED_KINDS.includes(row.ruleKey)
        ? ledger.find(
            (d) => d.ruleKey === row.ruleKey && d.dedupeKey !== row.dedupeKey,
          )
        : undefined;
      if (replacement !== undefined) {
        plan.supersede.push({
          id: row.id,
          note: supersededNote(replacement.dueOn),
        });
      } else {
        plan.closeMissing.push(row.id);
      }
    }
  }
  return plan;
}

/**
 * Splits a ledger feed read beyond the calendar horizon (`horizonEnd`):
 * items due on or before it are synced as usual; of the items after it only
 * the date-keyed kinds are kept, as `farReplacements` for `planDeadlineSync`.
 * A date-keyed item (for example the Target Sale Date after a term
 * extension) can move past the horizon; its old row must then be superseded,
 * not completed as if the ledger had satisfied it. Far items are not created:
 * the calendar shows the next `horizonEnd` only, and the row appears once the
 * date comes within it.
 */
export function splitLedgerFeed(
  ledger: IncomingDeadline[],
  horizonEnd: Ymd,
): { inHorizon: IncomingDeadline[]; farReplacements: IncomingDeadline[] } {
  const inHorizon: IncomingDeadline[] = [];
  const farReplacements: IncomingDeadline[] = [];
  for (const item of ledger) {
    if (item.dueOn <= horizonEnd) inHorizon.push(item);
    else if (DATE_KEYED_KINDS.includes(item.ruleKey))
      farReplacements.push(item);
  }
  return { inHorizon, farReplacements };
}

/** A G3 rule deadline as an incoming sync item. */
export function ruleIncoming(spec: DeadlineSpec): IncomingDeadline {
  return {
    ruleKey: spec.ruleKey,
    dedupeKey: spec.dedupeKey,
    title: spec.title,
    section: spec.section,
    dueOn: spec.dueOn,
    source: "RULE",
    done: false,
  };
}

/** The fields of an ECONOMICS `getComplianceDates` item the sync reads. */
export interface EconomicsComplianceItem {
  key: string;
  kind: string;
  dueOn: Ymd;
  label: string;
  oaSection: string;
  status: string;
}

/** "§5.6(a)" → "5.6(a)" (sections are stored without the sign; the UI prints "Section …"). */
export function normalizeSection(section: string | null): string | null {
  if (section === null) return null;
  const trimmed = section.replace(/^\s*§\s*/, "").trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * ECONOMICS items as incoming sync items: drops `QUARTERLY_REPORT_DEADLINE`
 * (governance's own QUARTERLY_REPORT rule is authoritative) and `INFO` items;
 * DONE and NOT_REQUIRED count as done.
 */
export function economicsIncoming(
  items: EconomicsComplianceItem[],
): IncomingDeadline[] {
  return items
    .filter((d) => d.kind !== "QUARTERLY_REPORT_DEADLINE")
    .filter((d) => d.status !== "INFO")
    .map((d) => ({
      ruleKey: d.kind,
      dedupeKey: `E:${d.key}`,
      title: d.label,
      section: normalizeSection(d.oaSection),
      dueOn: d.dueOn,
      source: "ECONOMICS" as const,
      done: d.status === "DONE" || d.status === "NOT_REQUIRED",
    }));
}

export interface CustomDeadlineTemplate {
  title: string;
  section: string | null;
  /** null: the user enters the due date. */
  offset: { days?: number; businessDays?: number } | null;
}

export const CUSTOM_DEADLINE_TEMPLATES = {
  TAX_PROCEEDING_NOTICE: {
    title: "Notify Members of audit or tax proceeding",
    section: "9.2",
    offset: { days: 10 },
  },
  SPECIAL_MEETING_NOTICE: {
    title: "Give notice of the requested special meeting",
    section: "6.4",
    offset: { days: 10 },
  },
  SPECIAL_MEETING_HELD: {
    title: "Hold the requested special meeting",
    section: "6.4",
    offset: { days: 60 },
  },
  MANAGER_RESIGNATION_EFFECTIVE: {
    title: "Manager resignation notice period ends",
    section: "6.20",
    offset: { days: 90 },
  },
  SUCCESSOR_ACCEPTANCE: {
    title: "Successor Manager must accept or the LLC dissolves",
    section: "6.20; 11.1(e)",
    offset: { days: 180 },
  },
  PO_TITLE_DOCUMENTS: {
    title:
      "Deliver vendor invoice, proof of payment and bill of sale to the LLC",
    section: "6.16(i)(2)",
    offset: { businessDays: 10 },
  },
  PO_FUNDS_REMIT: {
    title: "Remit LLC funds held as purchasing agent to the vendor",
    section: "6.16(e)",
    offset: { businessDays: 5 },
  },
  SUBSCRIPTION_ACCEPTANCE: {
    title: "Accept the subscription or return the unaccepted part",
    section: "4.8",
    offset: { businessDays: 10 },
  },
  STATE_ANNUAL_REPORT: {
    title: "Wyoming annual report (statutory; not in the Operating Agreement)",
    section: null,
    offset: null,
  },
  FORM_1065: {
    title: "File Form 1065 or an extension (statutory)",
    section: null,
    offset: null,
  },
} as const satisfies Record<string, CustomDeadlineTemplate>;

export type CustomDeadlineTemplateKey = keyof typeof CUSTOM_DEADLINE_TEMPLATES;

export const CUSTOM_DEADLINE_TEMPLATE_KEYS = Object.keys(
  CUSTOM_DEADLINE_TEMPLATES,
) as [CustomDeadlineTemplateKey, ...CustomDeadlineTemplateKey[]];

/**
 * Due date of a template from its trigger date, or null when the template has
 * no offset (the user enters the due date). Business-day offsets use the
 * injected ECONOMICS `addBusinessDays`; calendar offsets are not rolled.
 */
export function templateDueOn(
  template: CustomDeadlineTemplate,
  triggerOn: Ymd,
  addBusinessDays: AddBusinessDays,
  addDays: (ymd: Ymd, n: number) => Ymd,
): Ymd | null {
  const offset = template.offset;
  if (offset === null) return null;
  let due = triggerOn;
  if (offset.days) due = addDays(due, offset.days);
  if (offset.businessDays) due = addBusinessDays(due, offset.businessDays);
  return due;
}
