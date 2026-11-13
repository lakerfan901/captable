import "server-only";
import { env } from "@/env";
import {
  parseBallotPayload,
  parseReportPayload,
} from "@/lib/governance/token-payload";
import { decode, encode } from "@/lib/jwt";

// Ballot and member-report links (03-governance.md G6).
//
// A token is an HS256 JWT over (purpose, row id, tokenVersion, exp). Nothing
// about the token is stored: it is re-derived from the row, so a reminder
// re-signs the SAME link and "replace link" (tokenVersion + 1) kills every
// older link at once. `decode` verifies the signature and `exp`; the strict
// payload schema rejects every other token kind.
//
// What this module does NOT check, and every caller must (G8 `resolveBallot`,
// G12 `resolveRecipient`): the row exists, `tokenRevokedAt` is null,
// `version === row.tokenVersion`, `row.tokenExpiresAt > now`, and the company
// is an LLC. The company, resolution/report and stakeholder always come from
// the row, never from the client. Never log a token.

function expSeconds(expiresAt: Date): number {
  const ms = expiresAt.getTime();
  if (!Number.isFinite(ms)) throw new Error("Invalid token expiry");
  return Math.floor(ms / 1000);
}

function assertVersion(version: number): void {
  if (!Number.isInteger(version) || version < 1) {
    throw new Error("Invalid token version");
  }
}

export async function signBallotToken(b: {
  id: string;
  tokenVersion: number;
  tokenExpiresAt: Date;
}): Promise<string> {
  assertVersion(b.tokenVersion);
  return await encode({
    p: "rb",
    b: b.id,
    v: b.tokenVersion,
    exp: expSeconds(b.tokenExpiresAt),
  });
}

export async function verifyBallotToken(
  token: string,
): Promise<{ ballotId: string; version: number } | null> {
  try {
    const { payload } = await decode(token);
    return parseBallotPayload(payload);
  } catch {
    return null;
  }
}

export async function signReportToken(r: {
  id: string;
  tokenVersion: number;
  tokenExpiresAt: Date;
}): Promise<string> {
  assertVersion(r.tokenVersion);
  return await encode({
    p: "mr",
    r: r.id,
    v: r.tokenVersion,
    exp: expSeconds(r.tokenExpiresAt),
  });
}

export async function verifyReportToken(
  token: string,
): Promise<{ recipientId: string; version: number } | null> {
  try {
    const { payload } = await decode(token);
    return parseReportPayload(payload);
  } catch {
    return null;
  }
}

export function ballotUrl(token: string): string {
  return `${env.NEXT_PUBLIC_BASE_URL}/ballots/${encodeURIComponent(token)}`;
}

export function reportUrl(token: string): string {
  return `${env.NEXT_PUBLIC_BASE_URL}/member-reports/${encodeURIComponent(token)}`;
}
