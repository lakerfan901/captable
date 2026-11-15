// Posts a JSON body to a portal route handler from the browser and reads the
// answer without trusting its shape (04-investor-portal.md 5.2; package
// P2b). The proxy's rate limiter answers 429 in plain text, and a server
// error may not be JSON, so the body is parsed defensively.

export const TOO_MANY_ATTEMPTS = "Too many attempts, try again in a minute.";
export const SOMETHING_WENT_WRONG = "Something went wrong. Please try again.";

export interface PortalPostResult {
  status: number;
  /** The parsed JSON object, or null when the body was not a JSON object. */
  data: Record<string, unknown> | null;
}

export async function postPortalJson(
  url: string,
  body: Record<string, string>,
): Promise<PortalPostResult> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    credentials: "same-origin",
    cache: "no-store",
  });
  let data: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = await response.json();
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed))
      data = parsed as Record<string, unknown>;
  } catch {
    data = null;
  }
  return { status: response.status, data };
}

/** The message to show for a failed answer. */
export function failureMessage(result: PortalPostResult): string {
  if (result.status === 429) return TOO_MANY_ATTEMPTS;
  const error = result.data?.error;
  return typeof error === "string" && result.status < 500
    ? error
    : SOMETHING_WENT_WRONG;
}

/** The `next` path of a successful answer; the server already passed it through `safeNextPath`. */
export function nextOf(result: PortalPostResult): string {
  const next = result.data?.next;
  return typeof next === "string" &&
    (next === "/portal" || next.startsWith("/portal/"))
    ? next
    : "/portal";
}
