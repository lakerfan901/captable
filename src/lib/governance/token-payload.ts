// Ballot and member-report token payloads (03-governance.md G6). Pure: no
// database, no `@/` imports.
//
// Every token kind in the app is signed with the same secret (A3), so each
// governance payload carries a purpose claim (`p`) that no other kind has and
// is parsed with a STRICT schema: an update, data-room or e-sign token (or a
// report token presented as a ballot token, and vice versa) never parses.

import { z } from "zod";

export const BallotTokenPayload = z.strictObject({
  p: z.literal("rb"),
  b: z.string().min(1).max(64),
  v: z.number().int().min(1),
  exp: z.number().int(),
});

export const ReportTokenPayload = z.strictObject({
  p: z.literal("mr"),
  r: z.string().min(1).max(64),
  v: z.number().int().min(1),
  exp: z.number().int(),
});

export function parseBallotPayload(
  payload: unknown,
): { ballotId: string; version: number } | null {
  const parsed = BallotTokenPayload.safeParse(payload);
  if (!parsed.success) return null;
  return { ballotId: parsed.data.b, version: parsed.data.v };
}

export function parseReportPayload(
  payload: unknown,
): { recipientId: string; version: number } | null {
  const parsed = ReportTokenPayload.safeParse(payload);
  if (!parsed.success) return null;
  return { recipientId: parsed.data.r, version: parsed.data.v };
}

const DAY_MS = 86_400_000;

function plusDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * DAY_MS);
}

/** min(closesAt + 60 days, sentAt + 400 days); sentAt + 400 days when closesAt is null. */
export function ballotTokenExpiry(sentAt: Date, closesAt: Date | null): Date {
  const cap = plusDays(sentAt, 400);
  if (closesAt === null) return cap;
  const afterClose = plusDays(closesAt, 60);
  return afterClose.getTime() < cap.getTime() ? afterClose : cap;
}

/** sentAt + 400 days. */
export function reportTokenExpiry(sentAt: Date): Date {
  return plusDays(sentAt, 400);
}
