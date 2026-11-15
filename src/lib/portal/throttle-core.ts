// Per-address throttle for reset and set-up emails (04-investor-portal.md
// 5.2 "Forgot password", 5.5 `requestSetup`; package P1). Pure: no database,
// no `@/` imports; time is passed in.
//
// The proxy's per-IP limiter fails open (2.1); this database-backed limit is
// what protects a mailbox from being flooded.

const MINUTE_MS = 60_000;

/** At most 3 tokens created in the last 15 minutes... */
export const RESET_SHORT_WINDOW_MS = 15 * MINUTE_MS;
export const RESET_SHORT_MAX = 3;
/** ...and at most 10 in the last 24 hours. */
export const RESET_LONG_WINDOW_MS = 24 * 60 * MINUTE_MS;
export const RESET_LONG_MAX = 10;

/**
 * Whether one more emailed token may be issued to this portal user, given the
 * `createdAt` of the user's tokens (P2 passes the rows of the last 24 hours;
 * older rows are ignored here anyway).
 *
 * A token counts toward a window when it was created strictly after
 * `now - window`; one created exactly 15 minutes ago no longer counts toward
 * the short window. A timestamp in the future (clock skew) or unreadable
 * counts toward both windows: fail closed, at worst one email is skipped.
 */
export function resetRequestAllowed(
  createdAtList: readonly Date[],
  now: Date,
): boolean {
  const t = now.getTime();
  let short = 0;
  let long = 0;
  for (const createdAt of createdAtList) {
    const c = createdAt.getTime();
    if (Number.isNaN(c)) {
      short += 1;
      long += 1;
      continue;
    }
    if (c > t - RESET_SHORT_WINDOW_MS) short += 1;
    if (c > t - RESET_LONG_WINDOW_MS) long += 1;
  }
  return short < RESET_SHORT_MAX && long < RESET_LONG_MAX;
}
