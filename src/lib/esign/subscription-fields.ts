// Semantic keys of an Exhibit B subscription packet (01-foundation.md A3.14,
// B22, B25, F11).
//
// A master template's fields carry a `semanticKey` so a signed packet can be
// read without knowing where each blank sits on the page. The two SELECT keys
// get canonical options written by the server; option ids are the enum names
// (`AccreditationBasisEnum`, `HolderTypeEnum`), so the stored answer is the
// enum value. Pure: no imports, unit-tested.

export type SubscriptionFieldRole = "investor" | "manager";
export type SubscriptionFieldType = "TEXT" | "SELECT" | "DATE" | "SIGNATURE";

export interface SubscriptionFieldOption {
  id: string;
  value: string;
}

export interface SubscriptionFieldKey {
  key: string;
  role: SubscriptionFieldRole;
  type: SubscriptionFieldType;
  /** Whether the signer must fill it (not whether the master must have it). */
  required: boolean;
  label: string;
  options?: readonly [SubscriptionFieldOption, ...SubscriptionFieldOption[]];
}

const ACCREDITATION_OPTIONS = [
  { id: "NET_WORTH", value: "Individual: net worth over $1,000,000" },
  { id: "INCOME", value: "Individual: income over $200,000 ($300,000 joint)" },
  { id: "LICENSE", value: "Individual: Series 7, 65 or 82 license" },
  { id: "ENTITY_ASSETS", value: "Entity: total assets over $5,000,000" },
  {
    id: "ENTITY_ALL_OWNERS_ACCREDITED",
    value: "Entity: all equity owners accredited",
  },
  { id: "TRUST_ASSETS", value: "Trust: total assets over $5,000,000" },
] as const satisfies readonly SubscriptionFieldOption[];

const HOLDER_TYPE_OPTIONS = [
  { id: "INDIVIDUAL", value: "Individual" },
  { id: "JOINT", value: "Joint" },
  { id: "TRUST", value: "Trust" },
  { id: "ENTITY", value: "Entity" },
] as const satisfies readonly SubscriptionFieldOption[];

export const SUBSCRIPTION_FIELD_KEYS: readonly SubscriptionFieldKey[] = [
  {
    key: "commitment_amount",
    role: "investor",
    type: "TEXT",
    required: true,
    label: "Capital Contribution committed",
  },
  {
    key: "amount_paid",
    role: "investor",
    type: "TEXT",
    required: true,
    label: "Paid with this signature page",
  },
  {
    key: "accreditation_basis",
    role: "investor",
    type: "SELECT",
    required: true,
    label: "Accredited investor basis",
    options: ACCREDITATION_OPTIONS,
  },
  {
    key: "legal_name",
    role: "investor",
    type: "TEXT",
    required: true,
    label: "Legal name",
  },
  {
    key: "holder_type",
    role: "investor",
    type: "SELECT",
    required: true,
    label: "Type of investor",
    options: HOLDER_TYPE_OPTIONS,
  },
  {
    key: "residence_state",
    role: "investor",
    type: "TEXT",
    required: true,
    label: "State of residence (or formation)",
  },
  {
    key: "investment_summary_date",
    role: "investor",
    type: "DATE",
    required: true,
    label: "Investment Summary dated",
  },
  {
    key: "address_street",
    role: "investor",
    type: "TEXT",
    required: true,
    label: "Mailing address: street",
  },
  {
    key: "address_city",
    role: "investor",
    type: "TEXT",
    required: true,
    label: "Mailing address: city",
  },
  {
    key: "address_state",
    role: "investor",
    type: "TEXT",
    required: true,
    label: "Mailing address: state",
  },
  {
    key: "address_zip",
    role: "investor",
    type: "TEXT",
    required: true,
    label: "Mailing address: ZIP code",
  },
  {
    key: "email",
    role: "investor",
    type: "TEXT",
    required: true,
    label: "Email",
  },
  {
    key: "investor_signature",
    role: "investor",
    type: "SIGNATURE",
    required: true,
    label: "Investor signature",
  },
  {
    key: "signer_name_title",
    role: "investor",
    type: "TEXT",
    required: false,
    label: "Name and title (if entity)",
  },
  {
    key: "investor_sign_date",
    role: "investor",
    type: "DATE",
    required: true,
    label: "Investor signature date",
  },
  {
    key: "manager_signature",
    role: "manager",
    type: "SIGNATURE",
    required: true,
    label: "Manager signature",
  },
  {
    key: "manager_sign_date",
    role: "manager",
    type: "DATE",
    required: true,
    label: "Manager signature date",
  },
  {
    key: "contribution_received",
    role: "manager",
    type: "TEXT",
    required: false,
    label: "Capital Contribution received",
  },
  {
    key: "units_issued",
    role: "manager",
    type: "TEXT",
    required: false,
    label: "Preferred Units issued",
  },
];

/**
 * Keys a master must place before it can be sent: every key except
 * `signer_name_title`. The two ledger keys are required on the master although
 * the signer does not fill them.
 */
export const REQUIRED_SUBSCRIPTION_KEYS: readonly string[] =
  SUBSCRIPTION_FIELD_KEYS.filter((k) => k.key !== "signer_name_title").map(
    (k) => k.key,
  );

export function getSubscriptionFieldKey(
  key: string,
): SubscriptionFieldKey | undefined {
  return SUBSCRIPTION_FIELD_KEYS.find((k) => k.key === key);
}

export function isSubscriptionFieldKey(key: string): boolean {
  return getSubscriptionFieldKey(key) !== undefined;
}

/** The canonical SELECT options of a key, or `undefined` when it has none. */
export function canonicalOptionsFor(
  key: string,
): SubscriptionFieldOption[] | undefined {
  const options = getSubscriptionFieldKey(key)?.options;
  return options
    ? options.map((o) => ({ id: o.id, value: o.value }))
    : undefined;
}

/**
 * Required keys not yet placed on a field of the right role, in table order.
 * A key on a field of the other role does not count; duplicates are allowed.
 */
export function missingSubscriptionKeys(
  fields: { semanticKey: string | null; role: string | null }[],
): string[] {
  const placed = new Set<string>();
  for (const field of fields) {
    if (!field.semanticKey) continue;
    const def = getSubscriptionFieldKey(field.semanticKey);
    if (def && def.role === field.role) placed.add(def.key);
  }
  return REQUIRED_SUBSCRIPTION_KEYS.filter((key) => !placed.has(key));
}
