// Pure rules of the portal's report procedures (04-investor-portal.md P11,
// P12, P15; package P5a). No database and no `@/` imports, so vitest runs
// them directly (`report-visibility-core.test.ts`). The database side is
// `src/server/portal/visibility-reports.ts`, the only module that applies
// them to queries.

/** The holder a portal request acts for, always taken from the access row (P10). */
export interface ReportHolder {
  companyId: string;
  stakeholderId: string;
}

/**
 * P11 as a Prisma `where` on `MemberReport`: released (`SENT`), published
 * (`publishedAt` set) and not unpublished, in the holder's company, and the
 * holder has a recipient row on it. A report sent before the portal
 * (`publishedAt` null) is not visible here; its emailed link keeps working.
 * The recipient row is also matched on the company, so a stray row of
 * another company can never make a report visible.
 */
export function visibleReportWhere(holder: ReportHolder) {
  return {
    companyId: holder.companyId,
    status: "SENT" as const,
    publishedAt: { not: null },
    unpublishedAt: null,
    recipients: {
      some: {
        stakeholderId: holder.stakeholderId,
        companyId: holder.companyId,
      },
    },
  };
}

/** P15: only quarterly and annual reports have figures to export. */
export function isPortalExportable(type: string): boolean {
  return type === "QUARTERLY" || type === "ANNUAL";
}

/**
 * The figures a holder may see: the frozen figures of a quarterly or annual
 * report, nothing for any other type (a notice or K-1 report has none).
 */
export function portalFigures<F>(
  type: string,
  frozenFigures: F | null,
): F | null {
  return isPortalExportable(type) && frozenFigures !== null
    ? withoutInternalIds(frozenFigures)
    : null;
}

/**
 * G4: the figures without internal ids. A Manager-payment line may name the
 * approving resolution by its internal `Resolution.id` (a team-side link);
 * an investor gets the line with `resolutionId: null`. Everything else is
 * returned as frozen. A value of another shape is returned unchanged.
 */
export function withoutInternalIds<F>(figures: F): F {
  if (typeof figures !== "object" || figures === null) return figures;
  const payments = (figures as { managerPayments?: unknown }).managerPayments;
  if (typeof payments !== "object" || payments === null) return figures;
  const lines = (payments as { lines?: unknown }).lines;
  if (!Array.isArray(lines)) return figures;
  return {
    ...figures,
    managerPayments: {
      ...payments,
      lines: lines.map((line: unknown) =>
        typeof line === "object" && line !== null && "resolutionId" in line
          ? { ...line, resolutionId: null }
          : line,
      ),
    },
  };
}

/** Newest release first; ties by public id so the order is stable. */
export function compareReleasedDesc(
  a: { releasedAt: Date | null; id: string },
  b: { releasedAt: Date | null; id: string },
): number {
  const ta = a.releasedAt?.getTime() ?? 0;
  const tb = b.releasedAt?.getTime() ?? 0;
  if (ta !== tb) return tb - ta;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Lifetime of a presigned storage URL handed to a portal user (P16, S19). */
export const PORTAL_FILE_URL_SECONDS = 60;
