import { TRPCError } from "@trpc/server";
import { emitBallotEmails } from "@/jobs/governance-ballot-email";
import { ballotTokenExpiry } from "@/lib/governance/token-payload";
import { Audit } from "@/server/audit";
import type { PrismaTransactionalClient } from "@/server/db";
import { emitAfterCommit } from "@/server/governance/emit";
import { recordEvent } from "@/server/governance/events";
import { guardedWrite } from "@/server/governance/guarded";
import { lockResolution } from "@/server/governance/tally";
import { withLlcAccessControl } from "@/trpc/api/trpc";
import { ZResolutionReplaceBallotLinkSchema } from "../schema";

// resolution.replaceBallotLink (03-governance.md G8): issues a new link for an
// unsubmitted ballot of a SENT resolution. The token version is bumped, so the
// old URL resolves to REPLACED (ballot.submit re-checks the version at write
// time). Optionally changes the ballot email (C3.2: only here, only while
// unsubmitted). The new link is emailed by the invite job after commit; the
// URL itself is never returned, logged, or written to an event or audit row.
//
// Changing the email (owner ruling, H1):
// - the old and the new address are written to the LINK_REPLACED event and
//   the `ballot.link-replaced` audit row;
// - after commit, the PREVIOUS address and the Member's notice email on file
//   are told that the link was re-issued to a different address (no link in
//   that notice; ballot-email job, kind ADDRESS_CHANGED);
// - the evidence CSV and the executed PDF show the change (original address
//   = the frozen register entry's);
// - when the resolution needs a Disinterested vote, the new address must be
//   the Member's notice email / email on file: anything else is refused
//   until the Member's record is updated.

const DISINTERESTED_BASES = [
  "DISINTERESTED_MAJORITY",
  "DISINTERESTED_67",
  "DISINTERESTED_70",
] as const;

function badRequest(message: string): never {
  throw new TRPCError({ code: "BAD_REQUEST", message });
}

/**
 * Locks the resolution and loads it with one of its ballots; both must belong
 * to the company (NOT_FOUND otherwise). The resolution must be SENT with its
 * response period still open, and the ballot unsubmitted.
 */
export async function loadOpenBallotForLinkChange(
  tx: PrismaTransactionalClient,
  companyId: string,
  publicId: string,
  ballotId: string,
  now: Date,
) {
  const found = await tx.resolution.findFirst({
    where: { publicId, companyId },
    select: { id: true },
  });
  if (!found) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "Resolution not found.",
    });
  }
  await lockResolution(tx, found.id);
  const resolution = await tx.resolution.findFirst({
    where: { id: found.id, companyId },
    select: {
      id: true,
      status: true,
      closesAt: true,
      title: true,
      referenceCode: true,
    },
  });
  const ballot = await tx.resolutionBallot.findFirst({
    where: { id: ballotId, resolutionId: found.id, companyId },
  });
  if (!resolution || !ballot) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Ballot not found." });
  }
  if (
    resolution.status !== "SENT" ||
    (resolution.closesAt !== null &&
      resolution.closesAt.getTime() <= now.getTime())
  ) {
    badRequest("Ballot links can be changed only while the vote is open.");
  }
  if (ballot.submittedAt !== null) {
    badRequest(`${ballot.name} has already responded.`);
  }
  return { resolution, ballot };
}

export const replaceBallotLinkProcedure = withLlcAccessControl
  .meta({ policies: { governance: { allow: ["update"] } } })
  .input(ZResolutionReplaceBallotLinkSchema)
  .mutation(async ({ ctx, input }) => {
    const companyId = ctx.membership.companyId;
    const now = new Date();
    const userName = ctx.session.user.name ?? "A user";

    const result = await ctx.db.$transaction(
      async (tx) => {
        const { resolution, ballot } = await loadOpenBallotForLinkChange(
          tx,
          companyId,
          input.publicId,
          input.ballotId,
          now,
        );
        const newEmail =
          input.email !== undefined && input.email !== ballot.email
            ? input.email
            : null;
        const tokenVersion = ballot.tokenVersion + 1;

        if (newEmail !== null) {
          const disinterested = await tx.resolutionRequirement.findFirst({
            where: {
              resolutionId: resolution.id,
              kind: "UNIT_VOTE",
              basis: { in: [...DISINTERESTED_BASES] },
            },
            select: { id: true },
          });
          if (disinterested) {
            const stakeholder = await tx.stakeholder.findFirst({
              where: { id: ballot.stakeholderId, companyId },
              select: { email: true, noticeEmail: true },
            });
            const onFile = [stakeholder?.noticeEmail, stakeholder?.email]
              .map((e) => e?.trim().toLowerCase())
              .filter((e): e is string => !!e);
            if (!onFile.includes(newEmail.trim().toLowerCase())) {
              badRequest(
                `This resolution requires a Disinterested vote, so the ballot of ${ballot.name} can only be re-issued to the Member's email address on file. Update the Member's record first.`,
              );
            }
          }
        }

        const replaced = await guardedWrite(() =>
          tx.resolutionBallot.update({
            where: {
              id: ballot.id,
              companyId,
              submittedAt: null,
              tokenVersion: ballot.tokenVersion,
            },
            data: {
              tokenVersion,
              tokenRevokedAt: null,
              tokenExpiresAt: ballotTokenExpiry(now, resolution.closesAt),
              ...(newEmail !== null ? { email: newEmail } : {}),
            },
            select: { id: true },
          }),
        );
        if (!replaced) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "This ballot changed at the same moment. Reload the page.",
          });
        }

        const refLabel = resolution.referenceCode ?? resolution.title;
        const summary =
          newEmail !== null
            ? `${userName} replaced the ballot link of ${ballot.name} on ${refLabel} and changed the email from ${ballot.email} to ${newEmail}`
            : `${userName} replaced the ballot link of ${ballot.name} on ${refLabel}`;
        await recordEvent(tx, {
          resolutionId: resolution.id,
          companyId,
          ballotId: ballot.id,
          type: "LINK_REPLACED",
          actorType: "user",
          actorId: ctx.session.user.id,
          summary,
          ip: ctx.requestIp,
          userAgent: ctx.userAgent,
        });
        await Audit.create(
          {
            action: "ballot.link-replaced",
            companyId,
            actor: { type: "user", id: ctx.session.user.id },
            context: { requestIp: ctx.requestIp, userAgent: ctx.userAgent },
            target: [
              { type: "resolution", id: resolution.id },
              { type: "ballot", id: ballot.id },
            ],
            summary,
          },
          tx,
        );
        return {
          ballotId: ballot.id,
          tokenVersion,
          previousEmail: newEmail !== null ? ballot.email : null,
        };
      },
      { maxWait: 10_000, timeout: 30_000 },
    );

    // After commit only. The link IS replaced: a failed emit is logged and
    // `resolution.remind` re-sends (H2).
    const { ballotId, tokenVersion, previousEmail } = result;
    await emitAfterCommit("ballot link emails", { ballotId }, () =>
      emitBallotEmails([
        { ballotId, kind: "INVITE", seq: tokenVersion },
        ...(previousEmail !== null
          ? [
              {
                ballotId,
                kind: "ADDRESS_CHANGED" as const,
                seq: tokenVersion,
                previousEmail,
              },
            ]
          : []),
      ]),
    );

    return { ok: true as const, tokenVersion: result.tokenVersion };
  });
