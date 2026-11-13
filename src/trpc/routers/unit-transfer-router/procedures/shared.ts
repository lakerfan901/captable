import "server-only";
import type { UnitTransfer } from "@prisma/client";
import { TRPCError } from "@trpc/server";
import { toDateOnly } from "@/lib/date-only";
import {
  type AddBusinessDays,
  GOVERNANCE_TIME_ZONE,
  type TransferDates,
  todayInZone,
  utcDateToYmd,
  type Ymd,
} from "@/lib/governance/dates";
import {
  type CompletionContext,
  type ConsentValue,
  type RofrOutcome,
  type SecuritiesOpinion,
  type TransferDeadlineRule,
  type TransferKind,
  type TransferState,
  type TransferStatus,
  transferDeadlineKey,
} from "@/lib/governance/transfer-core";
import { addBusinessDays } from "@/lib/llc/business-days";
import { fromMicro, toMicro } from "@/lib/llc/voting";
import type {
  PrismaTransactionalClient,
  TPrismaOrTransaction,
} from "@/server/db";
import { upsertSourceDeadline } from "@/server/governance/compliance";
import { loadUnitPositions } from "@/server/governance/positions";
import { getOrCreateLlcTerm } from "@/server/llc/economics/term";
import { boundRequestMeta } from "../../ballot-router/access";

// Helpers shared by the unit transfer procedures (03-governance.md G16).
//
// Concurrency rule of this router: a procedure that changes a transfer takes
// the transfer's row lock (`loadLockedTransfer`: SELECT … FOR UPDATE), re-reads
// the row after the lock and checks its status, then writes it by ONE
// single-row guarded `update` whose `where` repeats the status it requires
// (server/governance/guarded.ts); never a guarded `updateMany`.
// Lock order: `complete` / `admit` (G16b) take ECONOMICS'
// `lockCompanyLedgerAndUnitClasses` FIRST and the transfer lock after it. No
// procedure here takes the ledger or a unit-class lock after the transfer
// lock (create, update, createNoticeCopy and cancel take no ledger lock at
// all: they never move units, and `complete` re-checks the holdings).

type Tx = PrismaTransactionalClient;
type Db = TPrismaOrTransaction;

/** Audit context with the client-controlled IP and user agent bounded. */
export function auditContext(ctx: { requestIp: string; userAgent: string }): {
  requestIp: string;
  userAgent: string;
} {
  const meta = boundRequestMeta(ctx.requestIp, ctx.userAgent);
  return { requestIp: meta.ip, userAgent: meta.userAgent };
}

export function transferNotFound(): never {
  throw new TRPCError({ code: "NOT_FOUND", message: "Transfer not found." });
}

export function badRequest(message: string): never {
  throw new TRPCError({ code: "BAD_REQUEST", message });
}

export function userName(ctx: { session: { user: { name?: string | null } } }) {
  return ctx.session.user.name ?? "A user";
}

/** The company's "today" in its own time zone. */
export function companyTodayFor(
  company: { timezone: string | null },
  now: Date,
): Ymd {
  return todayInZone(now, company.timezone || GOVERNANCE_TIME_ZONE);
}

/** The id of a transfer of the company (no lock); NOT_FOUND otherwise. */
export async function findTransferRef(
  tx: Db,
  companyId: string,
  publicId: string,
): Promise<{ id: string }> {
  const found = await tx.unitTransfer.findFirst({
    where: { publicId, companyId },
    select: { id: true },
  });
  if (!found) transferNotFound();
  return found;
}

/** Row lock on one transfer for the rest of the transaction. */
export async function lockTransfer(tx: Tx, transferId: string): Promise<void> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "UnitTransfer" WHERE "id" = ${transferId} FOR UPDATE`;
  if (rows.length === 0) transferNotFound();
}

/** Finds, locks and re-reads the transfer of the company. */
export async function loadLockedTransfer(
  tx: Tx,
  companyId: string,
  publicId: string,
) {
  const found = await findTransferRef(tx, companyId, publicId);
  await lockTransfer(tx, found.id);
  const row = await tx.unitTransfer.findFirst({
    where: { id: found.id, companyId },
  });
  if (!row) transferNotFound();
  return row;
}

export type TransferRow = UnitTransfer;

function ymd(d: Date | null): Ymd | null {
  return d === null ? null : utcDateToYmd(d);
}

/** The row as the pure rules see it (dates as Ymd, units as a 6-dp string). */
export function toTransferState(row: TransferRow): TransferState {
  if (row.unitClassKind !== "PREFERRED" && row.unitClassKind !== "COMMON") {
    throw new Error(`Unknown unit class kind ${row.unitClassKind}`);
  }
  return {
    kind: row.kind as TransferKind,
    status: row.status as TransferStatus,
    fromStakeholderId: row.fromStakeholderId,
    toStakeholderId: row.toStakeholderId,
    unitClassKind: row.unitClassKind,
    units: row.units.toFixed(6),
    noticeReceivedOn: utcDateToYmd(row.noticeReceivedOn),
    noticeCopyDueOn: ymd(row.noticeCopyDueOn),
    managerRofrEndsOn: ymd(row.managerRofrEndsOn),
    memberRofrEndsOn: ymd(row.memberRofrEndsOn),
    closeByOn: ymd(row.closeByOn),
    rofrOutcome: row.rofrOutcome as RofrOutcome,
    rofrDecidedOn: ymd(row.rofrDecidedOn),
    rofrNote: row.rofrNote,
    managerConsent: row.managerConsent as ConsentValue,
    securitiesOpinion: (row.securitiesOpinion ??
      null) as SecuritiesOpinion | null,
    priceEstablishedOn: ymd(row.priceEstablishedOn),
    purchaseCloseByOn: ymd(row.purchaseCloseByOn),
    transferNoticeOn: ymd(row.transferNoticeOn),
    effectiveOn: ymd(row.effectiveOn),
    exemptUnder71: row.exemptUnder71,
    exemptNote: row.exemptNote,
    admissionSignaturePage: row.admissionSignaturePage,
    admissionExpensesPaid: row.admissionExpensesPaid,
    admissionQualified: row.admissionQualified,
    admissionManagerConsent: row.admissionManagerConsent,
    admittedOn: ymd(row.admittedOn),
  };
}

/**
 * Units (6-dp string) the stakeholder holds of one class as of `asOf`
 * (inclusive), from G6 `loadUnitPositions` (FOUNDATION `getMemberPositions`,
 * which folds in completed transfers once G16b lands).
 */
export async function unitsHeld(
  tx: Db,
  companyId: string,
  stakeholderId: string,
  unitClassId: string,
  asOf: Ymd,
): Promise<string> {
  const positions = await loadUnitPositions(tx, companyId, asOf);
  let held = 0n;
  for (const p of positions) {
    if (p.stakeholderId === stakeholderId && p.unitClassId === unitClassId) {
      held += toMicro(p.units);
    }
  }
  return fromMicro(held);
}

/**
 * The as-of date of the transferor's units for the completion rules: the
 * effective date when the written notice of transfer is recorded (what
 * `complete` uses, so earlier completed transfers are deducted), else today.
 */
export function completionAsOf(state: TransferState, today: Ymd): Ymd {
  return state.effectiveOn ?? today;
}

/** `CompletionContext` for the pure rules (shared with `complete`, G16b). */
export async function buildCompletionContext(
  tx: Db,
  companyId: string,
  row: TransferRow,
  today: Ymd,
  asOf: Ymd,
): Promise<CompletionContext> {
  const fromUnits = await unitsHeld(
    tx,
    companyId,
    row.fromStakeholderId,
    row.unitClassId,
    asOf,
  );
  let toMemberStatus: string | null = null;
  if (row.toStakeholderId !== null) {
    const to = await tx.stakeholder.findFirst({
      where: { id: row.toStakeholderId, companyId },
      select: { memberStatus: true },
    });
    toMemberStatus = to?.memberStatus ?? null;
  }
  let linkedResolution: CompletionContext["linkedResolution"] = null;
  if (row.requiredResolutionId !== null) {
    const resolution = await tx.resolution.findFirst({
      where: { id: row.requiredResolutionId, companyId },
      select: { status: true, matterKey: true },
    });
    linkedResolution = resolution
      ? { status: resolution.status, matterKey: resolution.matterKey }
      : null;
  }
  return { today, fromUnits, toMemberStatus, linkedResolution };
}

/** ECONOMICS business days with the company's holiday settings. */
export async function companyBusinessDays(
  tx: Tx,
  companyId: string,
): Promise<AddBusinessDays> {
  const term = await getOrCreateLlcTerm(tx, companyId);
  const opts = {
    holidays: term.holidayCalendar,
    saturdayObservedOnFriday: term.saturdayHolidayObservedFriday,
    extraHolidays: term.extraHolidays.map(toDateOnly),
  };
  return (d, n) => addBusinessDays(d, n, opts);
}

interface DeadlineText {
  title: string;
  section: string;
}

/** Title and section of each transfer deadline (sections from the G14 table). */
export function transferDeadlineText(
  rule: TransferDeadlineRule,
  kind: TransferKind,
  fromName: string,
): DeadlineText {
  const involuntary = kind === "INVOLUNTARY";
  const section = involuntary ? "7.2" : "7.1";
  switch (rule) {
    case "TRANSFER_NOTICE_COPY":
      return {
        title: involuntary
          ? `Copy of the notice of Involuntary Transfer (${fromName}) to the other Preferred Members`
          : `Copy of the Transfer Notice (${fromName}) to the other Preferred Members`,
        section,
      };
    case "TRANSFER_ROFR_MANAGER":
      return {
        title: involuntary
          ? `Manager's purchase option ends (${fromName})`
          : `Manager's right of first refusal ends (${fromName})`,
        section,
      };
    case "TRANSFER_ROFR_MEMBERS":
      return {
        title: involuntary
          ? `Preferred Members' purchase option ends (${fromName})`
          : `Preferred Members' right of first refusal ends (${fromName})`,
        section,
      };
    case "TRANSFER_CLOSE_BY":
      return {
        title: `Last day to complete the transfer by ${fromName}`,
        section: "7.1",
      };
    case "TRANSFER_PURCHASE_CLOSE":
      return {
        title: `Close the purchase of ${fromName}'s Units`,
        section: "7.7",
      };
  }
}

/** Creates or refreshes one transfer deadline; returns its id. */
export async function upsertTransferDeadline(
  tx: Tx,
  input: {
    companyId: string;
    transferId: string;
    kind: TransferKind;
    fromName: string;
    rule: TransferDeadlineRule;
    dueOn: Ymd;
  },
): Promise<string> {
  const text = transferDeadlineText(input.rule, input.kind, input.fromName);
  return await upsertSourceDeadline(tx, {
    companyId: input.companyId,
    ruleKey: input.rule,
    dedupeKey: transferDeadlineKey(input.rule, input.transferId),
    title: text.title,
    section: text.section,
    dueOn: input.dueOn,
    source: "TRANSFER",
    sourceType: "UNIT_TRANSFER",
    sourceId: input.transferId,
  });
}

/** The deadlines `create` pushes for the computed dates (VOLUNTARY / INVOLUNTARY). */
export function initialDeadlines(
  dates: TransferDates,
): { rule: TransferDeadlineRule; dueOn: Ymd }[] {
  const out: { rule: TransferDeadlineRule; dueOn: Ymd }[] = [];
  if (dates.noticeCopyDueOn !== null) {
    out.push({ rule: "TRANSFER_NOTICE_COPY", dueOn: dates.noticeCopyDueOn });
  }
  if (dates.managerRofrEndsOn !== null) {
    out.push({ rule: "TRANSFER_ROFR_MANAGER", dueOn: dates.managerRofrEndsOn });
  }
  if (dates.memberRofrEndsOn !== null) {
    out.push({ rule: "TRANSFER_ROFR_MEMBERS", dueOn: dates.memberRofrEndsOn });
  }
  if (dates.closeByOn !== null) {
    out.push({ rule: "TRANSFER_CLOSE_BY", dueOn: dates.closeByOn });
  }
  if (dates.purchaseCloseByOn !== null) {
    out.push({
      rule: "TRANSFER_PURCHASE_CLOSE",
      dueOn: dates.purchaseCloseByOn,
    });
  }
  return out;
}

/** Names of the given stakeholders of the company, by id. */
export async function stakeholderNames(
  tx: Db,
  companyId: string,
  ids: (string | null)[],
): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((id): id is string => id !== null))];
  if (unique.length === 0) return new Map();
  const rows = await tx.stakeholder.findMany({
    where: { id: { in: unique }, companyId },
    select: { id: true, name: true },
  });
  return new Map(rows.map((r) => [r.id, r.name]));
}
