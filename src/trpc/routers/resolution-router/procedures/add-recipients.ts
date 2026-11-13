import { TRPCError } from "@trpc/server";
import { emitBallotEmails } from "@/jobs/governance-ballot-email";
import {
  eligibleRecipients,
  type SnapshotEntryDraft,
} from "@/lib/governance/resolution-core";
import { ballotTokenExpiry } from "@/lib/governance/token-payload";
import type { Requirement, VoteBasis } from "@/lib/llc/voting";
import { recordEvent } from "@/server/governance/events";
import { lockResolution } from "@/server/governance/tally";
import { withLlcAccessControl } from "@/trpc/api/trpc";
import { ZResolutionAddRecipientsSchema } from "../schema";

// resolution.addRecipients (03-governance.md G8): adds ballots to a SENT
// resolution for holders of its FROZEN register who are entitled to one and
// have none yet (C3.3: ballots are added, never removed). Identity columns are
// copied from the snapshot entry, as in send step 13. Invites are emitted
// after commit; the email job writes the `ballot.issued` audit row.

function badRequest(message: string): never {
  throw new TRPCError({ code: "BAD_REQUEST", message });
}

export const addRecipientsProcedure = withLlcAccessControl
  .meta({ policies: { governance: { allow: ["update"] } } })
  .input(ZResolutionAddRecipientsSchema)
  .mutation(async ({ ctx, input }) => {
    const companyId = ctx.membership.companyId;
    const now = new Date();
    const userName = ctx.session.user.name ?? "A user";
    const wanted = [...new Set(input.stakeholderIds)];

    const ballotIds = await ctx.db.$transaction(
      async (tx) => {
        const found = await tx.resolution.findFirst({
          where: { publicId: input.publicId, companyId },
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
          include: {
            requirements: { orderBy: { position: "asc" } },
            ballots: { select: { stakeholderId: true } },
          },
        });
        if (!resolution) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Resolution not found.",
          });
        }
        if (resolution.status !== "SENT") {
          badRequest("Recipients can be added only while the vote is open.");
        }
        const closesAt = resolution.closesAt;
        if (closesAt === null || closesAt.getTime() <= now.getTime()) {
          badRequest("The response period of this resolution has ended.");
        }
        const snapshotId = resolution.snapshotId;
        if (!snapshotId) badRequest("This resolution has no frozen register.");

        const entries = await tx.recordSnapshotEntry.findMany({
          where: { snapshotId, companyId },
        });
        const drafts: SnapshotEntryDraft[] = entries.map((e) => ({
          stakeholderId: e.stakeholderId,
          name: e.name,
          email: e.email,
          memberStatus: e.memberStatus,
          isMember: e.isMember,
          isInsider: e.isInsider,
          isSuspended: e.isSuspended,
          preferredUnits: e.preferredUnits.toFixed(6),
          commonUnits: e.commonUnits.toFixed(6),
        }));
        const requirements: Requirement[] = resolution.requirements.flatMap(
          (r): Requirement[] => {
            switch (r.kind) {
              case "UNIT_VOTE":
                return r.basis
                  ? [{ kind: "UNIT_VOTE", basis: r.basis as VoteBasis }]
                  : [];
              case "MANAGER_APPROVAL":
                return [{ kind: "MANAGER_APPROVAL" }];
              case "COMMON_MEMBER_APPROVAL":
                return [{ kind: "COMMON_MEMBER_APPROVAL" }];
              case "AFFECTED_MEMBER_CONSENT":
                return r.stakeholderId
                  ? [
                      {
                        kind: "AFFECTED_MEMBER_CONSENT",
                        stakeholderId: r.stakeholderId,
                      },
                    ]
                  : [];
              default:
                return [];
            }
          },
        );
        const eligible = new Map(
          eligibleRecipients(drafts, requirements).map((e) => [
            e.stakeholderId,
            e,
          ]),
        );
        const entryById = new Map(drafts.map((d) => [d.stakeholderId, d]));
        const hasBallot = new Set(
          resolution.ballots.map((b) => b.stakeholderId),
        );
        const tokenExpiresAt = ballotTokenExpiry(now, closesAt);

        const rows = wanted.map((id) => {
          const entry = entryById.get(id);
          const e = eligible.get(id);
          if (!entry) {
            badRequest(
              "A selected recipient is not on the register of this resolution.",
            );
          }
          if (!e) {
            badRequest(
              `${entry.name} is not entitled to a ballot on this resolution.`,
            );
          }
          if (hasBallot.has(id)) {
            badRequest(`${entry.name} already has a ballot.`);
          }
          const email = entry.email.trim();
          if (email === "") badRequest(`${entry.name} has no notice email.`);
          return {
            resolutionId: resolution.id,
            companyId,
            stakeholderId: entry.stakeholderId,
            name: entry.name,
            email,
            preferredUnits: entry.preferredUnits,
            countsPreferred: e.countsPreferred,
            countsDisinterested: e.countsDisinterested,
            tokenExpiresAt,
          };
        });

        await tx.resolutionBallot.createMany({ data: rows });
        const created = await tx.resolutionBallot.findMany({
          where: {
            resolutionId: resolution.id,
            companyId,
            stakeholderId: { in: wanted },
          },
          select: { id: true, name: true },
          orderBy: [{ name: "asc" }, { id: "asc" }],
        });
        const refLabel = resolution.referenceCode ?? resolution.title;
        for (const b of created) {
          await recordEvent(tx, {
            resolutionId: resolution.id,
            companyId,
            ballotId: b.id,
            type: "BALLOT_ISSUED",
            actorType: "user",
            actorId: ctx.session.user.id,
            summary: `${userName} added ${b.name} as a recipient of ${refLabel}`,
            ip: ctx.requestIp,
            userAgent: ctx.userAgent,
          });
        }
        return created.map((b) => b.id);
      },
      { maxWait: 10_000, timeout: 30_000 },
    );

    // After commit only.
    await emitBallotEmails(
      ballotIds.map((ballotId) => ({
        ballotId,
        kind: "INVITE" as const,
        seq: 0,
      })),
    );

    return { added: ballotIds.length, ballotIds };
  });
