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
  placeholderBlocker,
  type ResolutionType,
  unfilledPlaceholders,
} from "@/lib/governance/presets";
import {
  eligibleRecipients,
  nextReferenceCode,
} from "@/lib/governance/resolution-core";
import {
  canonicalJson,
  docToPlainText,
  isDocEmpty,
  normalizeBlocks,
} from "@/lib/governance/rich-doc";
import { ballotTokenExpiry } from "@/lib/governance/token-payload";
import { denominator, fromMicro, minimumFor } from "@/lib/llc/voting";
import { Audit } from "@/server/audit";
import type { PrismaTransactionalClient } from "@/server/db";
import { emitAfterCommit } from "@/server/governance/emit";
import { recordEvent } from "@/server/governance/events";
import { guardedWrite } from "@/server/governance/guarded";
import { sha256Hex } from "@/server/governance/hash";
import { takeRecordSnapshot } from "@/server/governance/snapshot";
import {
  evaluateAndTransition,
  type GovernanceActor,
  lockResolution,
  type TransitionResult,
} from "@/server/governance/tally";
import { termExtensionSendBlockers } from "@/server/governance/term-extension";
import { lockCompanyLedgerAndUnitClasses } from "@/server/llc/economics/scope";
import { assertMailDeliverable } from "@/server/mail-delivery";
import { withLlcAccessControl } from "@/trpc/api/trpc";
import { boundRequestMeta } from "../../ballot-router/access";
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
// - Lock order: the company ledger lock and the unit-class locks first
//   (`lockCompanyLedgerAndUnitClasses`, as every economics write), then the
//   resolution row lock, then the reference-code lock. No path takes a
//   resolution lock and then a ledger or unit-class lock. Admissions
//   (FOUNDATION) hold the unit-class lock, so the register cannot change
//   between the snapshot's status and unit reads.
// - Two sends of the same draft: both take `lockResolution`; the second waits
//   until the first commits, then re-reads the row (READ COMMITTED: a new
//   statement sees the committed SENT status) and is rejected by the DRAFT
//   check. The status update itself is also guarded (`status: "DRAFT"`).
// - Two sends of different drafts of one company: the reference code is
//   computed under a company-scoped advisory transaction lock, and the
//   existing codes are read only after that lock is held, so the second
//   sender sees the first sender's committed code. `@@unique([companyId,
//   referenceCode])` stays as the backstop (mapped to CONFLICT below).
// - `resolution.update` / `resolution.delete` take the same row lock and
//   require DRAFT after it, so a draft edit can never land on a sent
//   resolution. Every guarded write here is a single-row `guardedWrite`
//   (never a guarded `updateMany`, see server/governance/guarded.ts).
// - Nothing written here is updated afterwards except through the write-once
//   paths of C3 (requirement satisfaction/approvals, ballot votes, status).
// - Everything shown or sent after send (ballot page, emails, PDF, PO copy)
//   is read from `frozenContent` (title, params, text), never from the live
//   columns.

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

/** M5: the message `send` refuses with and `preview` shows as a blocker. */
export function undeclaredOverdueMessage(name: string): string {
  return `${name} has an overdue Balance with no declared default. Declare the default (Section 4.9) or record the payment before sending.`;
}

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === "P2002";
}

export const sendProcedure = withLlcAccessControl
  .meta({ policies: { governance: { allow: ["update"] } } })
  .input(ZResolutionSendSchema)
  .mutation(async ({ ctx, input }) => {
    // Production with the bundled mail catcher: refused before anything
    // is written (Members would not receive the email).
    assertMailDeliverable("RESOLUTION");
    const companyId = ctx.membership.companyId;
    const now = new Date();
    const zone = ctx.company.timezone || GOVERNANCE_TIME_ZONE;
    const userName = ctx.session.user.name ?? "A user";
    // Client-controlled headers: bounded before they are stored (M3).
    const meta = boundRequestMeta(ctx.requestIp, ctx.userAgent);
    const actor: GovernanceActor = {
      type: "user",
      id: ctx.session.user.id,
      ip: meta.ip,
      userAgent: meta.userAgent,
    };
    const auditActor = { type: "user" as const, id: ctx.session.user.id };
    const auditContext = {
      requestIp: meta.ip,
      userAgent: meta.userAgent,
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
          // 0. The company ledger lock, then the unit-class locks, BEFORE the
          //    resolution's row lock (the economics order: company first).
          //    The register snapshot (step 6) reads member status and units
          //    in two statements; admissions take the unit-class lock, so
          //    none can commit between those reads.
          await lockCompanyLedgerAndUnitClasses(tx, companyId);
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
          const placeholders = unfilledPlaceholders(docToPlainText(doc));
          if (placeholders.length > 0) {
            badRequest(placeholderBlocker(placeholders));
          }
          const title = resolution.title.trim();
          if (title === "") badRequest("The resolution needs a title.");
          await assertDraftReferences(tx, companyId, type, params);

          // 2a. A term extension must ask about exactly the dates the term
          //     clock will move between when it becomes EFFECTIVE (the clock
          //     counts EFFECTIVE extensions), with no other one open. Checked
          //     under the company ledger lock taken in step 0, which the term
          //     clock setters also take (they refuse while one is SENT).
          if (type === "TERM_EXTENSION") {
            const blockers = await termExtensionSendBlockers(tx, companyId, {
              id: resolutionId,
              params,
              title,
            });
            if (blockers.length > 0) badRequest(blockers.join(" "));
          }

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
          const { snapshot, entries, warnings } = await takeRecordSnapshot(tx, {
            companyId,
            recordDate: input.recordDate,
            purpose: "RESOLUTION",
            takenById: ctx.membership.memberId,
          });
          const entryById = new Map(entries.map((e) => [e.stakeholderId, e]));

          // 6a. R13 / Section 4.9 (M5): an overdue Balance with no declared
          //     default as of the record date must not vote. Refused until
          //     the default is declared (units suspended) or the payment is
          //     recorded. A resolution without ballots (PURCHASE_ORDER) has
          //     no unit vote and is not affected.
          if (b.hasBallots && warnings.length > 0) {
            badRequest(
              undeclaredOverdueMessage(
                entryById.get(warnings[0]?.stakeholderId ?? "")?.name ??
                  "A holder",
              ),
            );
          }

          // 7. Requirements, frozen against the register.
          // Not a guarded write: every requirement row of this DRAFT is
          // replaced, under the row lock, after DRAFT was re-checked; the
          // rows have no children.
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
            // Frozen so the PO copy, emails and the ballot page never read
            // the live `params` column after send.
            params,
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
          const moved = await guardedWrite(() =>
            tx.resolution.update({
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
              select: { id: true },
            }),
          );
          if (!moved) {
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
              const signed = await guardedWrite(() =>
                tx.resolutionRequirement.update({
                  where: { id: row.id, resolutionId, approvedAt: null },
                  data: {
                    approvedByMemberId: ctx.membership.memberId,
                    approverName: signature.signerName,
                    approverCapacity: signature.signerCapacity,
                    approvedAt: now,
                    approvalIp: meta.ip,
                    approvalUserAgent: meta.userAgent,
                  },
                  select: { id: true },
                }),
              );
              if (!signed) {
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
              ip: meta.ip,
              userAgent: meta.userAgent,
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
            ip: meta.ip,
            userAgent: meta.userAgent,
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
            // One guarded write per open deadline (a guarded updateMany would
            // overwrite a deadline closed concurrently by someone else).
            const open = await tx.complianceDeadline.findMany({
              where: {
                companyId,
                ruleKey: "EXTENSION_REQUEST_DUE",
                status: "OPEN",
              },
              select: { id: true },
            });
            for (const deadline of open) {
              await guardedWrite(() =>
                tx.complianceDeadline.update({
                  where: { id: deadline.id, companyId, status: "OPEN" },
                  data: {
                    status: "DONE",
                    satisfiedByType: "RESOLUTION",
                    satisfiedById: resolutionId,
                    completedAt: now,
                    completedById: ctx.membership.memberId,
                  },
                  select: { id: true },
                }),
              );
            }
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

    // After commit only. A failed emit is logged, never an error for the
    // caller: the resolution IS sent (H2, see server/governance/emit.ts).
    const transition = result.transition;
    if (transition) {
      await emitAfterCommit(
        "resolution finalize",
        { resolutionId: transition.resolutionId },
        () => emitResolutionFinalize(transition.resolutionId),
      );
    } else {
      await emitAfterCommit(
        "ballot invites",
        { publicId: result.publicId },
        () =>
          emitBallotEmails(
            result.ballotIds.map((ballotId) => ({
              ballotId,
              kind: "INVITE" as const,
              seq: 0,
            })),
          ),
      );
    }

    return {
      publicId: result.publicId,
      referenceCode: result.referenceCode,
      status: result.transition?.to ?? ("SENT" as const),
    };
  });
