import { TRPCError } from "@trpc/server";
import { emitResolutionFinalize } from "@/jobs/governance-resolution-finalize";
import { Audit } from "@/server/audit";
import { recordEvent } from "@/server/governance/events";
import {
  evaluateAndTransition,
  lockResolution,
} from "@/server/governance/tally";
import { withLlcAccessControl } from "@/trpc/api/trpc";
import { ZResolutionApproveSchema } from "../schema";
import { closeOverdue } from "./get";

// resolution.approve (03-governance.md G7): records the Common Member's
// approval (Section 12.1(d)) on a SENT resolution. The Manager's approval is
// always given at send (send step 14), so it is never pending here.
//
// Who may sign: a team user with `governance: update` (the G7 table); the
// typed signer name and capacity, the team user (`approvedByMemberId`), the
// time, IP and user agent are recorded with the signature. Write-once: the
// approval columns are written with `updateMany where approvedAt IS NULL`
// under the resolution's row lock, so a second approval (sequential or
// concurrent) gets CONFLICT and changes nothing.

export const approveProcedure = withLlcAccessControl
  .meta({ policies: { governance: { allow: ["update"] } } })
  .input(ZResolutionApproveSchema)
  .mutation(async ({ ctx, input }) => {
    const companyId = ctx.membership.companyId;
    const now = new Date();

    const found = await ctx.db.resolution.findFirst({
      where: { publicId: input.publicId, companyId },
      select: { id: true, status: true, closesAt: true },
    });
    if (!found) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "Resolution not found.",
      });
    }
    // Lazy close first (A7): a signature given after the response period
    // must not make an overdue resolution effective.
    if (
      found.status === "SENT" &&
      found.closesAt !== null &&
      found.closesAt.getTime() < now.getTime()
    ) {
      await closeOverdue(ctx.db, [found.id], now, "resolution.approve");
    }

    const result = await ctx.db.$transaction(async (tx) => {
      await lockResolution(tx, found.id);
      const resolution = await tx.resolution.findFirst({
        where: { id: found.id, companyId },
        select: {
          id: true,
          status: true,
          title: true,
          referenceCode: true,
          closesAt: true,
          frozenHash: true,
        },
      });
      if (!resolution) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Resolution not found.",
        });
      }
      if (resolution.status !== "SENT") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Only a sent resolution that is still open can be approved.",
        });
      }
      if (
        resolution.closesAt !== null &&
        now.getTime() > resolution.closesAt.getTime()
      ) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "The response period for this resolution has ended.",
        });
      }

      const pending = await tx.resolutionRequirement.findFirst({
        where: {
          resolutionId: resolution.id,
          kind: "COMMON_MEMBER_APPROVAL",
          approvedAt: null,
        },
        orderBy: { position: "asc" },
        select: { id: true, section: true },
      });
      if (!pending) {
        const signed = await tx.resolutionRequirement.findFirst({
          where: {
            resolutionId: resolution.id,
            kind: "COMMON_MEMBER_APPROVAL",
          },
          select: { id: true },
        });
        if (signed) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "The Common Member's approval has already been recorded.",
          });
        }
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "This resolution does not require the approval of the Common Member (Section 12.1(d)).",
        });
      }
      if (
        resolution.frozenHash === null ||
        input.bodyHash !== resolution.frozenHash
      ) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "The document changed. Reload the page.",
        });
      }

      const { count } = await tx.resolutionRequirement.updateMany({
        where: {
          id: pending.id,
          resolutionId: resolution.id,
          approvedAt: null,
        },
        data: {
          approvedByMemberId: ctx.membership.memberId,
          approverName: input.signerName,
          approverCapacity: input.signerCapacity,
          approvedAt: now,
          approvalIp: ctx.requestIp,
          approvalUserAgent: ctx.userAgent,
        },
      });
      if (count !== 1) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "The Common Member's approval has already been recorded.",
        });
      }

      const ref = resolution.referenceCode ?? resolution.title;
      await recordEvent(tx, {
        resolutionId: resolution.id,
        companyId,
        type: "COMMON_MEMBER_SIGNED",
        actorType: "user",
        actorId: ctx.session.user.id,
        summary: `${input.signerName} (${input.signerCapacity}) signed ${ref} for the Common Member (Section ${pending.section})`,
        ip: ctx.requestIp,
        userAgent: ctx.userAgent,
      });
      await Audit.create(
        {
          action: "resolution.approved",
          companyId,
          actor: { type: "user", id: ctx.session.user.id },
          context: { requestIp: ctx.requestIp, userAgent: ctx.userAgent },
          target: [{ type: "resolution", id: resolution.id }],
          summary: `${ctx.session.user.name ?? "A user"} signed ${ref} "${resolution.title}" for the Common Member as ${input.signerName}, ${input.signerCapacity}`,
        },
        tx,
      );

      const transition = await evaluateAndTransition(tx, resolution.id, now, {
        type: "user",
        id: ctx.session.user.id,
        ip: ctx.requestIp,
        userAgent: ctx.userAgent,
      });
      return { transition };
    });

    // After commit only.
    if (result.transition) {
      await emitResolutionFinalize(result.transition.resolutionId);
    }
    return {
      publicId: input.publicId,
      status: result.transition?.to ?? ("SENT" as const),
    };
  });
