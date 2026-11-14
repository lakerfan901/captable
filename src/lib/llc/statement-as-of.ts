// The "as of" date of a member's economics page (02-economics.md E18: a
// statement's closing balances are "as of to"). Pure, relative imports only
// (tested without the `@/` alias).

import { addDays, compareIso, type IsoDate, quarterOf } from "./dates";

/** Everything since the start of the ledger. */
export const STATEMENT_BEGINNING: IsoDate = "2000-01-01";

/**
 * The statement date from the page's `?asOf=`: a real calendar date from
 * STATEMENT_BEGINNING to `today`; `today` otherwise (absent, malformed, or in
 * the future).
 */
export function statementAsOf(raw: unknown, today: IsoDate): IsoDate {
  if (typeof raw !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return today;
  }
  const parsed = new Date(`${raw}T00:00:00.000Z`);
  if (
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== raw
  ) {
    return today;
  }
  if (compareIso(raw, STATEMENT_BEGINNING) < 0) return today;
  if (compareIso(raw, today) > 0) return today;
  return raw;
}

/**
 * The four quarter statements shown up to `asOf`, newest first: the quarter
 * containing `asOf` (cut at `asOf`) and the three before it.
 */
export function statementQuarters(
  asOf: IsoDate,
): { key: string; label: string; from: IsoDate; to: IsoDate }[] {
  const quarters: { key: string; label: string; from: IsoDate; to: IsoDate }[] =
    [];
  let cursor = asOf;
  for (let i = 0; i < 4; i++) {
    const q = quarterOf(cursor);
    quarters.push({
      key: `${q.year}-Q${q.quarter}`,
      label: `Q${q.quarter} ${q.year}`,
      from: q.start,
      to: compareIso(q.end, asOf) > 0 ? asOf : q.end,
    });
    cursor = addDays(q.start, -1);
  }
  return quarters;
}
