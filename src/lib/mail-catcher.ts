const CATCHER_HOSTS = new Set(["smtp", "mailpit", "localhost", "127.0.0.1"]);

/**
 * True when the SMTP URL points at a local mail catcher (Mailpit) or is
 * missing/unparseable, i.e. mail is captured and not delivered.
 * Pure: relative imports only (unit-tested under vitest).
 */
export function isMailCatcherUrl(url: string | undefined): boolean {
  if (!url) return true;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return true;
  }
  if (CATCHER_HOSTS.has(parsed.hostname.toLowerCase())) return true;
  if (parsed.port === "1025") return true;
  return false;
}
