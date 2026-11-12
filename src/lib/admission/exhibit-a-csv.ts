/**
 * Exhibit A CSV import (F14): pure parser and per-row validation.
 *
 * Relative imports only (unit tested). Nothing here knows "today" or the
 * database: the offering rules (minimum, cap, Final Closing Date, 40%
 * installment, future dates, existing members) are applied by the server
 * procedure `stakeholder.importExhibitA` with the same rule functions as
 * manual entry.
 *
 * Every invalid row is reported; rows with an error are not returned, so a
 * caller that imports only when `errors` is empty imports nothing from a
 * file with a bad row.
 */
import Papa from "papaparse";
import { microUnitsForAmount } from "../llc/units";
import { CENTS_MAX, formatCents, parseDollarsToCents } from "../money";
import states from "../states";

export const EXHIBIT_A_MAX_ROWS = 100;

export type ExhibitAHolderType = "INDIVIDUAL" | "JOINT" | "TRUST" | "ENTITY";

export const EXHIBIT_A_ACCREDITATION_BASES = [
  "NET_WORTH",
  "INCOME",
  "LICENSE",
  "ENTITY_ASSETS",
  "ENTITY_ALL_OWNERS_ACCREDITED",
  "TRUST_ASSETS",
] as const;
export type ExhibitAAccreditationBasis =
  (typeof EXHIBIT_A_ACCREDITATION_BASES)[number];

export type ExhibitARow = {
  line: number;
  name: string;
  email: string;
  committedCents: bigint;
  paidCents: bigint;
  admittedOn: string;
  receiptDate: string;
  streetAddress?: string;
  city?: string;
  state?: string;
  zipcode?: string;
  holderType: ExhibitAHolderType;
  residenceState?: string;
  accreditationBasis?: ExhibitAAccreditationBasis;
  signerName?: string;
  signerTitle?: string;
  isInsider: boolean;
  minimumWaived: boolean;
  wireReference?: string;
  /** Whether the file filled these cells (otherwise the default applies). */
  holderTypeSupplied: boolean;
  isInsiderSupplied: boolean;
};

export type ExhibitAError = { line: number; message: string };

export type ExhibitAParseResult = {
  rows: ExhibitARow[];
  errors: ExhibitAError[];
};

/** Column headers, as written in the template (matched case-insensitively). */
export const EXHIBIT_A_COLUMNS = {
  member: "Member",
  committed: "Capital Contribution Committed",
  paid: "Paid to Date",
  units: "Preferred Units",
  pct: "Preferred Unit Percentage Interest",
  admitted: "Date Admitted",
  notice: "Notice Address and Email",
  email: "Email",
  street: "Street Address",
  city: "City",
  state: "State",
  zip: "Zip",
  holderType: "Holder Type",
  residence: "State of Residence",
  accreditation: "Accreditation Basis",
  signerName: "Signer Name",
  signerTitle: "Signer Title",
  insider: "Insider",
  waived: "Minimum Waived",
  receiptDate: "Receipt Date",
  wire: "Wire Reference",
} as const;

type ColumnKey = keyof typeof EXHIBIT_A_COLUMNS;

const KEY_BY_HEADER = new Map<string, ColumnKey>(
  (Object.entries(EXHIBIT_A_COLUMNS) as [ColumnKey, string][]).map(
    ([key, header]) => [header.toLowerCase(), key],
  ),
);

const EXAMPLE_ROW: Record<ColumnKey, string> = {
  member: "Jane Doe",
  committed: "$250,000.00",
  paid: "$100,000.00",
  units: "100",
  pct: "",
  admitted: "2026-11-10",
  notice: "1 Main St, Frankfort, KY 40601; jane@example.com",
  email: "",
  street: "",
  city: "",
  state: "",
  zip: "",
  holderType: "individual",
  residence: "KY",
  accreditation: "NET_WORTH",
  signerName: "",
  signerTitle: "",
  insider: "no",
  waived: "no",
  receiptDate: "2026-11-10",
  wire: "",
};

/** Header row plus one example line, for the "Download template" button. */
export function exhibitATemplateCsv(): string {
  const keys = Object.keys(EXHIBIT_A_COLUMNS) as ColumnKey[];
  return `${Papa.unparse({
    fields: keys.map((k) => EXHIBIT_A_COLUMNS[k]),
    data: [keys.map((k) => EXAMPLE_ROW[k])],
  })}\n`;
}

const STATE_CODES = new Set(states.map((s) => s.abbreviation));
const EMAIL_TOKEN_RE = /[^\s;,<>()"']+@[^\s;,<>()"']+\.[^\s;,<>()"']+/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const US_DATE_RE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;
const UNITS_RE = /^\d+(\.\d{1,6})?$/;

function realDate(y: number, m: number, d: number): string | null {
  const date = new Date(Date.UTC(y, m - 1, d));
  if (
    date.getUTCFullYear() !== y ||
    date.getUTCMonth() !== m - 1 ||
    date.getUTCDate() !== d
  ) {
    return null;
  }
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** `YYYY-MM-DD` or `M/D/YYYY`, a real calendar date; null otherwise. */
export function parseExhibitADate(text: string): string | null {
  const s = text.trim();
  const iso = ISO_DATE_RE.exec(s);
  if (iso) return realDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  const us = US_DATE_RE.exec(s);
  if (us) return realDate(Number(us[3]), Number(us[1]), Number(us[2]));
  return null;
}

/** "41" / "40.5" → micro-units; null when not a number with ≤ 6 decimals. */
function parseMicroUnits(text: string): bigint | null {
  const s = text.trim().replace(/,/g, "");
  if (!UNITS_RE.test(s)) return null;
  const [whole = "0", frac = ""] = s.split(".");
  return BigInt(whole) * 1_000_000n + BigInt(frac.padEnd(6, "0"));
}

function formatMicroUnits(micro: bigint): string {
  const whole = micro / 1_000_000n;
  const frac = (micro % 1_000_000n).toString().padStart(6, "0");
  const trimmed = frac.replace(/0+$/, "");
  return trimmed === "" ? whole.toString() : `${whole}.${trimmed}`;
}

/** Splits the combined Exhibit A column into email and address. */
export function splitNoticeAddress(text: string): {
  email: string | null;
  address: string;
} {
  const match = EMAIL_TOKEN_RE.exec(text);
  if (!match) return { email: null, address: trimSeparators(text) };
  const rest =
    text.slice(0, match.index) + text.slice(match.index + match[0].length);
  return { email: match[0].toLowerCase(), address: trimSeparators(rest) };
}

function trimSeparators(text: string): string {
  return text.replace(/^[\s;,]+|[\s;,]+$/g, "");
}

function parseYesNo(text: string): boolean | null {
  const s = text.trim().toLowerCase();
  if (s === "" || s === "no") return false;
  if (s === "yes") return true;
  return null;
}

const HOLDER_TYPES: Record<string, ExhibitAHolderType> = {
  individual: "INDIVIDUAL",
  joint: "JOINT",
  trust: "TRUST",
  entity: "ENTITY",
};

/** Line number (1-based) of the first character at or after `index`. */
function lineAt(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) {
    if (text[i] === "\n") line++;
  }
  return line;
}

export function parseExhibitACsv(
  input: string,
  opts: { pricePerUnitCents: bigint },
): ExhibitAParseResult {
  const text = input.replace(/^﻿/, "");
  const errors: ExhibitAError[] = [];
  const rows: ExhibitARow[] = [];
  if (opts.pricePerUnitCents <= 0n) {
    return {
      rows,
      errors: [{ line: 1, message: "The price per unit is not set." }],
    };
  }

  type RawRow = { line: number; data: Record<string, string>; extra: boolean };
  const raw: RawRow[] = [];
  let fields: string[] = [];
  const firstBreak = text.indexOf("\n");
  let prevEnd = firstBreak === -1 ? text.length : firstBreak;

  Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h) => h.trim().toLowerCase(),
    step: (result) => {
      if (fields.length === 0) fields = result.meta.fields ?? [];
      let start = prevEnd;
      while (
        start < text.length &&
        (text[start] === "\n" || text[start] === "\r")
      ) {
        start++;
      }
      // Lines that are blank (or only commas) are skipped by Papa; find the
      // first non-blank line for the row.
      const line = lineAt(text, start);
      prevEnd = result.meta.cursor;
      for (const e of result.errors) {
        if (e.type === "Quotes") {
          errors.push({ line, message: `Line ${line}: ${e.message}.` });
        }
      }
      raw.push({
        line,
        data: result.data,
        extra: result.errors.some((e) => e.code === "TooManyFields"),
      });
    },
  });

  // Header checks.
  const present = new Set<ColumnKey>();
  const unknown: string[] = [];
  for (const f of fields) {
    if (f === "") continue;
    const key = KEY_BY_HEADER.get(f);
    if (key) present.add(key);
    else unknown.push(f);
  }
  const headerErrors: string[] = [];
  for (const key of ["member", "committed", "paid", "admitted"] as const) {
    if (!present.has(key)) {
      headerErrors.push(`The column "${EXHIBIT_A_COLUMNS[key]}" is missing.`);
    }
  }
  if (!present.has("notice") && !present.has("email")) {
    headerErrors.push(
      `The column "${EXHIBIT_A_COLUMNS.notice}" (or "${EXHIBIT_A_COLUMNS.email}") is missing.`,
    );
  }
  if (unknown.length > 0) {
    headerErrors.push(
      `Unknown column${unknown.length > 1 ? "s" : ""}: ${unknown.map((u) => `"${u}"`).join(", ")}. Use the template's column names.`,
    );
  }
  if (headerErrors.length > 0) {
    return {
      rows: [],
      errors: headerErrors.map((message) => ({ line: 1, message })),
    };
  }

  const cell = (r: RawRow, key: ColumnKey): string =>
    (r.data[EXHIBIT_A_COLUMNS[key].toLowerCase()] ?? "").trim();

  const dataRows = raw.filter((r) => !cell(r, "member").startsWith("Total"));
  if (dataRows.length > EXHIBIT_A_MAX_ROWS) {
    return {
      rows: [],
      errors: [
        {
          line: 1,
          message: `The file has ${dataRows.length} member rows; at most ${EXHIBIT_A_MAX_ROWS} can be imported at once.`,
        },
      ],
    };
  }
  if (dataRows.length === 0 && errors.length === 0) {
    errors.push({ line: 1, message: "The file has no member rows." });
  }

  const seenEmails = new Map<string, number>();
  for (const r of dataRows) {
    const line = r.line;
    const rowErrors: string[] = [];
    const fail = (message: string) => rowErrors.push(message);

    if (r.extra) {
      fail(
        "The row has more values than the header. Put amounts and addresses that contain commas in double quotes.",
      );
    }

    const name = cell(r, "member");
    if (name === "") fail(`"${EXHIBIT_A_COLUMNS.member}" is empty.`);
    else if (name.length > 200)
      fail("The member name is longer than 200 characters.");

    const money = (key: "committed" | "paid"): bigint | null => {
      const value = cell(r, key);
      const cents = parseDollarsToCents(value);
      if (cents === null || cents > BigInt(CENTS_MAX)) {
        fail(
          `"${EXHIBIT_A_COLUMNS[key]}" ${value === "" ? "is empty" : `"${value}" is not a dollar amount`}.`,
        );
        return null;
      }
      return cents;
    };
    const committedCents = money("committed");
    const paidCents = money("paid");
    if (committedCents !== null && committedCents === 0n) {
      fail(`"${EXHIBIT_A_COLUMNS.committed}" must be more than zero.`);
    }
    if (
      committedCents !== null &&
      paidCents !== null &&
      paidCents > committedCents
    ) {
      fail(
        `Paid to Date ${formatCents(paidCents)} is more than the ${formatCents(committedCents)} committed.`,
      );
    }

    const unitsText = cell(r, "units");
    if (unitsText !== "" && paidCents !== null) {
      const micro = parseMicroUnits(unitsText);
      const expected = microUnitsForAmount(
        paidCents,
        opts.pricePerUnitCents,
        true,
      );
      if (micro === null) {
        fail(`"${EXHIBIT_A_COLUMNS.units}" "${unitsText}" is not a number.`);
      } else if (micro !== expected) {
        fail(
          `Preferred Units ${unitsText} does not match Paid to Date ${formatCents(paidCents)} at ${formatCents(opts.pricePerUnitCents)} per unit (expected ${formatMicroUnits(expected)})`,
        );
      }
    }

    const date = (key: "admitted" | "receiptDate"): string | null => {
      const value = cell(r, key);
      const parsed = parseExhibitADate(value);
      if (parsed === null) {
        fail(
          `"${EXHIBIT_A_COLUMNS[key]}" ${value === "" ? "is empty" : `"${value}" is not a date (use YYYY-MM-DD or M/D/YYYY)`}.`,
        );
      }
      return parsed;
    };
    const admittedOn = date("admitted");
    const receiptDate =
      cell(r, "receiptDate") === "" ? admittedOn : date("receiptDate");

    // Email and address.
    const notice = splitNoticeAddress(cell(r, "notice"));
    const emailCell = cell(r, "email").toLowerCase();
    const email = emailCell !== "" ? emailCell : notice.email;
    if (email === null || email === "") {
      fail("No email address found (Notice Address and Email, or Email).");
    } else if (!EMAIL_RE.test(email)) {
      fail(`"${email}" is not an email address.`);
    } else {
      const first = seenEmails.get(email);
      if (first !== undefined) {
        fail(`The email ${email} is also used on line ${first}.`);
      } else {
        seenEmails.set(email, line);
      }
    }
    const optional = (key: ColumnKey): string | undefined => {
      const v = cell(r, key);
      return v === "" ? undefined : v;
    };
    const streetAddress =
      optional("street") ??
      (notice.address === "" ? undefined : notice.address);

    const stateCode = (key: "state" | "residence"): string | undefined => {
      const v = optional(key)?.toUpperCase();
      if (v !== undefined && !STATE_CODES.has(v)) {
        fail(
          `"${EXHIBIT_A_COLUMNS[key]}" "${v}" is not a 2-letter state code.`,
        );
      }
      return v;
    };
    const state = stateCode("state");
    const residenceState = stateCode("residence");

    const holderText = cell(r, "holderType").toLowerCase();
    const holderType =
      holderText === "" ? "INDIVIDUAL" : HOLDER_TYPES[holderText];
    if (holderType === undefined) {
      fail(
        `"${EXHIBIT_A_COLUMNS.holderType}" "${cell(r, "holderType")}" must be individual, joint, trust or entity.`,
      );
    }

    const basisText = optional("accreditation")?.toUpperCase();
    const accreditationBasis = EXHIBIT_A_ACCREDITATION_BASES.find(
      (b) => b === basisText,
    );
    if (basisText !== undefined && accreditationBasis === undefined) {
      fail(
        `"${EXHIBIT_A_COLUMNS.accreditation}" "${basisText}" must be one of ${EXHIBIT_A_ACCREDITATION_BASES.join(", ")}.`,
      );
    }

    const signerName = optional("signerName");
    const signerTitle = optional("signerTitle");
    if ((holderType === "TRUST" || holderType === "ENTITY") && !signerName) {
      fail("Signer Name is required for trusts and entities.");
    }
    if ((signerName?.length ?? 0) > 120 || (signerTitle?.length ?? 0) > 120) {
      fail("Signer Name and Signer Title must be at most 120 characters.");
    }

    const yesNo = (key: "insider" | "waived"): boolean => {
      const v = parseYesNo(cell(r, key));
      if (v === null) {
        fail(
          `"${EXHIBIT_A_COLUMNS[key]}" "${cell(r, key)}" must be yes or no.`,
        );
        return false;
      }
      return v;
    };
    const isInsider = yesNo("insider");
    const minimumWaived = yesNo("waived");

    const wireReference = optional("wire");
    if ((wireReference?.length ?? 0) > 120) {
      fail("Wire Reference must be at most 120 characters.");
    }

    if (
      rowErrors.length > 0 ||
      committedCents === null ||
      paidCents === null ||
      admittedOn === null ||
      receiptDate === null ||
      email === null ||
      holderType === undefined
    ) {
      for (const message of rowErrors) errors.push({ line, message });
      continue;
    }

    rows.push({
      line,
      name,
      email,
      committedCents,
      paidCents,
      admittedOn,
      receiptDate,
      streetAddress,
      city: optional("city"),
      state,
      zipcode: optional("zip"),
      holderType,
      residenceState,
      accreditationBasis,
      signerName,
      signerTitle,
      isInsider,
      minimumWaived,
      wireReference,
      holderTypeSupplied: holderText !== "",
      isInsiderSupplied: cell(r, "insider") !== "",
    });
  }

  return { rows, errors };
}
