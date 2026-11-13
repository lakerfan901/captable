import "server-only";
import { TRPCError } from "@trpc/server";
import type { TPrismaOrTransaction } from "@/server/db";
import { loadLlcCompany } from "@/server/governance/guards";
import { verifyBallotToken } from "@/server/governance/tokens";
import { classifyBallotAccess } from "../access";

// resolveBallot (03-governance.md G8, "Token validation — exact order"). The
// ONE entry point of every public ballot procedure.
//
// 1. Input schema (`zBallotToken`, schema.ts) bounds the token to 20–2048 chars.
// 2. `verifyBallotToken`: HS256 signature, `exp`, strict payload `p: "rb"`.
// 3. The ballot row by the token's ballot id; the resolution and the company
//    are taken FROM THAT ROW, never from the client; the company must be an
//    LLC (`loadLlcCompany`).
// 4–6. `classifyBallotAccess`: DRAFT -> NOT_FOUND; revoked or superseded
//    version -> REPLACED; row expiry passed -> NOT_FOUND.
//
// Every failure throws the same message-less NOT_FOUND, so an invalid,
// forged, expired, foreign-kind or unknown token reveals nothing. REPLACED is
// only reachable with a correctly signed, unexpired token and carries the
// company name and logo only (no resolution content, no ballot state).
//
// The token itself is never logged, stored, put in an error or in an audit
// row: it is used for `verifyBallotToken` and then dropped.

const notFound = (): never => {
  throw new TRPCError({ code: "NOT_FOUND" });
};

const ballotSelect = {
  id: true,
  resolutionId: true,
  companyId: true,
  stakeholderId: true,
  name: true,
  preferredUnits: true,
  countsPreferred: true,
  countsDisinterested: true,
  tokenVersion: true,
  tokenExpiresAt: true,
  tokenRevokedAt: true,
  firstViewedAt: true,
  choice: true,
  deemed: true,
  signedName: true,
  signerCapacity: true,
  submittedAt: true,
  resolution: {
    select: {
      id: true,
      companyId: true,
      type: true,
      status: true,
      title: true,
      referenceCode: true,
      recordDate: true,
      sentAt: true,
      closesAt: true,
      effectiveAt: true,
      closedAt: true,
      withdrawnReason: true,
      frozenContent: true,
      frozenHash: true,
      executedDocumentId: true,
    },
  },
} as const;

type LlcCompany = Awaited<ReturnType<typeof loadLlcCompany>>;

async function loadBallot(db: TPrismaOrTransaction, ballotId: string) {
  return await db.resolutionBallot.findUnique({
    where: { id: ballotId },
    select: ballotSelect,
  });
}

type LoadedBallot = NonNullable<Awaited<ReturnType<typeof loadBallot>>>;

export type ResolvedBallot =
  | {
      kind: "REPLACED";
      company: { name: string; logo: string | null };
    }
  | {
      kind: "OK";
      /** The token's version; used by `submit` in its guarded write. */
      tokenVersion: number;
      ballot: Omit<LoadedBallot, "resolution">;
      resolution: LoadedBallot["resolution"];
      company: LlcCompany;
    };

export async function resolveBallot(
  db: TPrismaOrTransaction,
  token: string,
  now: Date,
): Promise<ResolvedBallot> {
  // 2. Signature, exp, purpose and strict payload. Null on any failure.
  const claims = await verifyBallotToken(token);
  if (claims === null) return notFound();

  // 3. The row named by the signed claim; everything else hangs off it.
  const row = await loadBallot(db, claims.ballotId);
  if (row === null) return notFound();
  const { resolution, ...ballot } = row;
  // Defence in depth: the ballot and its resolution belong to one company.
  if (ballot.companyId !== resolution.companyId) return notFound();
  // Throws NOT_FOUND unless the company of the ROW is an LLC.
  const company = await loadLlcCompany(db, resolution.companyId);

  // 4–6.
  const access = classifyBallotAccess(
    {
      companyEntityType: company.entityType,
      resolutionStatus: resolution.status,
      tokenVersion: ballot.tokenVersion,
      tokenRevokedAt: ballot.tokenRevokedAt,
      tokenExpiresAt: ballot.tokenExpiresAt,
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

  // 7.
  return {
    kind: "OK",
    tokenVersion: claims.version,
    ballot,
    resolution,
    company,
  };
}

/** For procedures that accept an OK link only: REPLACED gets the same NOT_FOUND. */
export async function resolveOpenBallot(
  db: TPrismaOrTransaction,
  token: string,
  now: Date,
): Promise<Extract<ResolvedBallot, { kind: "OK" }>> {
  const resolved = await resolveBallot(db, token, now);
  if (resolved.kind !== "OK") return notFound();
  return resolved;
}
