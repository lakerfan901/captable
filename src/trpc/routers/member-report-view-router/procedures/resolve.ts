import "server-only";
import { TRPCError } from "@trpc/server";
import type { TPrismaOrTransaction } from "@/server/db";
import { loadLlcCompany } from "@/server/governance/guards";
import { verifyReportToken } from "@/server/governance/tokens";
import { classifyReportAccess } from "../access";

// resolveRecipient (03-governance.md G12; mirrors G8 `resolveBallot`). The
// ONE entry point of every public member-report procedure.
//
// 1. Input schema (`zReportToken`, schema.ts) bounds the token to 20–2048 chars.
// 2. `verifyReportToken`: HS256 (pinned) signature, `exp`, strict payload
//    `p: "mr"` (a ballot, update, data-room or e-sign token never parses).
// 3. The recipient row by the token's recipient id; the report and the
//    company are taken FROM THAT ROW, never from the client or the token;
//    the company must be an LLC (`loadLlcCompany`).
// 4–6. `classifyReportAccess`: not SENT -> NOT_FOUND; revoked or superseded
//    version -> REPLACED; row expiry passed -> NOT_FOUND.
//
// Every failure throws the same message-less NOT_FOUND, so an invalid,
// forged, expired, foreign-kind or unknown token reveals nothing. REPLACED is
// only reachable with a correctly signed, unexpired token and carries the
// company name and logo only.
//
// The token itself is never logged, stored, put in an error or an audit row.

const notFound = (): never => {
  throw new TRPCError({ code: "NOT_FOUND" });
};

const recipientSelect = {
  id: true,
  reportId: true,
  companyId: true,
  stakeholderId: true,
  name: true,
  tokenVersion: true,
  tokenExpiresAt: true,
  tokenRevokedAt: true,
  firstViewedAt: true,
  report: {
    select: {
      id: true,
      companyId: true,
      type: true,
      status: true,
      title: true,
      noticeKind: true,
      periodStart: true,
      periodEnd: true,
      sentAt: true,
      frozenContent: true,
    },
  },
} as const;

type LlcCompany = Awaited<ReturnType<typeof loadLlcCompany>>;

async function loadRecipient(db: TPrismaOrTransaction, recipientId: string) {
  return await db.memberReportRecipient.findUnique({
    where: { id: recipientId },
    select: recipientSelect,
  });
}

type LoadedRecipient = NonNullable<Awaited<ReturnType<typeof loadRecipient>>>;

export type ResolvedRecipient =
  | {
      kind: "REPLACED";
      company: { name: string; logo: string | null };
    }
  | {
      kind: "OK";
      recipient: Omit<LoadedRecipient, "report">;
      report: LoadedRecipient["report"];
      company: LlcCompany;
    };

export async function resolveRecipient(
  db: TPrismaOrTransaction,
  token: string,
  now: Date,
): Promise<ResolvedRecipient> {
  // 2.
  const claims = await verifyReportToken(token);
  if (claims === null) return notFound();

  // 3.
  const row = await loadRecipient(db, claims.recipientId);
  if (row === null) return notFound();
  const { report, ...recipient } = row;
  // Defence in depth: the recipient and its report belong to one company.
  if (recipient.companyId !== report.companyId) return notFound();
  // Throws NOT_FOUND unless the company of the ROW is an LLC.
  const company = await loadLlcCompany(db, report.companyId);

  // 4–6.
  const access = classifyReportAccess(
    {
      companyEntityType: company.entityType,
      reportStatus: report.status,
      tokenVersion: recipient.tokenVersion,
      tokenRevokedAt: recipient.tokenRevokedAt,
      tokenExpiresAt: recipient.tokenExpiresAt,
    },
    claims.version,
    now,
  );
  if (access === "NOT_FOUND") return notFound();
  if (access === "REPLACED") {
    return {
      kind: "REPLACED",
      company: { name: company.name, logo: company.logo },
    };
  }
  return { kind: "OK", recipient, report, company };
}

/** For procedures that accept an OK link only: REPLACED gets the same NOT_FOUND. */
export async function resolveOpenRecipient(
  db: TPrismaOrTransaction,
  token: string,
  now: Date,
): Promise<Extract<ResolvedRecipient, { kind: "OK" }>> {
  const resolved = await resolveRecipient(db, token, now);
  if (resolved.kind !== "OK") return notFound();
  return resolved;
}
