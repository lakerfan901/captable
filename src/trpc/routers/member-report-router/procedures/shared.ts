import "server-only";
import { TRPCError } from "@trpc/server";
import { utcDateToYmd } from "@/lib/governance/dates";
import {
  EMPTY_FIGURES,
  type MemberReportType,
  type ReportFigures,
  ReportFiguresSchema,
} from "@/lib/governance/report-figures";
import { type RichDoc, RichDocSchema } from "@/lib/governance/rich-doc";
import type { PrismaTransactionalClient } from "@/server/db";
import { boundRequestMeta } from "../../ballot-router/access";

// Helpers shared by the member-report procedures (03-governance.md G12).
//
// Concurrency rule of this router: every procedure that changes a report or
// its children takes the report's row lock (`lockReport`, SELECT … FOR
// UPDATE) and re-reads the row AFTER the lock, so an edit, an attachment
// change or a delete racing `send` waits for it and then sees SENT. The
// writes themselves are single-row guarded writes (never a guarded
// `updateMany` / `deleteMany`, see server/governance/guarded.ts).
// Lock order: `send` takes ECONOMICS' `lockCompanyLedgerAndUnitClasses` (the
// ledger lock, then the unit-class locks) BEFORE the report lock (it closes
// the books and reads the register); no procedure here takes the ledger or
// a unit-class lock after the report lock.

/** Audit context with the client-controlled IP and user agent bounded (M3). */
export function auditContext(ctx: { requestIp: string; userAgent: string }): {
  requestIp: string;
  userAgent: string;
} {
  const meta = boundRequestMeta(ctx.requestIp, ctx.userAgent);
  return { requestIp: meta.ip, userAgent: meta.userAgent };
}

export function reportNotFound(): never {
  throw new TRPCError({ code: "NOT_FOUND", message: "Report not found." });
}

export function badRequest(message: string): never {
  throw new TRPCError({ code: "BAD_REQUEST", message });
}

/** Row lock on one report for the rest of the transaction. */
export async function lockReport(
  tx: PrismaTransactionalClient,
  reportId: string,
): Promise<void> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "MemberReport" WHERE "id" = ${reportId} FOR UPDATE`;
  if (rows.length === 0) reportNotFound();
}

/** The id and type of a report of the company (no lock); NOT_FOUND otherwise. */
export async function findReportRef(
  tx: PrismaTransactionalClient,
  companyId: string,
  publicId: string,
) {
  const found = await tx.memberReport.findFirst({
    where: { publicId, companyId },
    select: { id: true, type: true },
  });
  if (!found) reportNotFound();
  return found;
}

/** Finds, locks and re-reads the report of the company. */
export async function loadLockedReport(
  tx: PrismaTransactionalClient,
  companyId: string,
  publicId: string,
) {
  const found = await findReportRef(tx, companyId, publicId);
  await lockReport(tx, found.id);
  const report = await tx.memberReport.findFirst({
    where: { id: found.id, companyId },
  });
  if (!report) reportNotFound();
  return report;
}

export function ymdOrNull(value: Date | null): string | null {
  return value === null ? null : utcDateToYmd(value);
}

export function usesFigures(type: string): boolean {
  return type === "QUARTERLY" || type === "ANNUAL";
}

/**
 * Stored figures of a QUARTERLY / ANNUAL report, or null when they do not
 * parse (an empty `{}` or a corrupted row). TAX_K1 / NOTICE: EMPTY_FIGURES.
 */
export function storedFigures(
  type: string,
  figures: unknown,
): ReportFigures | null {
  if (!usesFigures(type)) return EMPTY_FIGURES;
  const parsed = ReportFiguresSchema.safeParse(figures);
  return parsed.success ? parsed.data : null;
}

export function asReportType(type: string): MemberReportType {
  return type as MemberReportType;
}

/** What `send` froze (and hashed); read by `get` after send. */
export interface FrozenReportContent {
  title: string;
  figures: ReportFigures | null;
  doc: RichDoc;
}

export function readFrozenContent(
  frozenContent: unknown,
): FrozenReportContent | null {
  if (
    frozenContent === null ||
    typeof frozenContent !== "object" ||
    Array.isArray(frozenContent)
  ) {
    return null;
  }
  const raw = frozenContent as Record<string, unknown>;
  const doc = RichDocSchema.safeParse(raw.doc);
  if (typeof raw.title !== "string" || !doc.success) return null;
  let figures: ReportFigures | null = null;
  if (raw.figures !== undefined && raw.figures !== null) {
    const parsed = ReportFiguresSchema.safeParse(raw.figures);
    if (!parsed.success) return null;
    figures = parsed.data;
  }
  return { title: raw.title, figures, doc: doc.data };
}
