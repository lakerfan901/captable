// The investor's Exhibit B answers, read from a signed subscription packet
// (01-foundation.md F13). Pure, relative imports only, unit-tested.
//
// Answers live on the packet's fields (`prefilledValue`), found by their
// `semanticKey`. Only a field whose recipient role matches the key's role is
// read, so a value on a field of the other signer never counts. SELECT
// answers are stored as the option id, which is the enum name. Nothing here
// blocks: every problem becomes an `issue` the Manager sees next to the
// answers; the Manager confirms the values that are saved.

import {
  ACCREDITATION_BASES,
  HOLDER_TYPES,
} from "../../trpc/routers/stakeholder-router/member-schema";
import { isValidDateOnly } from "../date-only";
import {
  getSubscriptionFieldKey,
  SUBSCRIPTION_FIELD_KEYS,
} from "../esign/subscription-fields";
import { formatCents, mulBpsCeil, parseDollarsToCents } from "../money";

export type AccreditationBasis = (typeof ACCREDITATION_BASES)[number];
export type HolderType = (typeof HOLDER_TYPES)[number];
export type DateOnly = string;

export interface ExhibitBField {
  semanticKey: string | null;
  prefilledValue: string | null;
  /**
   * Role of the field's recipient (`investor` / `manager`). When given, a
   * field whose role differs from its key's role is ignored.
   */
  role?: string | null;
}

export interface ExhibitBParsed {
  committedCents: number | null;
  paidCents: number | null;
  accreditationBasis: AccreditationBasis | null;
  legalName: string;
  holderType: HolderType | null;
  residenceState: string | null;
  investmentSummaryDate: DateOnly | null;
  streetAddress: string;
  city: string;
  state: string | null;
  zipcode: string;
  email: string | null;
  signerName: string;
  signerTitle: string;
  investorSignDate: DateOnly | null;
}

export interface ExhibitBAnswers {
  /** key → the value as signed (first non-empty field per key). */
  raw: Record<string, string>;
  parsed: ExhibitBParsed;
  issues: string[];
}

export interface StateName {
  code: string;
  name: string;
}

export interface ExhibitBTerms {
  /** The class minimum (Section 3.7), cents; null when not set. */
  minCommitmentCents: number | null;
  /** The Initial Installment (Section 4.9), basis points (4000 = 40%). */
  initialInstallmentBps: number;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function labelOf(key: string): string {
  return getSubscriptionFieldKey(key)?.label ?? key;
}

/**
 * key → first non-empty answer of a field with that key and the key's role.
 * A key answered twice with different values (the master may place a key
 * more than once) is reported.
 */
function collectRaw(fields: ExhibitBField[], issues: string[]) {
  const raw: Record<string, string> = {};
  const conflicting = new Set<string>();
  for (const field of fields) {
    if (!field.semanticKey) continue;
    const def = getSubscriptionFieldKey(field.semanticKey);
    if (!def) continue;
    if (field.role !== undefined && field.role !== def.role) continue;
    const value = field.prefilledValue;
    if (value === null || value.trim() === "") continue;
    const existing = raw[def.key];
    if (existing === undefined) {
      raw[def.key] = value;
    } else if (existing.trim() !== value.trim()) {
      conflicting.add(def.key);
    }
  }
  // Report in table order, not field order.
  for (const def of SUBSCRIPTION_FIELD_KEYS) {
    if (conflicting.has(def.key)) {
      issues.push(
        `"${def.label}" was answered more than once with different values; the first answer is shown.`,
      );
    }
  }
  return raw;
}

function money(
  raw: Record<string, string>,
  key: string,
  what: string,
  issues: string[],
): number | null {
  const value = raw[key];
  if (value === undefined) return null;
  const cents = parseDollarsToCents(value);
  if (cents === null || cents > BigInt(Number.MAX_SAFE_INTEGER)) {
    issues.push(`Could not read ${what}: "${value}"`);
    return null;
  }
  return Number(cents);
}

function option<T extends string>(
  raw: Record<string, string>,
  key: string,
  allowed: readonly T[],
  issues: string[],
): T | null {
  const value = raw[key];
  if (value === undefined) return null;
  const found = allowed.find((a) => a === value.trim());
  if (found === undefined) {
    issues.push(`Not a valid choice for "${labelOf(key)}": "${value}"`);
    return null;
  }
  return found;
}

function stateCode(
  raw: Record<string, string>,
  key: string,
  states: StateName[],
  issues: string[],
): string | null {
  const value = raw[key];
  if (value === undefined) return null;
  const text = value.trim().replace(/\s+/g, " ").toLowerCase();
  const found = states.find(
    (s) => s.code.toLowerCase() === text || s.name.toLowerCase() === text,
  );
  if (!found) {
    issues.push(`Not a recognised US state for "${labelOf(key)}": "${value}"`);
    return null;
  }
  return found.code.toUpperCase();
}

function date(
  raw: Record<string, string>,
  key: string,
  issues: string[],
): DateOnly | null {
  const value = raw[key];
  if (value === undefined) return null;
  const text = value.trim();
  if (!isValidDateOnly(text)) {
    issues.push(`Not a valid date for "${labelOf(key)}": "${value}"`);
    return null;
  }
  return text;
}

function text(raw: Record<string, string>, key: string): string {
  return (raw[key] ?? "").trim();
}

/** Required investor keys the investor left empty, in table order. */
function missingAnswers(raw: Record<string, string>): string[] {
  return SUBSCRIPTION_FIELD_KEYS.filter(
    (k) =>
      k.role === "investor" &&
      k.required &&
      k.type !== "SIGNATURE" &&
      raw[k.key] === undefined,
  ).map((k) => k.label);
}

export function mapExhibitBAnswers(
  fields: ExhibitBField[],
  states: StateName[],
  terms: ExhibitBTerms,
): ExhibitBAnswers {
  const issues: string[] = [];
  const raw = collectRaw(fields, issues);

  const missing = missingAnswers(raw);
  if (missing.length > 0) {
    issues.push(`Not answered: ${missing.join(", ")}`);
  }

  const committedCents = money(
    raw,
    "commitment_amount",
    "the committed amount",
    issues,
  );
  const paidCents = money(
    raw,
    "amount_paid",
    "the amount paid with the signature page",
    issues,
  );
  const accreditationBasis = option(
    raw,
    "accreditation_basis",
    ACCREDITATION_BASES,
    issues,
  );
  const holderType = option(raw, "holder_type", HOLDER_TYPES, issues);
  const residenceState = stateCode(raw, "residence_state", states, issues);
  const state = stateCode(raw, "address_state", states, issues);
  const investmentSummaryDate = date(raw, "investment_summary_date", issues);
  const investorSignDate = date(raw, "investor_sign_date", issues);

  let email: string | null = null;
  if (raw.email !== undefined) {
    const value = raw.email.trim().toLowerCase();
    if (EMAIL_RE.test(value)) {
      email = value;
    } else {
      issues.push(`Not a valid email address: "${raw.email}"`);
    }
  }

  // "Jane Doe, Managing Member" → name "Jane Doe", title "Managing Member".
  const signer = text(raw, "signer_name_title");
  const comma = signer.indexOf(",");
  const signerName = (comma === -1 ? signer : signer.slice(0, comma)).trim();
  const signerTitle = comma === -1 ? "" : signer.slice(comma + 1).trim();

  // Cross-checks: never blocking.
  if (committedCents !== null && paidCents !== null) {
    const required = mulBpsCeil(
      BigInt(committedCents),
      terms.initialInstallmentBps,
    );
    if (BigInt(paidCents) < required) {
      issues.push(
        `Paid with the signature page is below the ${terms.initialInstallmentBps / 100}% Initial Installment (Section 4.9): ${formatCents(paidCents)} paid, ${formatCents(required)} required.`,
      );
    }
  }
  if (
    committedCents !== null &&
    terms.minCommitmentCents !== null &&
    committedCents < terms.minCommitmentCents
  ) {
    issues.push("Below the minimum; a waiver is needed (Section 3.7)");
  }
  if ((holderType === "ENTITY" || holderType === "TRUST") && !signerName) {
    issues.push(
      `A ${holderType === "ENTITY" ? "entity" : "trust"} needs the signer's name and title ("Name and title (if entity)").`,
    );
  }

  return {
    raw,
    parsed: {
      committedCents,
      paidCents,
      accreditationBasis,
      legalName: text(raw, "legal_name"),
      holderType,
      residenceState,
      investmentSummaryDate,
      streetAddress: text(raw, "address_street"),
      city: text(raw, "address_city"),
      state,
      zipcode: text(raw, "address_zip"),
      email,
      signerName,
      signerTitle,
      investorSignDate,
    },
    issues,
  };
}
