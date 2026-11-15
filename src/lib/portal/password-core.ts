// Portal password policy and lockout (04-investor-portal.md 5.2, rules P4,
// P6; S8, S9, S13; package P1). Pure: no database, no `@/` imports, no
// bcrypt; time is passed in. Safe to import from a client form for the live
// check of the set-password page.

import { hasUnsafeChar } from "./chars";
import { COMMON_PASSWORD_LIST } from "./common-passwords";

/** P4: hashed with `bcrypt.hash(password, BCRYPT_COST)` (bcryptjs). */
export const BCRYPT_COST = 12;
/** P4: at least 12 characters, counted in Unicode code points. */
export const PASSWORD_MIN_CHARS = 12;
/** P4, S13: bcrypt reads at most 72 bytes; longer input would be cut silently. */
export const PASSWORD_MAX_BYTES = 72;
/** The email name is refused inside the password only when it has 4+ characters. */
export const EMAIL_NAME_MIN_CHARS = 4;

/** P6: five wrong passwords in a row lock the account. */
export const MAX_FAILED_SIGN_INS = 5;
/** P6: for 15 minutes. */
export const LOCK_MS = 15 * 60_000;
/** 5.2: at most one "sign-in is locked" email per 24 hours. */
export const LOCK_NOTICE_INTERVAL_MS = 24 * 60 * 60_000;

/** Lower-cased; compared against the lower-cased password. */
export const COMMON_PASSWORDS: ReadonlySet<string> = new Set(
  COMMON_PASSWORD_LIST,
);

export type PasswordProblem =
  | "NOT_A_STRING"
  | "TOO_SHORT"
  | "TOO_LONG"
  | "INVALID_CHARACTERS"
  | "COMMON"
  | "CONTAINS_EMAIL_NAME";

export type PasswordCheck =
  | { ok: true }
  | { ok: false; reason: PasswordProblem };

/** One sentence per refusal, for the set-password and change-password forms. */
export const PASSWORD_PROBLEM_MESSAGES: Readonly<
  Record<PasswordProblem, string>
> = {
  NOT_A_STRING: "Enter a password.",
  TOO_SHORT: `Use at least ${PASSWORD_MIN_CHARS} characters.`,
  TOO_LONG:
    "This password is too long. Use at most 72 plain characters (fewer if it contains accented letters, symbols or emoji).",
  INVALID_CHARACTERS:
    "This password contains a character that cannot be used, such as a line break or a control character.",
  COMMON: "This password is too common. Choose one that is harder to guess.",
  CONTAINS_EMAIL_NAME: "The password must not contain your email name.",
};

/** The rule in one sentence (set-password page, 6.1). */
export const PASSWORD_RULE_SENTENCE =
  "At least 12 characters, not a common password, and not containing your email name.";

const encoder = new TextEncoder();

/** UTF-8 length, as bcrypt counts it (the same as `Buffer.byteLength(s, "utf8")`). */
export function utf8ByteLength(value: string): number {
  return encoder.encode(value).length;
}

/**
 * The names derived from an email that must not appear in the password: the
 * part before the last `@`, and that part without a `+tag`, each when it has
 * at least 4 characters. Lower-cased.
 */
export function emailNames(email: string): string[] {
  const normalized = email.trim().toLowerCase();
  const at = normalized.lastIndexOf("@");
  const local = at === -1 ? normalized : normalized.slice(0, at);
  const names = new Set<string>();
  for (const candidate of [local, local.split("+")[0] ?? ""]) {
    if ([...candidate].length >= EMAIL_NAME_MIN_CHARS) names.add(candidate);
  }
  return [...names];
}

/**
 * P4. The password is checked exactly as it will be hashed: it is not trimmed
 * or Unicode-normalised (spaces count, and P2 must hash the same string).
 * Order: type, characters, length in bytes, length in characters, common
 * list, email name.
 */
export function checkPassword(password: unknown, email: string): PasswordCheck {
  if (typeof password !== "string")
    return { ok: false, reason: "NOT_A_STRING" };
  // Lone surrogates would be encoded as U+FFFD, so two different strings
  // would hash the same; control characters cannot be typed and hide text.
  if (hasUnsafeChar(password)) {
    return { ok: false, reason: "INVALID_CHARACTERS" };
  }
  if (utf8ByteLength(password) > PASSWORD_MAX_BYTES) {
    return { ok: false, reason: "TOO_LONG" };
  }
  if ([...password].length < PASSWORD_MIN_CHARS) {
    return { ok: false, reason: "TOO_SHORT" };
  }
  const lower = password.toLowerCase();
  if (COMMON_PASSWORDS.has(lower) || COMMON_PASSWORDS.has(lower.trim())) {
    return { ok: false, reason: "COMMON" };
  }
  if (emailNames(email).some((name) => lower.includes(name))) {
    return { ok: false, reason: "CONTAINS_EMAIL_NAME" };
  }
  return { ok: true };
}

export interface LockState {
  lockedUntil: Date | null;
  /** Consecutive wrong passwords since the last success or lock. */
  failedSignIns: number;
}

export interface SignInOutcome {
  result: "OK" | "REFUSED";
  /** The values to store. */
  failedSignIns: number;
  lockedUntil: Date | null;
  /** True only on the attempt that locks the account (write ACCOUNT_LOCKED, queue the notice). */
  lockedNow: boolean;
}

/**
 * P6, 5.2 steps 3–5, for an existing account with a password. `matched` is
 * the result of `bcrypt.compare`.
 *
 * - Locked (`lockedUntil > now`): REFUSED whatever the password, and the
 *   state is returned unchanged, so attempts during a lock neither count nor
 *   extend it (the 15-minute bound of S9).
 * - Otherwise a lock that has ended is cleared, then: right password -> OK,
 *   counter 0; wrong password -> counter + 1, and at 5 or more the account
 *   is locked until `now + 15 min` with the counter back to 0.
 *
 * An unreadable `lockedUntil` (Invalid Date) is treated as locked and left
 * as it is: fail closed, the team can unlock. A negative or non-integer
 * counter is read as 0. The database applies the result with a guarded
 * UPDATE (P2); this function only decides it.
 */
export function signInOutcome(
  state: LockState,
  matched: boolean,
  now: Date,
): SignInOutcome {
  const t = now.getTime();
  if (state.lockedUntil !== null) {
    const until = state.lockedUntil.getTime();
    if (Number.isNaN(until) || until > t) {
      return {
        result: "REFUSED",
        failedSignIns: state.failedSignIns,
        lockedUntil: state.lockedUntil,
        lockedNow: false,
      };
    }
  }
  if (matched === true) {
    return {
      result: "OK",
      failedSignIns: 0,
      lockedUntil: null,
      lockedNow: false,
    };
  }
  const previous =
    Number.isSafeInteger(state.failedSignIns) && state.failedSignIns > 0
      ? state.failedSignIns
      : 0;
  const failed = previous + 1;
  if (failed >= MAX_FAILED_SIGN_INS) {
    return {
      result: "REFUSED",
      failedSignIns: 0,
      lockedUntil: new Date(t + LOCK_MS),
      lockedNow: true,
    };
  }
  return {
    result: "REFUSED",
    failedSignIns: failed,
    lockedUntil: null,
    lockedNow: false,
  };
}

/** Whether `lockedUntil` still refuses sign-in at `now` (Invalid Date: locked). */
export function isLocked(lockedUntil: Date | null, now: Date): boolean {
  if (lockedUntil === null) return false;
  const until = lockedUntil.getTime();
  return Number.isNaN(until) || until > now.getTime();
}

/**
 * 5.2 step 4: the lock email is sent at most once per 24 hours. Due when no
 * notice was ever sent or the last one is at least 24 hours old. A stored
 * value in the future or unreadable is not due (at worst one notice is
 * skipped; never a flood).
 */
export function lockNoticeDue(
  lockNoticeSentAt: Date | null,
  now: Date,
): boolean {
  if (lockNoticeSentAt === null) return true;
  const age = now.getTime() - lockNoticeSentAt.getTime();
  return age >= LOCK_NOTICE_INTERVAL_MS;
}
