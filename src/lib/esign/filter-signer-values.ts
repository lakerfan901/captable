// Signer isolation for e-sign (01-foundation.md A3.8, F11).
//
// The signing endpoint is public: the browser decides which keys it posts.
// This keeps only the values a recipient may write: its own fields, never a
// read-only field (those keep the value the sender put there), and checks the
// required fields on the server. Pure: no imports, unit-tested.

export interface SignerField {
  id: string;
  name: string;
  recipientId: string;
  readOnly: boolean;
  required: boolean;
  type: string;
  defaultValue: string;
  prefilledValue: string | null;
}

export interface FilteredSignerValues {
  /** Field id → value, for this recipient's fields only; empty values omitted. */
  values: Record<string, string>;
  /** Names of required, writable fields of this recipient that are empty. */
  missingRequired: string[];
}

export function filterSignerValues(
  fields: SignerField[],
  recipientId: string,
  data: Record<string, string>,
): FilteredSignerValues {
  const values: Record<string, string> = {};
  const missingRequired: string[] = [];

  for (const field of fields) {
    if (field.recipientId !== recipientId) continue;

    const fallback = field.prefilledValue ?? field.defaultValue;
    let value: string;

    if (field.readOnly) {
      value = fallback;
    } else {
      const raw = Object.hasOwn(data, field.id) ? data[field.id] : undefined;
      const submitted =
        typeof raw === "string"
          ? field.type === "TEXT"
            ? raw.trim()
            : raw
          : "";
      value = submitted !== "" ? submitted : fallback;
    }

    if (value !== "") {
      values[field.id] = value;
    } else if (field.required && !field.readOnly) {
      missingRequired.push(field.name);
    }
  }

  return { values, missingRequired };
}
