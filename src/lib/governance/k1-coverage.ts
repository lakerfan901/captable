// Who needs a Schedule K-1 for a fiscal year, and whether every one of them
// has been delivered one (03-governance.md R25, R22a; OA 8.2, 1.8). Pure:
// relative imports only (tested without the `@/` alias).
//
// Rule applied: the K-1 deadlines of a fiscal year (`K1_TARGET:{fy}`,
// `K1_FINAL:{fy}`) are complete only when EVERY holder that needs a K-1 for
// that year has been delivered one: it is a recipient of a SENT TAX_K1
// report of that year whose email the mail server accepted. A holder
// needs one when it held Units (any class, more than zero) at any time during
// the fiscal year (a partner during the year is allocated income, R22a), and
// is not a PROSPECT. Units change only on ledger dates, so "at any time" is
// checked at the first day of the year and at every date in the year on
// which a receipt or a transfer could change a holding.

import { microUnitsFromDecimal } from "../llc/money";

export interface K1Holder {
  stakeholderId: string;
  name: string;
}

export interface K1Coverage {
  fiscalYear: number;
  /** Holders that need a K-1 for the year, by name. */
  needed: (K1Holder & { delivered: boolean; queued: boolean })[];
  /** Names of the holders still without a delivered K-1. */
  missing: string[];
  complete: boolean;
}

/** January 1 and December 31 of a (calendar) fiscal year. */
export function fiscalYearBounds(fiscalYear: number): {
  start: string;
  end: string;
} {
  const y = String(fiscalYear).padStart(4, "0");
  return { start: `${y}-01-01`, end: `${y}-12-31` };
}

/**
 * The dates on which holdings are checked: the year's first day, plus every
 * given ledger date inside the year (sorted, unique). Dates outside the year
 * are ignored.
 */
export function holdingCheckDates(
  fiscalYear: number,
  ledgerDates: readonly string[],
): string[] {
  const { start, end } = fiscalYearBounds(fiscalYear);
  const inYear = ledgerDates.filter((d) => d > start && d <= end);
  return [...new Set([start, ...inYear])].sort();
}

/** Holders with more than zero Units of any class in at least one snapshot. */
export function holderIdsFromSnapshots(
  snapshots: readonly (readonly { stakeholderId: string; units: string }[])[],
): Set<string> {
  const out = new Set<string>();
  for (const rows of snapshots) {
    for (const r of rows) {
      if (microUnitsFromDecimal(r.units) > 0n) out.add(r.stakeholderId);
    }
  }
  return out;
}

/**
 * `delivered`: holders whose K-1 email the mail server ACCEPTED (a recipient
 * of a sent K-1 report of the year with `sentAt` set). `queued`: holders that
 * are recipients but whose email has not gone out yet; they do not count.
 */
export function k1Coverage(
  fiscalYear: number,
  needed: readonly K1Holder[],
  delivered: ReadonlySet<string>,
  queued: ReadonlySet<string> = new Set(),
): K1Coverage {
  const rows = [...needed]
    .sort(
      (a, b) =>
        a.name.localeCompare(b.name, "en") ||
        (a.stakeholderId < b.stakeholderId ? -1 : 1),
    )
    .map((h) => {
      const isDelivered = delivered.has(h.stakeholderId);
      return {
        ...h,
        delivered: isDelivered,
        queued: !isDelivered && queued.has(h.stakeholderId),
      };
    });
  const missing = rows.filter((r) => !r.delivered).map((r) => r.name);
  return {
    fiscalYear,
    needed: rows,
    missing,
    // A year in which nobody held Units needs no K-1 and is not completed
    // by a report either (nothing to deliver): it stays for the Manager.
    complete: rows.length > 0 && missing.length === 0,
  };
}
