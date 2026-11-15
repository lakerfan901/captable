import "server-only";

import { generatePublicId } from "@/common/id";
import { normalizePortalEmail } from "@/lib/portal/visibility-core";
import { Audit } from "@/server/audit";
import type { TPrismaOrTransaction } from "@/server/db";
import { guardedUpdate } from "@/server/guarded-write";
import { issueToken, lockPortalUser } from "./account";
import { emitPortalAccountEmail } from "./account-email";

// Portal access admin: the one place an access is created (04-investor-portal
// .md 5.2 "Invitation", 5.6, rules P1–P3, P9, P29–P31; package P3).
//
// P1: access exists only because a Manager user invited this address for
// this holder. Nothing here (or anywhere) matches an address to
// `Stakeholder.email` / `noticeEmail`.
//
// CONCURRENCY. The portal user row is created with INSERT … ON CONFLICT DO
// NOTHING (`createMany({ skipDuplicates })`): a duplicate email never raises
// P2002, which would abort the surrounding Postgres transaction. Then the
// user's row lock (`lockPortalUser`, the lock every writer of a user's
// credentials, sessions and tokens takes) serialises every invite of that
// person: a second, concurrent invite for the same holder (double click, two
// team members) waits, re-reads, finds the access the first one created and
// does nothing. `@@unique([portalUserId, stakeholderId])` is the backstop.
// Re-activation is a guarded single-row update on `status: "DISABLED"`.
//
// ISOLATION. A `PortalUser` is global (one address, many companies). Team
// code reads it only through an access row of its own company and shows
// only company-scoped facts (`describeAccess`): this access's status, its
// invitation and last-seen times, whether the person has set up THIS access.
// Never the user's name, sign-in time, or anything about other accesses.
// Residual: the plan's "access added" email (5.2) is logged on the member's
// Emails tab by the account-email worker (P2b), which still lets the team
// infer that the address already had a portal password.

export type InviteOutcome =
  /** A new access row. */
  | "CREATED"
  /** A DISABLED access at this address was switched back on. */
  | "REACTIVATED"
  /** The access already existed and is ACTIVE: nothing was written or sent. */
  | "ALREADY_ACTIVE"
  /** The access exists and is DISABLED, and `reactivateDisabled` was false: nothing was written or sent. */
  | "LEFT_DISABLED";

export type InviteEmailKind = "INVITE" | "ACCESS_ADDED";

export interface InviteHolderInput {
  companyId: string;
  stakeholderId: string;
  /** Any form; normalised with `normalizePortalEmail`. */
  email: string;
  /** Stored only when the portal user is created by this call. */
  name?: string | null;
  /** `Member.id` of the Manager user who confirmed the invitation. */
  invitedById: string;
  /**
   * `portalAdmin.invite`: true (inviting again switches a DISABLED access
   * back on). The release dialog (P4b): false, a deliberate Disable is left
   * as it is and reported (`LEFT_DISABLED`).
   */
  reactivateDisabled: boolean;
  /** For the `portal.access-invited` audit row. */
  audit: {
    actorUserId: string;
    actorName: string;
    requestIp: string;
    userAgent: string;
  };
  now?: Date;
}

export interface InviteHolderResult {
  outcome: InviteOutcome;
  /** `PortalAccess.id` (server only). */
  accessId: string;
  /** `PortalAccess.publicId` (the id the team UI and the portal use). */
  accessPublicId: string;
  /** The normalised address. */
  email: string;
  /** The email to queue after commit; null when nothing is sent. */
  emailKind: InviteEmailKind | null;
  /** The SET_PASSWORD token row (INVITE only). Never a secret. */
  tokenId?: string;
}

export class InviteRefusedError extends Error {
  constructor(
    readonly reason: "INVALID_EMAIL" | "HOLDER_NOT_FOUND",
    message: string,
  ) {
    super(message);
    this.name = "InviteRefusedError";
  }
}

/**
 * Invites `email` to the portal for one holder (5.2, 5.6). Call inside a
 * transaction; the caller has already run `assertMailDeliverable(
 * "MEMBER_EMAIL")` (P30) before any write. After the transaction commits,
 * pass the result to `queueInviteEmail`.
 *
 * - The holder must exist in `companyId` (any `memberStatus`, P3); else
 *   `InviteRefusedError("HOLDER_NOT_FOUND")`. An address that does not
 *   normalise is `InviteRefusedError("INVALID_EMAIL")`.
 * - The portal user is found or created by the normalised address.
 * - No access yet: one is created (ACTIVE). DISABLED: switched back on only
 *   with `reactivateDisabled`. ACTIVE: nothing happens (no email, no audit),
 *   so a double click or a second team member sends one invitation.
 * - Email: the user has no password → a SET_PASSWORD token (7 days) and the
 *   invitation (`INVITE`); a password exists → the "access added" email
 *   (`ACCESS_ADDED`), no token.
 * - Writes `inviteSentAt` (the time the invitation was queued) and the
 *   `portal.access-invited` audit row naming holder and address.
 */
export async function inviteHolder(
  tx: TPrismaOrTransaction,
  input: InviteHolderInput,
): Promise<InviteHolderResult> {
  const now = input.now ?? new Date();
  const email = normalizePortalEmail(input.email);
  if (email === null) {
    throw new InviteRefusedError(
      "INVALID_EMAIL",
      "Enter a valid email address.",
    );
  }
  const holder = await tx.stakeholder.findFirst({
    where: { id: input.stakeholderId, companyId: input.companyId },
    select: { id: true, name: true, companyId: true },
  });
  if (holder === null) {
    throw new InviteRefusedError("HOLDER_NOT_FOUND", "Member not found.");
  }

  // Find or create the person, without a unique-violation error.
  const name = input.name?.trim() ? input.name.trim().slice(0, 200) : null;
  await tx.portalUser.createMany({
    data: [{ email, name }],
    skipDuplicates: true,
  });
  const found = await tx.portalUser.findUnique({
    where: { email },
    select: { id: true },
  });
  if (found === null) throw new Error("Portal user missing after insert");
  const user = await lockPortalUser(tx, found.id);
  if (user === null) throw new Error("Portal user missing under lock");

  const existing = await tx.portalAccess.findUnique({
    where: {
      portalUserId_stakeholderId: {
        portalUserId: user.id,
        stakeholderId: holder.id,
      },
    },
    select: { id: true, publicId: true, status: true, companyId: true },
  });
  // A holder never changes company, so an existing row is this company's.
  if (existing !== null && existing.companyId !== holder.companyId) {
    throw new InviteRefusedError("HOLDER_NOT_FOUND", "Member not found.");
  }

  const nothing = (
    outcome: "ALREADY_ACTIVE" | "LEFT_DISABLED",
    row: { id: string; publicId: string },
  ): InviteHolderResult => ({
    outcome,
    accessId: row.id,
    accessPublicId: row.publicId,
    email,
    emailKind: null,
  });

  let outcome: "CREATED" | "REACTIVATED";
  let access: { id: string; publicId: string };
  if (existing === null) {
    access = await tx.portalAccess.create({
      data: {
        publicId: generatePublicId(),
        portalUserId: user.id,
        companyId: holder.companyId,
        stakeholderId: holder.id,
        status: "ACTIVE",
        invitedById: input.invitedById,
        invitedAt: now,
        inviteSentAt: now,
      },
      select: { id: true, publicId: true },
    });
    outcome = "CREATED";
  } else if (existing.status === "ACTIVE") {
    return nothing("ALREADY_ACTIVE", existing);
  } else if (!input.reactivateDisabled) {
    return nothing("LEFT_DISABLED", existing);
  } else {
    const row = await guardedUpdate(() =>
      tx.portalAccess.update({
        where: {
          id: existing.id,
          companyId: holder.companyId,
          status: "DISABLED",
        },
        data: {
          status: "ACTIVE",
          disabledAt: null,
          disabledById: null,
          invitedById: input.invitedById,
          invitedAt: now,
          inviteSentAt: now,
        },
        select: { id: true, publicId: true },
      }),
    );
    // Every writer of access status (invite, `setAccessStatus`) holds the
    // user lock, so the row read above is current; the guard is a backstop.
    if (row === null) return nothing("ALREADY_ACTIVE", existing);
    access = row;
    outcome = "REACTIVATED";
  }

  let emailKind: InviteEmailKind;
  let tokenId: string | undefined;
  if (user.passwordHash === null) {
    const issued = await issueToken(tx, {
      portalUserId: user.id,
      purpose: "SET_PASSWORD",
      requestIp: input.audit.requestIp,
      now,
    });
    emailKind = "INVITE";
    tokenId = issued.tokenId;
  } else {
    emailKind = "ACCESS_ADDED";
  }

  await Audit.create(
    {
      action: "portal.access-invited",
      companyId: holder.companyId,
      actor: { type: "user", id: input.audit.actorUserId },
      context: {
        requestIp: input.audit.requestIp,
        userAgent: input.audit.userAgent,
      },
      target: [
        { type: "portalAccess", id: access.id },
        { type: "stakeholder", id: holder.id },
      ],
      summary: `${input.audit.actorName} ${
        outcome === "REACTIVATED" ? "re-invited" : "invited"
      } ${email} to the investor portal for ${holder.name}`,
    },
    tx,
  );

  return {
    outcome,
    accessId: access.id,
    accessPublicId: access.publicId,
    email,
    emailKind,
    tokenId,
  };
}

/**
 * Queues the email of an invitation or re-sent invitation. Call AFTER the
 * transaction that wrote the token / access row has committed. Never throws
 * (see `emitPortalAccountEmail`). The job carries row ids only: INVITE names
 * the token and the access (so the email names this holder and the email log
 * lands on this member), ACCESS_ADDED the access.
 */
export async function queueInviteEmail(result: {
  accessId: string;
  emailKind: InviteEmailKind | null;
  tokenId?: string;
}): Promise<void> {
  if (result.emailKind === "INVITE" && result.tokenId) {
    await emitPortalAccountEmail({
      kind: "INVITE",
      tokenId: result.tokenId,
      accessId: result.accessId,
    });
  } else if (result.emailKind === "ACCESS_ADDED") {
    await emitPortalAccountEmail({
      kind: "ACCESS_ADDED",
      accessId: result.accessId,
    });
  }
}

/**
 * Re-sends the invitation of one ACTIVE access (`portalAdmin.resendInvite`).
 * Same email rule as `inviteHolder`: a new SET_PASSWORD token while the
 * person has no password (older unused ones are retired), else the "access
 * added" email. Takes the user's row lock. Null when the access is not
 * ACTIVE in `companyId`.
 */
export async function prepareResend(
  tx: TPrismaOrTransaction,
  input: {
    companyId: string;
    accessPublicId: string;
    requestIp: string;
    now?: Date;
  },
): Promise<{
  accessId: string;
  stakeholderId: string;
  email: string;
  emailKind: InviteEmailKind;
  tokenId?: string;
} | null> {
  const now = input.now ?? new Date();
  const access = await tx.portalAccess.findFirst({
    where: { publicId: input.accessPublicId, companyId: input.companyId },
    select: { id: true, portalUserId: true, stakeholderId: true },
  });
  if (access === null) return null;
  const user = await lockPortalUser(tx, access.portalUserId);
  if (user === null) return null;
  // Re-read under the lock (Disable takes the same lock): a Disable that
  // committed meanwhile wins. The guarded update stays as the backstop.
  const current = await tx.portalAccess.findFirst({
    where: { id: access.id, companyId: input.companyId, status: "ACTIVE" },
    select: { id: true },
  });
  if (current === null) return null;
  const sent = await guardedUpdate(() =>
    tx.portalAccess.update({
      where: { id: access.id, companyId: input.companyId, status: "ACTIVE" },
      data: { inviteSentAt: now },
      select: { id: true },
    }),
  );
  if (sent === null) return null;
  if (user.passwordHash === null) {
    const issued = await issueToken(tx, {
      portalUserId: user.id,
      purpose: "SET_PASSWORD",
      requestIp: input.requestIp,
      now,
    });
    return {
      accessId: access.id,
      stakeholderId: access.stakeholderId,
      email: user.email,
      emailKind: "INVITE",
      tokenId: issued.tokenId,
    };
  }
  return {
    accessId: access.id,
    stakeholderId: access.stakeholderId,
    email: user.email,
    emailKind: "ACCESS_ADDED",
  };
}
