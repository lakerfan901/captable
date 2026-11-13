// Pure parts of distribution delivery (E17): the payment-list CSV and the
// preformatted values of the distribution notice. Relative imports only:
// tested by vitest, which has no `@/` alias; nothing here may import a module
// that imports "server-only".

import {
  type Cents,
  centsToDecimalString,
  type MicroUnits,
  microUnitsToDecimalString,
} from "../../../lib/llc/money";

export const DISTRIBUTION_CSV_HEADER = [
  "distribution_number",
  "payment_date",
  "stakeholder_id",
  "member_name",
  "email",
  "preferred_units",
  "gross",
  "tier_c_preferred_return",
  "tier_d_return_of_capital",
  "tier_e_residual",
  "default_offset",
  "tax_advance_offset",
  "net_payable",
  "reference",
] as const;

export interface DistributionCsvRow {
  distributionNumber: number;
  paymentDate: string;
  stakeholderId: string;
  memberName: string;
  /** The member's notice address ("" when none). */
  email: string;
  preferredUnits: MicroUnits;
  gross: Cents;
  tierC: Cents;
  tierD: Cents;
  /** tier (e) Preferred + tier (e) Common. */
  tierE: Cents;
  /** Balance + interest + costs applied under §4.9(iii). */
  defaultOffset: Cents;
  taxAdvanceOffset: Cents;
  net: Cents;
  companyName: string;
}

/** `"{companyName} DIST{number}"`. */
export function distributionReference(
  companyName: string,
  number: number,
): string {
  return `${companyName} DIST${number}`;
}

/** `distribution-{number}-{paymentDate}.csv`. */
export function distributionCsvFilename(
  number: number,
  paymentDate: string,
): string {
  return `distribution-${number}-${paymentDate}.csv`;
}

const FORMULA_START = /^[=+\-@\t\r]/;

/**
 * One RFC 4180 cell. A cell a spreadsheet could read as a formula (starting
 * with `=`, `+`, `-`, `@`, tab or CR) is prefixed with `'`; a cell containing
 * a comma, quote or line break is quoted with inner quotes doubled.
 */
export function csvCell(value: string): string {
  const safe = FORMULA_START.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** The payment list: header + one row per line (zero-net lines included), `\r\n` line ends. */
export function buildDistributionCsv(
  rows: readonly DistributionCsvRow[],
): string {
  const lines = [DISTRIBUTION_CSV_HEADER.join(",")];
  for (const r of rows) {
    lines.push(
      [
        String(r.distributionNumber),
        r.paymentDate,
        r.stakeholderId,
        r.memberName,
        r.email,
        microUnitsToDecimalString(r.preferredUnits),
        centsToDecimalString(r.gross),
        centsToDecimalString(r.tierC),
        centsToDecimalString(r.tierD),
        centsToDecimalString(r.tierE),
        centsToDecimalString(r.defaultOffset),
        centsToDecimalString(r.taxAdvanceOffset),
        centsToDecimalString(r.net),
        distributionReference(r.companyName, r.distributionNumber),
      ]
        .map(csvCell)
        .join(","),
    );
  }
  return `${lines.join("\r\n")}\r\n`;
}

/** Which lines `sendNotices` emails: not yet claimed/sent, something distributed. */
export function noticeSkipReason(line: {
  noticeSentAt: Date | null;
  grossCents: Cents;
  email: string | null;
}): "ALREADY_SENT" | "NOTHING_DISTRIBUTED" | "NO_EMAIL" | null {
  if (line.noticeSentAt !== null) return "ALREADY_SENT";
  if (line.grossCents <= 0n) return "NOTHING_DISTRIBUTED";
  if (line.email === null) return "NO_EMAIL";
  return null;
}
