// Pure decisions of the public ballot router (03-governance.md G8). No
// database, no `@/` imports: unit-tested by `access.test.ts`.
//
// `resolveBallot` (procedures/resolve.ts) loads the rows and calls
// `classifyBallotAccess`; every public procedure goes through it.

export type BallotAccess = "NOT_FOUND" | "REPLACED" | "OK";

export interface BallotAccessRow {
  /** Company of the resolution, loaded FROM THE ROW (never from the client). */
  companyEntityType: string;
  resolutionStatus: string;
  tokenVersion: number;
  tokenRevokedAt: Date | null;
  tokenExpiresAt: Date;
}

/**
 * G8 token validation, steps 4–6, in the plan's order. Steps 1–3 (input
 * schema, signature + `exp` + strict payload, row exists) happen before.
 *
 * 4. not an LLC, or the resolution is still a DRAFT -> NOT_FOUND
 * 5. link revoked, or the token's version is not the row's current version
 *    -> REPLACED (the page shows "this link has been replaced"; no content)
 * 6. the row's own expiry has passed -> NOT_FOUND
 */
export function classifyBallotAccess(
  row: BallotAccessRow,
  tokenVersion: number,
  now: Date,
): BallotAccess {
  if (row.companyEntityType !== "LLC") return "NOT_FOUND";
  if (row.resolutionStatus === "DRAFT") return "NOT_FOUND";
  if (row.tokenRevokedAt !== null || tokenVersion !== row.tokenVersion) {
    return "REPLACED";
  }
  if (row.tokenExpiresAt.getTime() <= now.getTime()) return "NOT_FOUND";
  return "OK";
}

export type BallotPageState = "OPEN" | "VOTED" | "CLOSED";

/** CLOSED when the resolution is not SENT; else VOTED once submitted; else OPEN. */
export function ballotPageState(
  resolutionStatus: string,
  submittedAt: Date | null,
): BallotPageState {
  if (resolutionStatus !== "SENT") return "CLOSED";
  if (submittedAt !== null) return "VOTED";
  return "OPEN";
}

const MAX_IP_CHARS = 100;
const MAX_USER_AGENT_CHARS = 1000;

/**
 * Request IP and user agent are client-controlled headers: bound them before
 * they are stored on the ballot, the event log or the audit row.
 */
export function boundRequestMeta(
  requestIp: string,
  userAgent: string,
): { ip: string; userAgent: string } {
  return {
    ip: requestIp.slice(0, MAX_IP_CHARS),
    userAgent: userAgent.slice(0, MAX_USER_AGENT_CHARS),
  };
}
