import { TRPCError } from "@trpc/server";
import { emitResolutionFinalize } from "@/jobs/governance-resolution-finalize";
import { Audit } from "@/server/audit";
import { recordEvent } from "@/server/governance/events";
import {
  evaluateAndTransition,
  lockResolution,
  type TransitionResult,
} from "@/server/governance/tally";
import { withoutAuth } from "@/trpc/api/trpc";
import { boundRequestMeta } from "../access";
import { ZBallotSubmitSchema } from "../schema";
import { resolveBallot } from "./resolve";

// ballot.submit (03-governance.md G8, "ballot.submit in full"). Public: the
// token is the credential. A submitted ballot is FINAL (R13a): exactly once.
//
// Worked example (integration script; G19 runs it, verify by hand against a
// dev database). REG register (G1), GENERAL_CONSENT, Preferred
// Supermajority, denominator 1050.000000, minimum 735.000000:
//   1. alice submits FOR (400.000000)  -> { state: "VOTED", status: "SENT" }
//   2. bob submits FOR (cumulative 700.000000, below 735) -> status SENT
//   3. dan submits FOR (cumulative 750.500000 >= 735) -> status EFFECTIVE at
//      dan's submission instant; one finalize job is emitted
//   4. carol submits afterwards -> CONFLICT "This resolution is closed."
//   5. finalize (G9) sends one result email with the executed PDF to every
//      snapshot entry with isMember: carol, schoen, reidTrust, sam and
//      octagon as well as the three For voters; fay (Financial Interest
//      only) receives nothing.
//   Also: alice submitting a second time -> CONFLICT "Your response has
//   already been recorded." and her first vote is unchanged.
//
// Exactly-once, and why a concurrent or repeated submit changes nothing:
// - The resolution row is locked (SELECT … FOR UPDATE) before the ballot is
//   read for the decision; every check below uses rows re-read after the lock
//   (a second `resolveBallot` inside the transaction).
// - The vote is written with one guarded `updateMany` (C3.2): only while
//   `submittedAt IS NULL AND deemed = false`, only for the token's current
//   `tokenVersion`, an unrevoked and unexpired link, and the affected-row
//   count must be 1. A link revoked or replaced by a transaction that does
//   not take the resolution lock is still caught by the row-level re-check.
// - `evaluateAndTransition` runs under the same lock, so two ballots that
//   together cross the threshold produce one EFFECTIVE transition.
// - The client must send the `frozenHash` it was shown; a mismatch is
//   rejected before anything is written.
//
// The transaction COMMITS in every business branch, because step 2 may have
// closed an overdue resolution (deemed-against ballots, status change): the
// outcome is returned from the transaction and thrown only afterwards.

type SubmitResult =
  | "RECORDED"
  | "REPLACED"
  | "CLOSED"
  | "ALREADY"
  | "HASH_MISMATCH";

export const submitProcedure = withoutAuth
  .input(ZBallotSubmitSchema)
  .mutation(async ({ ctx, input }) => {
    const now = new Date();
    const meta = boundRequestMeta(ctx.requestIp, ctx.userAgent);
    const signerCapacity =
      input.signerCapacity && input.signerCapacity.length > 0
        ? input.signerCapacity
        : null;

    const outcome = await ctx.db.$transaction(
      async (
        tx,
      ): Promise<{
        result: SubmitResult;
        transition: TransitionResult | null;
        status: string;
      }> => {
        // 1. Validate the link (pre-lock read only to learn which resolution
        //    to lock), lock, then validate again on fresh rows. A NOT_FOUND
        //    thrown here happens before any write.
        const first = await resolveBallot(tx, input.token, now);
        if (first.kind === "REPLACED") {
          return { result: "REPLACED", transition: null, status: "" };
        }
        const resolutionId = first.resolution.id;
        await lockResolution(tx, resolutionId);
        let resolved = await resolveBallot(tx, input.token, now);
        if (resolved.kind === "REPLACED") {
          return { result: "REPLACED", transition: null, status: "" };
        }
        if (resolved.resolution.id !== resolutionId) {
          throw new TRPCError({ code: "NOT_FOUND" });
        }

        // 2. Close an overdue resolution before anything is accepted, so a
        //    late ballot can never count (system actor: not the voter's act).
        let transition: TransitionResult | null = null;
        const closesAt = resolved.resolution.closesAt;
        if (
          resolved.resolution.status === "SENT" &&
          closesAt !== null &&
          closesAt.getTime() < now.getTime()
        ) {
          transition = await evaluateAndTransition(tx, resolutionId, now, {
            type: "system",
            id: null,
            ip: "system",
            userAgent: "lazy-close:ballot.submit",
          });
          resolved = await resolveBallot(tx, input.token, now);
          if (resolved.kind === "REPLACED") {
            return { result: "REPLACED", transition, status: "" };
          }
        }
        const { ballot, resolution, tokenVersion } = resolved;

        // 3. Only a SENT resolution inside its response period accepts votes
        //    (WITHDRAWN, EFFECTIVE, FAILED, EXPIRED -> CLOSED).
        if (
          resolution.status !== "SENT" ||
          (resolution.closesAt !== null &&
            now.getTime() > resolution.closesAt.getTime())
        ) {
          return { result: "CLOSED", transition, status: resolution.status };
        }

        // 4. Final: never a second response.
        if (ballot.submittedAt !== null || ballot.deemed) {
          return { result: "ALREADY", transition, status: resolution.status };
        }

        // 5. The holder signs exactly the frozen text it was shown.
        if (
          resolution.frozenHash === null ||
          input.bodyHash !== resolution.frozenHash
        ) {
          return {
            result: "HASH_MISMATCH",
            transition,
            status: resolution.status,
          };
        }

        // 6. Write-once (C3.2).
        const { count } = await tx.resolutionBallot.updateMany({
          where: {
            id: ballot.id,
            resolutionId,
            companyId: resolution.companyId,
            submittedAt: null,
            deemed: false,
            tokenVersion,
            tokenRevokedAt: null,
            tokenExpiresAt: { gt: now },
          },
          data: {
            choice: input.choice,
            deemed: false,
            signedName: input.signedName,
            signerCapacity,
            submittedAt: now,
            submitIp: meta.ip,
            submitUserAgent: meta.userAgent,
            bodyHash: resolution.frozenHash,
          },
        });
        if (count !== 1) {
          // Nothing was written. Submitted meanwhile -> ALREADY; otherwise
          // the link was revoked or replaced concurrently -> REPLACED.
          const current = await tx.resolutionBallot.findUnique({
            where: { id: ballot.id },
            select: { submittedAt: true },
          });
          return {
            result: current?.submittedAt ? "ALREADY" : "REPLACED",
            transition,
            status: resolution.status,
          };
        }

        // 7. Evidence.
        const units = ballot.preferredUnits.toFixed(6);
        const ref = resolution.referenceCode ?? resolution.title;
        await recordEvent(tx, {
          resolutionId,
          companyId: resolution.companyId,
          ballotId: ballot.id,
          type: "BALLOT_SUBMITTED",
          actorType: "stakeholder",
          actorId: ballot.stakeholderId,
          summary: `${ballot.name} responded ${input.choice} with ${units} Preferred Units`,
          ip: meta.ip,
          userAgent: meta.userAgent,
        });
        await Audit.create(
          {
            action: "ballot.submitted",
            companyId: resolution.companyId,
            actor: { type: "stakeholder", id: ballot.stakeholderId },
            context: { requestIp: meta.ip, userAgent: meta.userAgent },
            target: [
              { type: "ballot", id: ballot.id },
              { type: "resolution", id: resolutionId },
            ],
            summary: `${ballot.name} responded ${input.choice} on ${ref} with ${units} Preferred Units, signed as ${input.signedName}`,
          },
          tx,
        );

        // 8. Evaluate under the same lock.
        transition = await evaluateAndTransition(tx, resolutionId, now, {
          type: "stakeholder",
          id: ballot.stakeholderId,
          ip: meta.ip,
          userAgent: meta.userAgent,
        });
        return {
          result: "RECORDED",
          transition,
          status: transition?.to ?? "SENT",
        };
      },
    );

    // After commit only.
    if (outcome.transition) {
      await emitResolutionFinalize(outcome.transition.resolutionId);
    }

    switch (outcome.result) {
      case "RECORDED":
        return {
          state:
            outcome.status === "SENT"
              ? ("VOTED" as const)
              : ("CLOSED" as const),
          status: outcome.status as "SENT" | "EFFECTIVE" | "FAILED" | "EXPIRED",
        };
      case "REPLACED":
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "This link has been replaced.",
        });
      case "CLOSED":
        throw new TRPCError({
          code: "CONFLICT",
          message: "This resolution is closed.",
        });
      case "ALREADY":
        throw new TRPCError({
          code: "CONFLICT",
          message: "Your response has already been recorded.",
        });
      case "HASH_MISMATCH":
        throw new TRPCError({
          code: "CONFLICT",
          message: "The document changed. Reload the page.",
        });
    }
  });
