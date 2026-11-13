import { z } from "zod";

// Relative-import-free on purpose: imported by the client form and by tests.

const zText = z.string().trim().min(1).max(200);

export const ZodCreateBankAccountSchema = z.object({
  beneficiaryName: zText,
  beneficiaryAddress: zText,
  bankName: zText,
  bankAddress: zText,
  accountNumber: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9]{4,34}$/, "4 to 34 letters or digits, no spaces."),
  routingNumber: z
    .string()
    .trim()
    .regex(/^\d{9}$/, "A routing number has exactly 9 digits."),
  accountType: z.enum(["CHECKING", "SAVINGS"]),
  swiftCode: z
    .string()
    .trim()
    .regex(/^[A-Z0-9]{8}([A-Z0-9]{3})?$/, "8 or 11 capital letters or digits.")
    .optional(),
});

export type TypeZodCreateBankAccountSchema = z.infer<
  typeof ZodCreateBankAccountSchema
>;

export const ZodDeleteBankAccountSchema = z.object({ id: z.string().min(1) });

/** Last four characters of an account number (never the whole number). */
export function accountLast4(accountNumber: string): string {
  return accountNumber.slice(-4);
}

/** `•••• 1234` for display. */
export function maskAccountNumber(accountNumber: string): string {
  return `•••• ${accountLast4(accountNumber)}`;
}

/**
 * Primary flag for a new account under `@@unique([companyId, primary])`.
 * Returns null when the company already has two accounts.
 */
export function nextPrimaryFlag(
  existing: readonly { primary: boolean }[],
): boolean | null {
  if (existing.length === 0) return true;
  const [only] = existing;
  if (existing.length === 1 && only) return !only.primary;
  return null;
}
