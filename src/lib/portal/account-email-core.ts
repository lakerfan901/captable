// Wording of the portal account emails that does not need the database
// (04-investor-portal.md 5.6 "mail kinds", 5.8; package P2b). Pure: no `@/`
// imports, time passed in.

export type PortalAccountEmailKindName =
  | "INVITE"
  | "ACCESS_ADDED"
  | "RESET"
  | "PASSWORD_CHANGED"
  | "LOCKED";

/** `EmailLog.kind` of each account email (the mail kinds of 5.6). */
export const PORTAL_EMAIL_LOG_KIND: Readonly<
  Record<PortalAccountEmailKindName, string>
> = {
  INVITE: "portal.invite",
  ACCESS_ADDED: "portal.access-added",
  RESET: "portal.password-reset",
  PASSWORD_CHANGED: "portal.password-changed",
  LOCKED: "portal.account-locked",
};

/**
 * How long a link still works, in words, from its stored `expiresAt`: "7
 * days", "23 hours", "60 minutes". Days and hours are rounded down after a
 * 10-minute allowance (a 7-day invitation emailed a few seconds or minutes
 * after it was issued still reads "7 days"; one emailed a day later reads
 * "6 days"); minutes are rounded up (a 60-minute link reads "60 minutes").
 * A past or invalid time reads "a few minutes"; the worker never sends such
 * a link anyway.
 */
export function expiryPhrase(expiresAt: Date, now: Date): string {
  const ms = expiresAt.getTime() - now.getTime();
  if (!Number.isFinite(ms) || ms <= 0) return "a few minutes";
  const minutes = Math.ceil(ms / 60_000);
  if (minutes <= 120) return minutes === 1 ? "1 minute" : `${minutes} minutes`;
  const graced = ms + 10 * 60_000;
  const hours = Math.floor(graced / 3_600_000);
  if (hours < 48) return `${hours} hours`;
  const days = Math.floor(graced / 86_400_000);
  return `${days} days`;
}

/** Subject lines. They never carry a link, a token or an address. */
export function portalEmailSubject(
  kind: PortalAccountEmailKindName,
  names: { companyName?: string | null; holderName?: string | null } = {},
): string {
  switch (kind) {
    case "INVITE":
      return names.companyName
        ? `You have been invited to the ${names.companyName} investor portal`
        : "You have been invited to the investor portal";
    case "ACCESS_ADDED":
      return names.holderName
        ? `You now have access to ${names.holderName}`
        : "You now have access to another holder in the investor portal";
    case "RESET":
      return "Set a new password for the investor portal";
    case "PASSWORD_CHANGED":
      return "Your investor portal password was changed";
    case "LOCKED":
      return "Investor portal sign-in is locked for 15 minutes";
  }
}

/** "November 15, 2026 at 17:32 UTC": the time of a security event, in UTC (the account has no time zone). */
export function utcInstant(at: Date): string {
  const date = new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    dateStyle: "long",
  }).format(at);
  const time = new Intl.DateTimeFormat("en-GB", {
    timeZone: "UTC",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(at);
  return `${date} at ${time} UTC`;
}
