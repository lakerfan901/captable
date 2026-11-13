import { TRPCError } from "@trpc/server";
import { Audit } from "@/server/audit";
import { recordEvent } from "@/server/governance/events";
import { guardedWrite } from "@/server/governance/guarded";
import { withLlcAccessControl } from "@/trpc/api/trpc";
import { ZResolutionRevokeBallotLinkSchema } from "../schema";
import { loadOpenBallotForLinkChange } from "./replace-link";

// resolution.revokeBallotLink (03-governance.md G8): disables the current link
// of an unsubmitted ballot (the page shows REPLACED; ballot.submit re-checks
// the revoked flag at write time). The ballot stays in the denominator: the
// frozen register decides that, not the link. replaceBallotLink re-enables it.

export const revokeBallotLinkProcedure = withLlcAccessControl
  .meta({ policies: { governance: { allow: ["update"] } } })
  .input(ZResolutionRevokeBallotLinkSchema)
  .mutation(async ({ ctx, input }) => {
    const companyId = ctx.membership.companyId;
    const now = new Date();
    const userName = ctx.session.user.name ?? "A user";

    await ctx.db.$transaction(
      async (tx) => {
        const { resolution, ballot } = await loadOpenBallotForLinkChange(
          tx,
          companyId,
          input.publicId,
          input.ballotId,
          now,
        );
        if (ballot.tokenRevokedAt !== null) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `The link of ${ballot.name} is already revoked.`,
          });
        }
        const revoked = await guardedWrite(() =>
          tx.resolutionBallot.update({
            where: {
              id: ballot.id,
              companyId,
              submittedAt: null,
              tokenRevokedAt: null,
            },
            data: { tokenRevokedAt: now },
            select: { id: true },
          }),
        );
        if (!revoked) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "This ballot changed at the same moment. Reload the page.",
          });
        }

        const summary = `${userName} revoked the ballot link of ${ballot.name} on ${resolution.referenceCode ?? resolution.title}`;
        await recordEvent(tx, {
          resolutionId: resolution.id,
          companyId,
          ballotId: ballot.id,
          type: "LINK_REVOKED",
          actorType: "user",
          actorId: ctx.session.user.id,
          summary,
          ip: ctx.requestIp,
          userAgent: ctx.userAgent,
        });
        await Audit.create(
          {
            action: "ballot.link-revoked",
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
      },
      { maxWait: 10_000, timeout: 30_000 },
    );

    return { ok: true as const };
  });
