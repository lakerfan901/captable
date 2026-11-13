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
  dedupeKey: string;
  dueOn: Ymd;
  title: string;
  status: ComplianceDeadlineStatus;
  source: string;
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
  /** New rows. One with `done: true` is created and completed by the caller. */
  create: IncomingDeadline[];
  update: { id: string; dueOn: Ymd; title: string; resetReminders: boolean }[];
  /** ids of existing OPEN rows to complete. */
  complete: string[];
}

/**
 * Plans one idempotent sync of the generated deadlines:
 * - an incoming key with no row → create;
 * - an OPEN RULE/ECONOMICS row whose incoming item is done → complete;
 * - an OPEN RULE/ECONOMICS row with another `dueOn` or title → update
 *   (`resetReminders` when `dueOn` changed);
 * - DONE and NOT_APPLICABLE rows are never touched;
 * - rows of any other source (CUSTOM, RESOLUTION, TRANSFER) are never touched;
 * - a row whose key is no longer incoming is never deleted or changed.
 */
export function planDeadlineSync(
  existing: ExistingDeadline[],
  incoming: IncomingDeadline[],
): DeadlineSyncPlan {
  const byKey = new Map(existing.map((e) => [e.dedupeKey, e]));
  const plan: DeadlineSyncPlan = { create: [], update: [], complete: [] };
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
    if (row.status !== "OPEN") continue;

    if (item.done) {
      plan.complete.push(row.id);
      continue;
    }
    const dueChanged = row.dueOn !== item.dueOn;
    if (dueChanged || row.title !== item.title) {
      plan.update.push({
        id: row.id,
        dueOn: item.dueOn,
        title: item.title,
        resetReminders: dueChanged,
      });
    }
  }
  return plan;
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
