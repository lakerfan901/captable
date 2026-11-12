type AddressObject = { name?: string; address?: string };
export type RecipientInput =
  | string
  | AddressObject
  | readonly RecipientInput[]
  | null
  | undefined;

function splitAddressList(value: string): string[] {
  const parts: string[] = [];
  let current = "";
  let inQuotes = false;
  let inAngle = false;
  for (const ch of value) {
    if (ch === '"') inQuotes = !inQuotes;
    else if (ch === "<" && !inQuotes) inAngle = true;
    else if (ch === ">" && !inQuotes) inAngle = false;
    if ((ch === "," || ch === ";") && !inQuotes && !inAngle) {
      parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts;
}

function extractAddress(value: string): string {
  const angle = /<([^<>]*)>\s*$/.exec(value);
  return (angle?.[1] ?? value).trim().toLowerCase();
}

/**
 * Flattens a nodemailer `to` value (string, address object or array) into
 * lower-cased bare addresses joined with ", ".
 * Pure: relative imports only (unit-tested under vitest).
 */
export function normalizeRecipients(to: RecipientInput): string {
  if (!to) return "";
  const items: readonly RecipientInput[] = Array.isArray(to) ? to : [to];
  const addresses: string[] = [];
  for (const item of items) {
    if (Array.isArray(item)) {
      const nested = normalizeRecipients(item);
      if (nested) addresses.push(nested);
    } else if (typeof item === "string") {
      for (const part of splitAddressList(item)) {
        const address = extractAddress(part);
        if (address) addresses.push(address);
      }
    } else if (
      item &&
      typeof item === "object" &&
      "address" in item &&
      item.address
    ) {
      const address = item.address.trim().toLowerCase();
      if (address) addresses.push(address);
    }
  }
  return addresses.join(", ");
}
