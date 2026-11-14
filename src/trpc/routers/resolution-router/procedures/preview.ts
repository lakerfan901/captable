import { GOVERNANCE_TIME_ZONE, todayInZone } from "@/lib/governance/dates";
import {
  behaviour,
  buildRequirements,
  buildTitle,
  placeholderBlocker,
  type ResolutionType,
  unfilledPlaceholders,
} from "@/lib/governance/presets";
import { eligibleRecipients } from "@/lib/governance/resolution-core";
import { docToPlainText, normalizeBlocks } from "@/lib/governance/rich-doc";
import { denominator, fromMicro, minimumFor, toMicro } from "@/lib/llc/voting";
import { buildSnapshotDraft } from "@/server/governance/snapshot";
import { termExtensionSendBlockers } from "@/server/governance/term-extension";
import { currentMailDelivery } from "@/server/mail-delivery";
import { withLlcAccessControl } from "@/trpc/api/trpc";
import { ZResolutionPreviewSchema } from "../schema";
import { parseDraftParams } from "./create";
import { requirementLabel } from "./get";
import { undeclaredOverdueMessage } from "./send";

// resolution.preview (03-governance.md G7): what `send` would do with this
// type, params and record date. Builds the register but stores nothing.
//
// `blockers` are conditions `send` refuses (the send dialog disables Send and
// shows them); `warnings` are shown for review. Dates are measured in the
// company's time zone, exactly as `send` measures them; it is returned as
// `timeZone` for the dialog.

export type ExclusionReason =
  | "SUSPENDED"
  | "FINANCIAL_INTEREST_ONLY"
  | "INSIDER"
  | "NO_PREFERRED_UNITS";

export const previewProcedure = withLlcAccessControl
  .meta({ policies: { governance: { allow: ["read"] } } })
  .input(ZResolutionPreviewSchema)
  .query(async ({ ctx, input }) => {
    const companyId = ctx.membership.companyId;
    const now = new Date();
    const zone = ctx.company.timezone || GOVERNANCE_TIME_ZONE;
    const type = input.type as ResolutionType;
    const params = parseDraftParams(type, input.params);
    const specs = buildRequirements(type, params);
    const b = behaviour(type);
    const draft = await buildSnapshotDraft(ctx.db, companyId, input.recordDate);
    const entries = draft.entries;
    const byId = new Map(entries.map((e) => [e.stakeholderId, e]));
    const warnings: string[] = [];
    const blockers: string[] = [];

    const requirements = specs.map(({ requirement: r, section }) => {
      const label = requirementLabel({
        kind: r.kind,
        basis: r.kind === "UNIT_VOTE" ? r.basis : null,
      });
      if (r.kind !== "UNIT_VOTE") {
        if (r.kind === "AFFECTED_MEMBER_CONSENT") {
          const entry = byId.get(r.stakeholderId);
          if (!entry?.isMember) {
            warnings.push(
              `An affected Member (${entry?.name ?? r.stakeholderId}) is not an admitted Member on the record date; the resolution cannot be sent (Section 12.1(b)).`,
            );
          }
        }
        return { label, section, denominator: null, minimumFor: null };
      }
      const den = denominator(entries, r.basis);
      const min = minimumFor(den, r.basis);
      if (den === 0n) {
        warnings.push(
          `No outstanding units are entitled to vote on: ${label}.`,
        );
      }
      return {
        label,
        section,
        denominator: fromMicro(den),
        minimumFor: min === null ? null : fromMicro(min),
      };
    });

    const eligible = b.hasBallots
      ? eligibleRecipients(
          entries,
          specs.map((s) => s.requirement),
        )
      : [];
    const eligibleIds = new Set(eligible.map((e) => e.stakeholderId));

    const recipients = eligible.map((r) => {
      const entry = byId.get(r.stakeholderId);
      return {
        stakeholderId: r.stakeholderId,
        name: entry?.name ?? "",
        email: entry?.email ?? "",
        preferredUnits: entry?.preferredUnits ?? "0.000000",
        countsPreferred: r.countsPreferred,
        countsDisinterested: r.countsDisinterested,
        consentOnly: r.consentOnly,
      };
    });
    for (const r of recipients) {
      if (r.email.trim() === "") {
        warnings.push(`${r.name} has no notice email.`);
      }
    }

    // Precedence: not an admitted Member, then no Preferred Units, then
    // suspended, then insider (only disinterested bases apply).
    const excluded = b.hasBallots
      ? entries
          .filter((e) => !eligibleIds.has(e.stakeholderId))
          .map((e) => {
            const reason: ExclusionReason = !e.isMember
              ? "FINANCIAL_INTEREST_ONLY"
              : toMicro(e.preferredUnits) === 0n
                ? "NO_PREFERRED_UNITS"
                : e.isSuspended
                  ? "SUSPENDED"
                  : "INSIDER";
            return {
              stakeholderId: e.stakeholderId,
              name: e.name,
              preferredUnits: e.preferredUnits,
              reason,
            };
          })
      : [];

    // M5: an overdue Balance without a declared default (as of the record
    // date) blocks a resolution with ballots, exactly as `send` refuses it.
    if (b.hasBallots) {
      const named = new Set<string>();
      for (const w of draft.warnings) {
        const name = byId.get(w.stakeholderId)?.name ?? "A holder";
        if (named.has(name)) continue;
        named.add(name);
        blockers.push(undeclaredOverdueMessage(name));
      }
    }

    const today = todayInZone(now, zone);
    if (type === "AUDIT_CALL") {
      const effective = await ctx.db.resolution.findMany({
        where: {
          companyId,
          type: "AUDIT_CALL",
          status: "EFFECTIVE",
          effectiveAt: { not: null },
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
        warnings.push(
          "A review or audit has already been required in this fiscal year (Section 8.3).",
        );
      }
    }
    if (input.recordDate > today) {
      warnings.push("The record date cannot be in the future.");
    }

    // Refusals of `send` that do not depend on the record date.
    const mail = currentMailDelivery("RESOLUTION");
    if (mail.blockedReason !== null) blockers.push(mail.blockedReason);
    // The stored draft (the editor saves before opening the send dialog)
    // still holding a starter placeholder, as `send` refuses it.
    if (input.publicId) {
      const draftBody = await ctx.db.resolution.findFirst({
        where: { publicId: input.publicId, companyId },
        select: { body: true },
      });
      const normalized = draftBody ? normalizeBlocks(draftBody.body) : null;
      if (normalized?.ok) {
        const placeholders = unfilledPlaceholders(
          docToPlainText(normalized.doc),
        );
        if (placeholders.length > 0) {
          blockers.push(placeholderBlocker(placeholders));
        }
      }
    }
    if (type === "TERM_EXTENSION") {
      const stored = input.publicId
        ? await ctx.db.resolution.findFirst({
            where: { publicId: input.publicId, companyId },
            select: { id: true, title: true },
          })
        : null;
      for (const blocker of await termExtensionSendBlockers(ctx.db, companyId, {
        id: stored?.id ?? "",
        params,
        // Without the draft, only the dates are checked here (send also
        // checks the stored title).
        title:
          stored?.title ??
          buildTitle(type, params, { companyName: ctx.company.name }),
      })) {
        blockers.push(blocker);
      }
    }

    return {
      requirements,
      recipients,
      excluded,
      warnings,
      blockers,
      timeZone: zone,
      /** Emails go to the local mail catcher (the dialog shows "Test mode"). */
      mailTestMode: mail.testMode,
    };
  });
