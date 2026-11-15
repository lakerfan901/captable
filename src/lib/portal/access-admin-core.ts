// What the team sees of one portal access (04-investor-portal.md 5.6, 6.2;
// package P3). Pure: relative imports only, unit-tested.
//
// A `PortalUser` is global: one address can hold access for holders of
// several companies. The team of one company must learn nothing about the
// person's other accesses, so everything shown here is derived from facts
// that belong to this company's access row, plus the account-wide sign-in
// lock (which anyone who types the address can cause, so it reveals
// nothing about other accesses).

export type PortalAccessState = "INVITED" | "ACTIVE" | "DISABLED";

export interface AccessFacts {
  status: "ACTIVE" | "DISABLED";
  /** When this access was (last) invited. */
  invitedAt: Date;
  /** The last time the person opened THIS holder in the portal. */
  lastSeenAt: Date | null;
}

export interface UserFacts {
  passwordSetAt: Date | null;
  lockedUntil: Date | null;
}

export interface AccessView {
  state: PortalAccessState;
  /** The person has set up THIS access (see `describeAccess`). */
  passwordSet: boolean;
  /** The account-wide sign-in lock is on now. */
  locked: boolean;
}

/**
 * "Set up" (state ACTIVE) means the person can use THIS access: a password
 * was set at or after the time this access was (last) invited, or the person
 * has opened this holder in the portal. A password set earlier, for another
 * holder or company, does not count, so inviting an address that already
 * has a portal account reads "Invited" like any new invitation, until the
 * person uses it.
 */
export function describeAccess(
  access: AccessFacts,
  user: UserFacts,
  now: Date,
): AccessView {
  const passwordSet =
    access.lastSeenAt !== null ||
    (user.passwordSetAt !== null &&
      user.passwordSetAt.getTime() >= access.invitedAt.getTime());
  return {
    state:
      access.status === "DISABLED"
        ? "DISABLED"
        : passwordSet
          ? "ACTIVE"
          : "INVITED",
    passwordSet,
    locked:
      user.lockedUntil !== null && user.lockedUntil.getTime() > now.getTime(),
  };
}

/** Which row actions the card offers (5.6; the prototype's rules). */
export function accessActions(view: AccessView): {
  resend: boolean;
  unlock: boolean;
  disable: boolean;
  enable: boolean;
} {
  const active = view.state !== "DISABLED";
  return {
    resend: active && !view.passwordSet,
    unlock: active && view.locked,
    disable: active,
    enable: !active,
  };
}
