import { render } from "react-email";
import PortalAccessAddedEmail from "@/emails/PortalAccessAddedEmail";
import PortalInviteEmail from "@/emails/PortalInviteEmail";
import PortalLockedEmail from "@/emails/PortalLockedEmail";
import PortalPasswordChangedEmail from "@/emails/PortalPasswordChangedEmail";
import PortalPasswordResetEmail from "@/emails/PortalPasswordResetEmail";
import { env } from "@/env";
import { logger } from "@/lib/logger";
import {
  expiryPhrase,
  PORTAL_EMAIL_LOG_KIND,
  portalEmailSubject,
  utcInstant,
} from "@/lib/portal/account-email-core";
import { db } from "@/server/db";
import { currentMailDelivery } from "@/server/mail-delivery";
import { type EmailLogContext, sendMail } from "@/server/mailer";
import { mintTokenForDelivery } from "@/server/portal/account";
import {
  type PortalAccountEmailData,
  portalAccountEmailConfig,
} from "@/server/portal/account-email";
import { defineWorker } from "../lib/queue";

// `portal.account-email` (04-investor-portal.md 5.2, 5.8; package P2b): one
// account email per job. The job name, payload and `emitPortalAccountEmail`
// are in src/server/portal/account-email.ts (P2a).
//
// - INVITE / RESET `{ tokenId, accessId? }`: the token row must still be
//   usable and the user must have an ACTIVE access (P9). Only then is the
//   secret minted (`mintTokenForDelivery` puts a fresh secret on the row and
//   returns it once, in memory); a null mint (used, retired, expired) sends
//   nothing. The link goes into the email body only: never into the subject,
//   a log line, an error, the EmailLog row or the job's result.
// - ACCESS_ADDED `{ accessId }`: ACTIVE access only; link to the sign-in page.
// - PASSWORD_CHANGED / LOCKED `{ eventId }`: the PortalAccessLog row of the
//   PASSWORD_SET / ACCOUNT_LOCKED event; no link.
//
// Production guard: while EMAIL_SERVER is the bundled mail catcher in
// production (`currentMailDelivery("MEMBER_EMAIL")`), nothing is minted and
// nothing is sent. Every send goes through `sendMail`, which writes the
// EmailLog row. `stakeholderId` is passed explicitly with `companyId` (or
// neither is passed), so `sendMail` never matches an address to a holder
// (P1).
//
// Delivery is at least once: a send that fails throws and pg-boss retries
// (a retry of INVITE / RESET mints again, so only the latest link works).
// Nothing runs after a successful `sendMail`, so a send is never repeated
// because of a later error. The handler returns nothing (pg-boss stores a
// handler's result).

const log = logger.child({ module: "portal-account-email" });

export type PortalAccountEmailOutcome =
  | "SENT"
  | "MAIL_BLOCKED"
  | "TOKEN_UNUSABLE"
  | "NO_ACTIVE_ACCESS"
  | "NOT_FOUND";

interface Outgoing {
  to: string;
  subject: string;
  html: string;
  fromName?: string;
  logContext: EmailLogContext;
}

export interface PortalAccountEmailDeps {
  send: typeof sendMail;
  now: () => Date;
}

const defaultDeps: PortalAccountEmailDeps = {
  send: sendMail,
  now: () => new Date(),
};

/** The holder and company an access names, for the wording (null parts stay generic). */
async function accessNames(access: {
  companyId: string;
  stakeholderId: string;
}): Promise<{ companyName: string | null; holderName: string | null }> {
  const [company, holder] = await Promise.all([
    db.company.findUnique({
      where: { id: access.companyId },
      select: { name: true },
    }),
    db.stakeholder.findFirst({
      where: { id: access.stakeholderId, companyId: access.companyId },
      select: { name: true },
    }),
  ]);
  return {
    companyName: company?.name ?? null,
    holderName: holder?.name ?? null,
  };
}

const accessSelect = {
  id: true,
  companyId: true,
  stakeholderId: true,
  portalUserId: true,
} as const;

/** INVITE / RESET: check, then mint, then build the email. */
async function linkEmail(
  data: PortalAccountEmailData,
  now: Date,
): Promise<Outgoing | PortalAccountEmailOutcome> {
  const tokenId = data.tokenId;
  if (!tokenId) return "NOT_FOUND";
  const row = await db.portalAccountToken.findUnique({
    where: { id: tokenId },
    select: { portalUserId: true, usedAt: true, expiresAt: true },
  });
  if (row === null) return "NOT_FOUND";
  if (row.usedAt !== null || !(row.expiresAt.getTime() > now.getTime())) {
    return "TOKEN_UNUSABLE";
  }
  // The access the invitation is about: the one named in the job when it
  // belongs to this user and is ACTIVE, else the user's newest ACTIVE one.
  const named = data.accessId
    ? await db.portalAccess.findFirst({
        where: {
          id: data.accessId,
          portalUserId: row.portalUserId,
          status: "ACTIVE",
        },
        select: accessSelect,
      })
    : null;
  const access =
    named ??
    (await db.portalAccess.findFirst({
      where: { portalUserId: row.portalUserId, status: "ACTIVE" },
      orderBy: [{ invitedAt: "desc" }, { id: "desc" }],
      select: accessSelect,
    }));
  if (access === null) return "NO_ACTIVE_ACCESS";

  const minted = await mintTokenForDelivery(db, tokenId, now);
  if (minted === null) return "TOKEN_UNUSABLE";
  const expiresIn = expiryPhrase(minted.expiresAt, now);

  if (data.kind === "RESET") {
    return {
      to: minted.email,
      subject: portalEmailSubject("RESET"),
      html: await render(
        PortalPasswordResetEmail({ link: minted.url, expiresIn }),
      ),
      logContext: {
        kind: PORTAL_EMAIL_LOG_KIND.RESET,
        relatedType: "portalUser",
        relatedId: minted.portalUserId,
      },
    };
  }
  const names = await accessNames(access);
  return {
    to: minted.email,
    subject: portalEmailSubject("INVITE", names),
    html: await render(
      PortalInviteEmail({ ...names, link: minted.url, expiresIn }),
    ),
    fromName: names.companyName ?? undefined,
    logContext: {
      kind: PORTAL_EMAIL_LOG_KIND.INVITE,
      companyId: access.companyId,
      stakeholderId: access.stakeholderId,
      relatedType: "portalAccess",
      relatedId: access.id,
    },
  };
}

async function accessAddedEmail(
  data: PortalAccountEmailData,
): Promise<Outgoing | PortalAccountEmailOutcome> {
  if (!data.accessId) return "NOT_FOUND";
  const access = await db.portalAccess.findFirst({
    where: { id: data.accessId, status: "ACTIVE" },
    select: { ...accessSelect, portalUser: { select: { email: true } } },
  });
  if (access === null || access.portalUser === null) return "NO_ACTIVE_ACCESS";
  const names = await accessNames(access);
  return {
    to: access.portalUser.email,
    subject: portalEmailSubject("ACCESS_ADDED", names),
    html: await render(
      PortalAccessAddedEmail({
        ...names,
        signInUrl: `${env.NEXT_PUBLIC_BASE_URL}/portal/sign-in`,
      }),
    ),
    fromName: names.companyName ?? undefined,
    logContext: {
      kind: PORTAL_EMAIL_LOG_KIND.ACCESS_ADDED,
      companyId: access.companyId,
      stakeholderId: access.stakeholderId,
      relatedType: "portalAccess",
      relatedId: access.id,
    },
  };
}

async function eventEmail(
  data: PortalAccountEmailData,
): Promise<Outgoing | PortalAccountEmailOutcome> {
  if (!data.eventId) return "NOT_FOUND";
  const event = data.kind === "LOCKED" ? "ACCOUNT_LOCKED" : "PASSWORD_SET";
  const row = await db.portalAccessLog.findFirst({
    where: { id: data.eventId, event },
    select: { portalUserId: true, createdAt: true },
  });
  if (row === null) return "NOT_FOUND";
  const user = await db.portalUser.findUnique({
    where: { id: row.portalUserId },
    select: { id: true, email: true },
  });
  if (user === null) return "NOT_FOUND";
  const at = utcInstant(row.createdAt);
  const kind = data.kind === "LOCKED" ? "LOCKED" : "PASSWORD_CHANGED";
  return {
    to: user.email,
    subject: portalEmailSubject(kind),
    html: await render(
      kind === "LOCKED"
        ? PortalLockedEmail({ email: user.email, lockedAt: at })
        : PortalPasswordChangedEmail({ email: user.email, changedAt: at }),
    ),
    logContext: {
      kind: PORTAL_EMAIL_LOG_KIND[kind],
      relatedType: "portalUser",
      relatedId: user.id,
    },
  };
}

/**
 * Builds and sends one account email. Returns what happened (for the
 * integration script); the worker discards it. Throws only when the send
 * itself fails (pg-boss retries).
 */
export async function deliverPortalAccountEmail(
  data: PortalAccountEmailData,
  deps: PortalAccountEmailDeps = defaultDeps,
): Promise<PortalAccountEmailOutcome> {
  const ref = {
    kind: data.kind,
    tokenId: data.tokenId,
    accessId: data.accessId,
    eventId: data.eventId,
  };
  if (currentMailDelivery("MEMBER_EMAIL").blockedReason !== null) {
    log.warn(ref, "[Portal] account email not sent: mail is not deliverable");
    return "MAIL_BLOCKED";
  }
  const now = deps.now();
  let outgoing: Outgoing | PortalAccountEmailOutcome;
  switch (data.kind) {
    case "INVITE":
    case "RESET":
      outgoing = await linkEmail(data, now);
      break;
    case "ACCESS_ADDED":
      outgoing = await accessAddedEmail(data);
      break;
    case "PASSWORD_CHANGED":
    case "LOCKED":
      outgoing = await eventEmail(data);
      break;
  }
  if (typeof outgoing === "string") {
    log.info({ ...ref, outcome: outgoing }, "[Portal] account email skipped");
    return outgoing;
  }
  await deps.send(
    {
      to: outgoing.to,
      subject: outgoing.subject,
      html: outgoing.html,
      ...(outgoing.fromName
        ? { headers: { "X-From-Name": outgoing.fromName } }
        : {}),
    },
    outgoing.logContext,
  );
  return "SENT";
}

export const portalAccountEmailWorker = defineWorker(
  portalAccountEmailConfig,
  async (job) => {
    await deliverPortalAccountEmail(job.data);
  },
);
