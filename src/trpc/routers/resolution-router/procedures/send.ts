import { TRPCError } from "@trpc/server";
import { emitBallotEmails } from "@/jobs/governance-ballot-email";
import { emitResolutionFinalize } from "@/jobs/governance-resolution-finalize";
import {
  addDays,
  endOfDayInZone,
  GOVERNANCE_TIME_ZONE,
  responseDeadline,
  todayInZone,
  ymdToUtcDate,
} from "@/lib/governance/dates";
import {
  behaviour,
  buildLockedClauses,
  buildRequirements,
  type ResolutionType,
} from "@/lib/governance/presets";
import {
  eligibleRecipients,
  nextReferenceCode,
} from "@/lib/governance/resolution-core";
import {
  canonicalJson,
  isDocEmpty,
  normalizeBlocks,
} from "@/lib/governance/rich-doc";
import { ballotTokenExpiry } from "@/lib/governance/token-payload";
import { denominator, fromMicro, minimumFor } from "@/lib/llc/voting";
import { Audit } from "@/server/audit";
import type { PrismaTransactionalClient } from "@/server/db";
import { recordEvent } from "@/server/governance/events";
import { sha256Hex } from "@/server/governance/hash";
import { takeRecordSnapshot } from "@/server/governance/snapshot";
import {
  evaluateAndTransition,
  type GovernanceActor,
  lockResolution,
  type TransitionResult,
} from "@/server/governance/tally";
import { withLlcAccessControl } from "@/trpc/api/trpc";
import { ZResolutionSendSchema } from "../schema";
import { assertDraftReferences, parseDraftParams } from "./create";
import { requirementLabel } from "./get";

// resolution.send (03-governance.md G7, "resolution.send in full").
//
// Irreversible: freezes the text (frozenContent + frozenHash), the register
// (RecordSnapshot), the requirements (denominators and minimums) and the
// ballots, all in ONE transaction, under the resolution's row lock. Jobs
// (ballot invites, finalize) are emitted only after that transaction commits.
//
// Concurrency:
// - Two sends of the same draft: both take `lockResolution`; the second waits
//   until the first commits, then re-reads the row (READ COMMITTED: a new
//   statement sees the committed SENT status) and is rejected by the DRAFT
//   check. The status update itself is also guarded (`status: "DRAFT"`).
// - Two sends of different drafts of one company: the reference code is
//   computed under a company-scoped advisory transaction lock, and the
//   existing codes are read only after that lock is held, so the second
//   sender sees the first sender's committed code. `@@unique([companyId,
//   referenceCode])` stays as the backstop (mapped to CONFLICT below).
// - Nothing written here is updated afterwards except through the write-once
//   paths of C3 (requirement satisfaction/approvals, ballot votes, status).

const MAX_WINDOW_DAYS = 180;
const DEFAULT_WINDOW_DAYS = 30;

function badRequest(message: string): never {
  throw new TRPCError({ code: "BAD_REQUEST", message });
}

/**
 * Serialises reference-code allocation per company for the rest of the
 * transaction (Postgres transaction-scoped advisory lock, released on commit
 * or rollback). Selected as text so the `void` result column is never
 * deserialised.
 */
async function lockReferenceCodes(
  tx: PrismaTransactionalClient,
  companyId: string,
): Promise<void> {
  const key = `resolution-reference-code:${companyId}`;
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))::text AS locked`;
}

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === "P2002";
}

export const sendProcedure = withLlcAccessControl
  .meta({ policies: { governance: { allow: ["update"] } } })
  .input(ZResolutionSendSchema)
  .mutation(async ({ ctx, input }) => {
    const companyId = ctx.membership.companyId;
    const now = new Date();
    const zone = ctx.company.timezone || GOVERNANCE_TIME_ZONE;
    const userName = ctx.session.user.name ?? "A user";
    const actor: GovernanceActor = {
      type: "user",
      id: ctx.session.user.id,
      ip: ctx.requestIp,
      userAgent: ctx.userAgent,
    };
    const auditActor = { type: "user" as const, id: ctx.session.user.id };
    const auditContext = {
      requestIp: ctx.requestIp,
      userAgent: ctx.userAgent,
    };

    let result: {
      publicId: string;
      referenceCode: string;
      ballotIds: string[];
      transition: TransitionResult | null;
    };
    try {
      result = await ctx.db.$transaction(
        async (tx) => {
          // 1. Load, lock, re-read under the lock, require DRAFT.
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
          });
          if (!resolution) {
            throw new TRPCError({
              code: "NOT_FOUND",
              message: "Resolution not found.",
            });
          }
          if (resolution.status !== "DRAFT") {
            badRequest(
              "Only a draft can be sent. This resolution has already been sent.",
            );
          }
          const resolutionId = resolution.id;
          const type = resolution.type as ResolutionType;

          // 2. Content checks.
          const params = parseDraftParams(type, resolution.params);
          const normalized = normalizeBlocks(resolution.body);
          if (!normalized.ok) badRequest(normalized.errors.join("; "));
          const doc = normalized.doc;
          if (isDocEmpty(doc)) badRequest("The resolution text is empty.");
          const title = resolution.title.trim();
          if (title === "") badRequest("The resolution needs a title.");
          await assertDraftReferences(tx, companyId, type, params);

          // 3. Requirements are always rebuilt from type + params.
          const specs = buildRequirements(type, params);
          const b = behaviour(type);

          // 4. Record date.
          const today = todayInZone(now, zone);
          if (input.recordDate > today) {
            badRequest("The record date cannot be in the future.");
          }

          // 5. R19: one review or audit per fiscal year (Section 8.3).
          if (type === "AUDIT_CALL") {
            const effective = await tx.resolution.findMany({
              where: {
                companyId,
                type: "AUDIT_CALL",
                status: "EFFECTIVE",
                effectiveAt: { not: null },
                id: { not: resolutionId },
              },
              select: { effectiveAt: true },
            });
            const year = today.slice(0, 4);
            if (
              effective.some(
                (r) =>
                  r.effectiveAt !== null &&
                  todayInZone(r.effectiveAt, zone).slice(0, 4) === year,
              )
            ) {
              badRequest(
                "A review or audit has already been required in this fiscal year (Section 8.3).",
              );
            }
          }

          // 6. Freeze the register (insert only, C3.1). Every type gets one,
          //    PURCHASE_ORDER included: evaluation needs it.
          const { snapshot, entries } = await takeRecordSnapshot(tx, {
            companyId,
            recordDate: input.recordDate,
            purpose: "RESOLUTION",
            takenById: ctx.membership.memberId,
          });
          const entryById = new Map(entries.map((e) => [e.stakeholderId, e]));

          // 7. Requirements, frozen against the register.
          await tx.resolutionRequirement.deleteMany({
            where: { resolutionId },
          });
          const requirementRows: { id: string; kind: string }[] = [];
          for (const [position, s] of specs.entries()) {
            const r = s.requirement;
            let denominatorUnits: string | null = null;
            let minimumForUnits: string | null = null;
            if (r.kind === "UNIT_VOTE") {
              const den = denominator(entries, r.basis);
              const min = minimumFor(den, r.basis);
              if (den === 0n || min === null) {
                badRequest(
                  `No outstanding units are entitled to vote on: ${requirementLabel({ kind: r.kind, basis: r.basis })} (Section ${s.section}).`,
                );
              }
              denominatorUnits = fromMicro(den);
              minimumForUnits = fromMicro(min);
            }
            if (r.kind === "AFFECTED_MEMBER_CONSENT") {
              const entry = entryById.get(r.stakeholderId);
              if (!entry?.isMember) {
                badRequest(
                  `${entry?.name ?? "An affected Member"} is not an admitted Member on the record date, so its consent cannot be requested (Section 12.1(b)).`,
                );
              }
            }
            const row = await tx.resolutionRequirement.create({
              data: {
                resolutionId,
                companyId,
                position,
                kind: r.kind,
                basis: r.kind === "UNIT_VOTE" ? r.basis : null,
                stakeholderId:
                  r.kind === "AFFECTED_MEMBER_CONSENT" ? r.stakeholderId : null,
                section: s.section,
                denominatorUnits,
                minimumForUnits,
              },
              select: { id: true, kind: true },
            });
            requirementRows.push(row);
          }

          // 8. Ballot recipients (matched only against this register).
          type Recipient = {
            stakeholderId: string;
            name: string;
            email: string;
            preferredUnits: string;
            countsPreferred: boolean;
            countsDisinterested: boolean;
          };
          const recipients: Recipient[] = [];
          if (b.hasBallots) {
            const eligible = eligibleRecipients(
              entries,
              specs.map((s) => s.requirement),
            );
            const eligibleIds = new Set(eligible.map((e) => e.stakeholderId));
            const consentIds = new Set(
              specs.flatMap((s) =>
                s.requirement.kind === "AFFECTED_MEMBER_CONSENT"
                  ? [s.requirement.stakeholderId]
                  : [],
              ),
            );
            let chosen = eligible;
            if (
              !b.allRecipientsRequired &&
              input.recipientStakeholderIds !== undefined
            ) {
              const wanted = new Set(input.recipientStakeholderIds);
              for (const id of wanted) {
                if (!eligibleIds.has(id)) {
                  const name = entryById.get(id)?.name;
                  badRequest(
                    name
                      ? `${name} is not entitled to a ballot on this resolution.`
                      : "A selected recipient is not on the register of this resolution.",
                  );
                }
              }
              chosen = eligible.filter(
                (e) =>
                  wanted.has(e.stakeholderId) ||
                  consentIds.has(e.stakeholderId),
              );
            }
            if (chosen.length === 0) {
              badRequest("At least one Member must receive a ballot.");
            }
            for (const e of chosen) {
              const entry = entryById.get(e.stakeholderId);
              if (!entry) {
                throw new Error(
                  `Eligible recipient ${e.stakeholderId} is not a snapshot entry`,
                );
              }
              if (entry.email.trim() === "") {
                badRequest(`${entry.name} has no notice email.`);
              }
              recipients.push({
                stakeholderId: entry.stakeholderId,
                name: entry.name,
                email: entry.email.trim(),
                preferredUnits: entry.preferredUnits,
                countsPreferred: e.countsPreferred,
                countsDisinterested: e.countsDisinterested,
              });
            }
          }

          // 9. Response window.
          let closesAt: Date | null = null;
          if (b.hasBallots) {
            if (b.fixedWindowDays !== null) {
              closesAt = responseDeadline(now, b.fixedWindowDays, zone);
            } else {
              const closesOn =
                input.closesOn ?? addDays(today, DEFAULT_WINDOW_DAYS);
              const earliest = addDays(today, 1);
              const latest = addDays(today, MAX_WINDOW_DAYS);
              if (closesOn < earliest || closesOn > latest) {
                badRequest(
                  `The response deadline must be between ${earliest} and ${latest}.`,
                );
              }
              closesAt = endOfDayInZone(closesOn, zone);
            }
          }

          // 10. Reference code, unique per company and year (see header).
          await lockReferenceCodes(tx, companyId);
          const year = Number(today.slice(0, 4));
          const used = await tx.resolution.findMany({
            where: {
              companyId,
              referenceCode: { startsWith: `R-${year}-` },
            },
            select: { referenceCode: true },
          });
          const referenceCode = nextReferenceCode(
            used.flatMap((r) => (r.referenceCode ? [r.referenceCode] : [])),
            year,
          );

          // 11. Frozen content and its hash. The stored JSON is exactly the
          //     canonical form that was hashed.
          const frozen = {
            title,
            type,
            doc,
            lockedClauses: buildLockedClauses(type, params, {
              companyName: ctx.company.name,
            }),
            requirements: specs.map((s) => {
              const r = s.requirement;
              let label = requirementLabel({
                kind: r.kind,
                basis: r.kind === "UNIT_VOTE" ? r.basis : null,
              });
              if (r.kind === "AFFECTED_MEMBER_CONSENT") {
                const name = entryById.get(r.stakeholderId)?.name;
                if (name) label = `${label}: ${name}`;
              }
              return { label, section: s.section };
            }),
            recordDate: input.recordDate,
          };
          const canonical = canonicalJson(frozen);
          const frozenHash = sha256Hex(canonical);
          const frozenContent = JSON.parse(canonical) as object;

          // 12. DRAFT -> SENT (guarded; set once, C3.4).
          const { count } = await tx.resolution.updateMany({
            where: { id: resolutionId, companyId, status: "DRAFT" },
            data: {
              status: "SENT",
              sentAt: now,
              recordDate: ymdToUtcDate(input.recordDate),
              snapshotId: snapshot.id,
              closesAt,
              referenceCode,
              frozenContent,
              frozenHash,
              autoReminders: input.autoReminders,
            },
          });
          if (count !== 1) {
            throw new TRPCError({
              code: "CONFLICT",
              message: "This resolution has already been sent.",
            });
          }

          // 13. Ballots (identity columns frozen from the register).
          let ballotIds: string[] = [];
          if (recipients.length > 0) {
            const tokenExpiresAt = ballotTokenExpiry(now, closesAt);
            await tx.resolutionBallot.createMany({
              data: recipients.map((r) => ({
                resolutionId,
                companyId,
                stakeholderId: r.stakeholderId,
                name: r.name,
                email: r.email,
                preferredUnits: r.preferredUnits,
                countsPreferred: r.countsPreferred,
                countsDisinterested: r.countsDisinterested,
                tokenExpiresAt,
              })),
            });
            const created = await tx.resolutionBallot.findMany({
              where: { resolutionId },
              select: { id: true },
              orderBy: [{ name: "asc" }, { id: "asc" }],
            });
            ballotIds = created.map((c) => c.id);
          }

          // 14. Signatures given at send (write-once approval columns).
          const sign = async (
            kind: "MANAGER_APPROVAL" | "COMMON_MEMBER_APPROVAL",
            signature: { signerName: string; signerCapacity: string },
          ) => {
            const role =
              kind === "MANAGER_APPROVAL" ? "the Manager" : "the Common Member";
            for (const row of requirementRows) {
              if (row.kind !== kind) continue;
              const { count: signed } =
                await tx.resolutionRequirement.updateMany({
                  where: { id: row.id, resolutionId, approvedAt: null },
                  data: {
                    approvedByMemberId: ctx.membership.memberId,
                    approverName: signature.signerName,
                    approverCapacity: signature.signerCapacity,
                    approvedAt: now,
                    approvalIp: ctx.requestIp,
                    approvalUserAgent: ctx.userAgent,
                  },
                });
              if (signed !== 1) {
                throw new Error(`Requirement ${row.id} was already approved`);
              }
            }
            await recordEvent(tx, {
              resolutionId,
              companyId,
              type:
                kind === "MANAGER_APPROVAL"
                  ? "MANAGER_SIGNED"
                  : "COMMON_MEMBER_SIGNED",
              actorType: "user",
              actorId: ctx.session.user.id,
              summary: `${signature.signerName} (${signature.signerCapacity}) signed ${referenceCode} for ${role}`,
              ip: ctx.requestIp,
              userAgent: ctx.userAgent,
            });
            await Audit.create(
              {
                action: "resolution.approved",
                companyId,
                actor: auditActor,
                context: auditContext,
                target: [{ type: "resolution", id: resolutionId }],
                summary: `${userName} signed ${referenceCode} "${title}" for ${role} as ${signature.signerName}, ${signature.signerCapacity}`,
              },
              tx,
            );
          };
          const has = (kind: string) =>
            requirementRows.some((r) => r.kind === kind);
          if (has("MANAGER_APPROVAL")) {
            if (!input.managerSignature) {
              badRequest(
                "The Manager's signature is required to send this resolution.",
              );
            }
            await sign("MANAGER_APPROVAL", input.managerSignature);
          }
          if (has("COMMON_MEMBER_APPROVAL") && input.commonMemberSignature) {
            await sign("COMMON_MEMBER_APPROVAL", input.commonMemberSignature);
          }

          // 15. SENT event and audit; Section 2.5 request made.
          const n = recipients.length;
          const sentSummary = b.hasBallots
            ? `${userName} sent ${referenceCode} "${title}" to ${n} ${n === 1 ? "Member" : "Members"} (record date ${input.recordDate})`
            : `${userName} signed and issued ${referenceCode} "${title}" (Manager resolution, no ballots; record date ${input.recordDate})`;
          await recordEvent(tx, {
            resolutionId,
            companyId,
            type: "SENT",
            actorType: "user",
            actorId: ctx.session.user.id,
            summary: sentSummary,
            ip: ctx.requestIp,
            userAgent: ctx.userAgent,
          });
          await Audit.create(
            {
              action: "resolution.sent",
              companyId,
              actor: auditActor,
              context: auditContext,
              target: [{ type: "resolution", id: resolutionId }],
              summary: sentSummary,
            },
            tx,
          );
          if (type === "TERM_EXTENSION") {
            await tx.complianceDeadline.updateMany({
              where: {
                companyId,
                ruleKey: "EXTENSION_REQUEST_DUE",
                status: "OPEN",
              },
              data: {
                status: "DONE",
                satisfiedByType: "RESOLUTION",
                satisfiedById: resolutionId,
                completedAt: now,
                completedById: ctx.membership.memberId,
              },
            });
          }

          // 16. Evaluate: a PURCHASE_ORDER (Manager approval only) becomes
          //     EFFECTIVE here.
          const transition = await evaluateAndTransition(
            tx,
            resolutionId,
            now,
            actor,
          );

          return {
            publicId: resolution.publicId,
            referenceCode,
            ballotIds,
            transition,
          };
        },
        { maxWait: 10_000, timeout: 30_000 },
      );
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new TRPCError({
          code: "CONFLICT",
          message:
            "Another resolution was sent at the same moment. Please try again.",
        });
      }
      throw error;
    }

    // After commit only.
    if (result.transition) {
      await emitResolutionFinalize(result.transition.resolutionId);
    } else {
      await emitBallotEmails(
        result.ballotIds.map((ballotId) => ({
          ballotId,
          kind: "INVITE" as const,
          seq: 0,
        })),
      );
    }

    return {
      publicId: result.publicId,
      referenceCode: result.referenceCode,
      status: result.transition?.to ?? ("SENT" as const),
    };
  });
