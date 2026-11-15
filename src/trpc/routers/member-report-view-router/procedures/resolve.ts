import "server-only";
import { TRPCError } from "@trpc/server";
import {
  type AddresseeAccess,
  addresseeAccess,
} from "@/lib/portal/report-link-core";
import { normalizePortalEmail } from "@/lib/portal/visibility-core";
import type { TPrismaOrTransaction } from "@/server/db";
import { loadLlcCompany } from "@/server/governance/guards";
import { verifyReportToken } from "@/server/governance/tokens";
import { classifyReportAccess } from "../access";

// resolveRecipient (03-governance.md G12; mirrors G8 `resolveBallot`;
// 04-investor-portal.md P25, P26). The ONE entry point of every public
// member-report procedure.
//
// 1. Input schema (`zReportToken`, schema.ts) bounds the token to 20–2048 chars.
// 2. `verifyReportToken`: HS256 (pinned) signature, `exp`, strict payload
//    `p: "mr"` (a ballot, update, data-room or e-sign token never parses).
// 3. The recipient row by the token's recipient id; the report and the
//    company are taken FROM THAT ROW, never from the client or the token;
//    the company must be an LLC (`loadLlcCompany`).
// 4–6. `classifyReportAccess`: not SENT -> NOT_FOUND; revoked or superseded
//    version -> REPLACED; row expiry passed -> NOT_FOUND.
// 7. P25: the report's publish state and the addressee's access decide what
//    the link opens. The addressee's access is the `PortalAccess` OF THIS
//    RECIPIENT'S HOLDER whose portal user's email equals the address the
//    report was emailed to (`MemberReportRecipient.email`). Everything comes
//    from the recipient row; nothing the visitor types is involved, and the
//    comparison chooses a page, it grants nothing (P1).
//
// Every failure throws the same message-less NOT_FOUND, so an invalid,
// forged, expired, foreign-kind or unknown token reveals nothing. Only OK
// (the read-only page, P25 "LEGACY") carries the recipient and the report;
// REPLACED, WITHDRAWN and ACCESS_OFF carry the company name and logo only;
// PORTAL adds the report's public id (the address of the portal page, P26)
// and whether a password must still be set. The ids of the addressee's
// portal user and access stay on the server (`requestSetup` uses them; no
// procedure returns them).
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
  email: true,
  tokenVersion: true,
  tokenExpiresAt: true,
  tokenRevokedAt: true,
  firstViewedAt: true,
  report: {
    select: {
      id: true,
      publicId: true,
      companyId: true,
      type: true,
      status: true,
      title: true,
      noticeKind: true,
      periodStart: true,
      periodEnd: true,
      sentAt: true,
      publishedAt: true,
      unpublishedAt: true,
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

/** The addressee's ACTIVE access (server only), for `requestSetup`. */
export interface AddresseeAccessRow {
  accessId: string;
  portalUserId: string;
}

interface Addressee {
  state: AddresseeAccess;
  /** The ACTIVE access at the addressee's address, when there is one. */
  active: AddresseeAccessRow | null;
}

/**
 * P25 "the addressee's access": every `PortalAccess` of the recipient's
 * holder (in the report's company), reduced by `addresseeAccess` to the one
 * whose portal user's email equals the recipient's address. Another
 * person's access to the same holder (an accountant) never counts.
 */
async function loadAddressee(
  db: TPrismaOrTransaction,
  recipient: { companyId: string; stakeholderId: string; email: string },
): Promise<Addressee> {
  // No foreign keys (`relationMode = "prisma"`): an access whose portal
  // user row is gone is ignored rather than failing every link of the holder.
  const rows = (
    await db.portalAccess.findMany({
      where: {
        companyId: recipient.companyId,
        stakeholderId: recipient.stakeholderId,
      },
      select: {
        id: true,
        status: true,
        portalUser: {
          select: { id: true, email: true, passwordHash: true },
        },
      },
    })
  ).filter((r) => (r.portalUser as typeof r.portalUser | null) !== null);
  const state = addresseeAccess(
    rows.map((r) => ({
      email: r.portalUser.email,
      status: r.status,
      passwordSet: r.portalUser.passwordHash !== null,
    })),
    recipient.email,
  );
  const target = normalizePortalEmail(recipient.email);
  const match =
    target === null
      ? undefined
      : rows.find(
          (r) =>
            r.status === "ACTIVE" &&
            normalizePortalEmail(r.portalUser.email) === target,
        );
  return {
    state,
    active:
      match === undefined
        ? null
        : { accessId: match.id, portalUserId: match.portalUser.id },
  };
}

type CompanyFace = { name: string; logo: string | null };

export type ResolvedRecipient =
  | { kind: "REPLACED"; company: CompanyFace }
  | { kind: "WITHDRAWN"; company: CompanyFace }
  | { kind: "ACCESS_OFF"; company: CompanyFace }
  | {
      kind: "PORTAL";
      company: CompanyFace;
      /** The report's public id (never the token, P26). */
      reportPublicId: string;
      setupNeeded: boolean;
      /** Server only: the addressee's ACTIVE access (for `requestSetup`). */
      addressee: AddresseeAccessRow;
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

  // 7. Loaded before 4–6 so the whole decision is one pure function; the
  // result of an earlier refusal never depends on it.
  const addressee = await loadAddressee(db, recipient);

  // 4–7.
  const { access, setupNeeded } = classifyReportAccess(
    {
      companyEntityType: company.entityType,
      reportStatus: report.status,
      tokenVersion: recipient.tokenVersion,
      tokenRevokedAt: recipient.tokenRevokedAt,
      tokenExpiresAt: recipient.tokenExpiresAt,
      publishedAt: report.publishedAt,
      unpublishedAt: report.unpublishedAt,
      addresseeAccess: addressee.state,
    },
    claims.version,
    now,
  );
  const face = { name: company.name, logo: company.logo };
  switch (access) {
    case "NOT_FOUND":
      return notFound();
    case "REPLACED":
    case "WITHDRAWN":
    case "ACCESS_OFF":
      return { kind: access, company: face };
    case "PORTAL":
      // PORTAL implies an ACTIVE access at the addressee's address.
      if (addressee.active === null) return notFound();
      return {
        kind: "PORTAL",
        company: face,
        reportPublicId: report.publicId,
        setupNeeded,
        addressee: addressee.active,
      };
    case "OK":
      return { kind: "OK", recipient, report, company };
  }
}

/**
 * For procedures that return report content or files (`markViewed`,
 * `attachmentUrl`): the read-only page only (P26). REPLACED, WITHDRAWN,
 * PORTAL and ACCESS_OFF get the same NOT_FOUND.
 */
export async function resolveOpenRecipient(
  db: TPrismaOrTransaction,
  token: string,
  now: Date,
): Promise<Extract<ResolvedRecipient, { kind: "OK" }>> {
  const resolved = await resolveRecipient(db, token, now);
  if (resolved.kind !== "OK") return notFound();
  return resolved;
}
