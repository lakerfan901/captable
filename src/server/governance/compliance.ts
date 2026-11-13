import "server-only";
import {
  type ExistingDeadline,
  economicsIncoming,
  type IncomingDeadline,
  planDeadlineSync,
  ruleIncoming,
} from "@/lib/governance/compliance-core";
import {
  addDays,
  GOVERNANCE_TIME_ZONE,
  generateRuleDeadlines,
  todayInZone,
  utcDateToYmd,
  type Ymd,
  ymdToUtcDate,
} from "@/lib/governance/dates";
import type { PrismaTransactionalClient } from "@/server/db";
import { getComplianceDates } from "@/server/llc/economics";
import { guardedWrite } from "./guarded";
import { loadLlcCompany } from "./guards";

// Compliance calendar server core (03-governance.md G14).
//
// Writes follow the governance rule for guarded writes (guarded.ts): rows are
// read first, then each one is changed by ONE single-row `update` whose
// `where` carries `status: "OPEN"`, never by a guarded `updateMany`. Creates
// go through `createMany({ skipDuplicates: true })` on the unique
// `(companyId, dedupeKey)`, so two concurrent syncs create each row once.
// No lock is taken here: the sync is safe to run concurrently and never
// touches the ledger, so it adds nothing to the lock order.

type Tx = PrismaTransactionalClient;

/** How many days ahead rule and ledger deadlines are generated. */
export const COMPLIANCE_HORIZON_DAYS = 400;
/** How far back ledger deadlines are read (overdue items stay visible). */
export const COMPLIANCE_LOOKBACK_DAYS = 30;

export const LEDGER_COMPLETION_NOTE = "Completed according to the ledger";

export interface SyncResult {
  today: Ymd;
  created: number;
  updated: number;
  completed: number;
}

/** The company's "today" in its own time zone. */
export async function companyToday(
  tx: Tx,
  companyId: string,
  now: Date,
): Promise<Ymd> {
  const company = await loadLlcCompany(tx, companyId);
  return todayInZone(now, company.timezone || GOVERNANCE_TIME_ZONE);
}

/**
 * Brings the company's RULE and ECONOMICS deadlines up to date (G14). Safe to
 * call on every read: a second run with nothing changed writes nothing.
 * Loads the company's time zone itself (jobs have no request context).
 */
export async function syncComplianceDeadlines(
  tx: Tx,
  companyId: string,
  now: Date,
): Promise<SyncResult> {
  const today = await companyToday(tx, companyId, now);

  const firstMember = await tx.stakeholder.findFirst({
    where: { companyId, memberStatus: "MEMBER", admittedOn: { not: null } },
    orderBy: { admittedOn: "asc" },
    select: { admittedOn: true },
  });
  const firstAdmittedOn = firstMember?.admittedOn
    ? utcDateToYmd(firstMember.admittedOn)
    : null;

  const rules = generateRuleDeadlines({
    firstAdmittedOn,
    today,
    horizonDays: COMPLIANCE_HORIZON_DAYS,
  }).map(ruleIncoming);
  const ledger = economicsIncoming(
    await getComplianceDates(tx, companyId, {
      from: addDays(today, -COMPLIANCE_LOOKBACK_DAYS),
      to: addDays(today, COMPLIANCE_HORIZON_DAYS),
    }),
  );
  const incoming: IncomingDeadline[] = [...rules, ...ledger];

  const rows = await tx.complianceDeadline.findMany({
    where: {
      companyId,
      dedupeKey: { in: incoming.map((d) => d.dedupeKey) },
    },
    select: {
      id: true,
      ruleKey: true,
      dedupeKey: true,
      dueOn: true,
      title: true,
      status: true,
      source: true,
    },
  });
  const existing: ExistingDeadline[] = rows.map((r) => ({
    id: r.id,
    dedupeKey: r.dedupeKey,
    dueOn: utcDateToYmd(r.dueOn),
    title: r.title,
    status: r.status,
    source: r.source,
  }));

  // K1_FINAL's date is an assumption the Manager may edit (`compliance.update`);
  // keep an edited OPEN row's date instead of resetting it to September 15.
  const keptDates = new Map(
    rows
      .filter((r) => r.ruleKey === "K1_FINAL" && r.status === "OPEN")
      .map((r) => [r.dedupeKey, utcDateToYmd(r.dueOn)]),
  );
  const effective = incoming.map((d) => {
    const kept = keptDates.get(d.dedupeKey);
    return kept === undefined ? d : { ...d, dueOn: kept };
  });

  const plan = planDeadlineSync(existing, effective);

  let created = 0;
  if (plan.create.length > 0) {
    const result = await tx.complianceDeadline.createMany({
      data: plan.create.map((d) => ({
        companyId,
        ruleKey: d.ruleKey,
        dedupeKey: d.dedupeKey,
        title: d.title,
        section: d.section,
        dueOn: ymdToUtcDate(d.dueOn),
        source: d.source,
        // An item the ledger already reports as done is created completed.
        ...(d.done
          ? {
              status: "DONE" as const,
              completedAt: now,
              satisfiedByType: "MANUAL",
              note: LEDGER_COMPLETION_NOTE,
            }
          : {}),
      })),
      skipDuplicates: true,
    });
    created = result.count;
  }

  let updated = 0;
  for (const u of plan.update) {
    const ok = await guardedWrite(() =>
      tx.complianceDeadline.update({
        where: { id: u.id, companyId, status: "OPEN" },
        data: {
          dueOn: ymdToUtcDate(u.dueOn),
          title: u.title,
          ...(u.resetReminders ? { remindedBuckets: [] } : {}),
        },
        select: { id: true },
      }),
    );
    if (ok) updated++;
  }

  let completed = 0;
  for (const id of plan.complete) {
    const ok = await guardedWrite(() =>
      tx.complianceDeadline.update({
        where: { id, companyId, status: "OPEN" },
        data: {
          status: "DONE",
          completedAt: now,
          completedById: null,
          satisfiedByType: "MANUAL",
          satisfiedById: null,
          note: LEDGER_COMPLETION_NOTE,
        },
        select: { id: true },
      }),
    );
    if (ok) completed++;
  }

  return { today, created, updated, completed };
}

export interface SourceDeadlineInput {
  companyId: string;
  ruleKey: string;
  dedupeKey: string;
  title: string;
  section: string | null;
  dueOn: Ymd;
  source: "RESOLUTION" | "TRANSFER";
  sourceType: "RESOLUTION" | "UNIT_TRANSFER";
  sourceId: string;
}

/**
 * Creates or refreshes a deadline pushed by another area (G6, G16, any
 * caller of E3), idempotent by `(companyId, dedupeKey)`. An OPEN row gets the
 * new title, section and date (reminders reset when the date moves); a DONE or
 * NOT_APPLICABLE row is left as it is. Returns the row id.
 */
export async function upsertSourceDeadline(
  tx: Tx,
  input: SourceDeadlineInput,
): Promise<string> {
  const { companyId, dedupeKey } = input;
  await tx.complianceDeadline.createMany({
    data: [
      {
        companyId,
        ruleKey: input.ruleKey,
        dedupeKey,
        title: input.title,
        section: input.section,
        dueOn: ymdToUtcDate(input.dueOn),
        source: input.source,
        sourceType: input.sourceType,
        sourceId: input.sourceId,
      },
    ],
    skipDuplicates: true,
  });
  const row = await tx.complianceDeadline.findUnique({
    where: { companyId_dedupeKey: { companyId, dedupeKey } },
    select: {
      id: true,
      status: true,
      title: true,
      section: true,
      dueOn: true,
    },
  });
  if (!row) throw new Error(`Compliance deadline ${dedupeKey} not found`);

  const dueChanged = utcDateToYmd(row.dueOn) !== input.dueOn;
  if (
    row.status === "OPEN" &&
    (dueChanged || row.title !== input.title || row.section !== input.section)
  ) {
    await guardedWrite(() =>
      tx.complianceDeadline.update({
        where: { id: row.id, companyId, status: "OPEN" },
        data: {
          title: input.title,
          section: input.section,
          dueOn: ymdToUtcDate(input.dueOn),
          ...(dueChanged ? { remindedBuckets: [] } : {}),
        },
        select: { id: true },
      }),
    );
  }
  return row.id;
}

export interface CloseSourceDeadlinesInput {
  companyId: string;
  sourceType: "RESOLUTION" | "UNIT_TRANSFER";
  sourceId: string;
  status: "DONE" | "NOT_APPLICABLE";
  note: string | null;
  /** Rule keys to leave OPEN. */
  exceptRuleKeys?: string[];
  /** What satisfied a DONE deadline; defaults to MANUAL. */
  satisfiedBy?: {
    type: "RESOLUTION" | "MEMBER_REPORT" | "DOCUMENT" | "MANUAL";
    id: string | null;
  };
  /** `Member.id` of the Manager user; null for the system. */
  completedById?: string | null;
  /** Completion time; defaults to the current time. */
  now?: Date;
}

/**
 * Closes every OPEN deadline pushed by one source row (a resolution or a unit
 * transfer), one guarded single-row write each. Returns how many were closed.
 */
export async function closeSourceDeadlines(
  tx: Tx,
  input: CloseSourceDeadlinesInput,
): Promise<number> {
  const open = await tx.complianceDeadline.findMany({
    where: {
      companyId: input.companyId,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      status: "OPEN",
      ...(input.exceptRuleKeys && input.exceptRuleKeys.length > 0
        ? { ruleKey: { notIn: input.exceptRuleKeys } }
        : {}),
    },
    select: { id: true },
  });
  const done = input.status === "DONE";
  const now = input.now ?? new Date();
  let closed = 0;
  for (const row of open) {
    const ok = await guardedWrite(() =>
      tx.complianceDeadline.update({
        where: { id: row.id, companyId: input.companyId, status: "OPEN" },
        data: {
          status: input.status,
          completedAt: now,
          completedById: input.completedById ?? null,
          satisfiedByType: done ? (input.satisfiedBy?.type ?? "MANUAL") : null,
          satisfiedById: done ? (input.satisfiedBy?.id ?? null) : null,
          note: input.note,
        },
        select: { id: true },
      }),
    );
    if (ok) closed++;
  }
  return closed;
}
