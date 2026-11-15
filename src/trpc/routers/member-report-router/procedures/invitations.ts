import "server-only";
import { TRPCError } from "@trpc/server";
import {
  type InviteCandidate,
  invitationEmailsToQueue,
  inviteTargets,
} from "@/lib/governance/recipient-core";
import { RBAC } from "@/lib/rbac";
import type { TPermission } from "@/lib/rbac/schema";
import type { TPrismaOrTransaction } from "@/server/db";
import {
  type InviteHolderResult,
  type InviteOutcome,
  InviteRefusedError,
  inviteHolder,
  queueInviteEmail,
} from "@/server/portal/invite";

// Invitations with a release or an addition of recipients
// (04-investor-portal.md P27, 5.5 `inviteMissing`; package P4b).
//
// "Invite these {n} addresses to the portal": for each selected holder, its
// notice address is invited to the portal FOR THAT HOLDER when that address
// has no access to it, with P3's `inviteHolder` (the code of
// `portalAdmin.invite`). An access the team DISABLED is left disabled
// (`reactivateDisabled: false`) and reported; an ACTIVE one is left as it
// is. The caller has already checked `portal: create` (`assertMayInvite`)
// and `assertMailDeliverable("MEMBER_EMAIL")` before its transaction.
//
// Lock order: every invitation takes the portal user's row lock
// (`lockPortalUser`), AFTER the caller's ledger, unit-class and report
// locks; nothing in the portal takes those after a user lock. Invitations
// run in address order (`inviteTargets`), so two calls inviting the same
// people lock them in the same order.
//
// The result never says which email a person gets (an invitation or "access
// added"): that would tell the team the address has a portal account
// elsewhere. One email per person (`invitationEmailsToQueue`).

/** P29 / 5.5: `inviteMissing` also needs `portal: create`; FORBIDDEN otherwise. */
export function assertMayInvite(permissions: TPermission[]): void {
  const check = new RBAC()
    .addPolicies({ portal: { allow: ["create"] } })
    .enforce(permissions);
  if (check.err || !check.val.valid) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message:
        "Inviting holders to the investor portal needs the portal permission.",
    });
  }
}

export type InvitationOutcome =
  | Exclude<InviteOutcome, "REACTIVATED">
  /** The holder has no notice address: nobody to invite. */
  | "NO_ADDRESS"
  /** The notice address is not a valid portal address. */
  | "INVALID_ADDRESS";

export interface InvitationLine {
  stakeholderId: string;
  name: string;
  /** The normalised address invited; null when none could be. */
  email: string | null;
  /**
   * CREATED: a new access (an email is sent); ALREADY_ACTIVE: the address
   * already had access to this holder (nothing sent); LEFT_DISABLED: the
   * team had disabled it, it stays disabled (nothing sent).
   */
  outcome: InvitationOutcome;
}

export interface InvitationRun {
  lines: InvitationLine[];
  /** The results whose email is queued after commit (one per person). */
  toQueue: InviteHolderResult[];
}

export async function inviteSelectedHolders(
  tx: TPrismaOrTransaction,
  input: {
    companyId: string;
    invitedById: string;
    candidates: readonly InviteCandidate[];
    audit: {
      actorUserId: string;
      actorName: string;
      requestIp: string;
      userAgent: string;
    };
    now: Date;
  },
): Promise<InvitationRun> {
  const { targets, skipped } = inviteTargets(input.candidates);
  const lines: InvitationLine[] = skipped.map((s) => ({
    stakeholderId: s.stakeholderId,
    name: s.name,
    email: null,
    outcome: s.reason,
  }));
  const results: InviteHolderResult[] = [];
  for (const t of targets) {
    let result: InviteHolderResult;
    try {
      result = await inviteHolder(tx, {
        companyId: input.companyId,
        stakeholderId: t.stakeholderId,
        email: t.email,
        invitedById: input.invitedById,
        reactivateDisabled: false,
        audit: input.audit,
        now: input.now,
      });
    } catch (error) {
      // Not expected (addresses are normalised and holders loaded under the
      // locks first); refused as a whole, nothing is written.
      if (error instanceof InviteRefusedError) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `${t.name}: ${error.message}`,
        });
      }
      throw error;
    }
    results.push(result);
    lines.push({
      stakeholderId: t.stakeholderId,
      name: t.name,
      email: result.email,
      // REACTIVATED cannot happen with `reactivateDisabled: false`.
      outcome: result.outcome === "REACTIVATED" ? "CREATED" : result.outcome,
    });
  }
  return { lines, toQueue: invitationEmailsToQueue(results) };
}

/** After commit only. Never throws (`emitPortalAccountEmail` logs). */
export async function queueInvitations(run: InvitationRun | null) {
  if (run === null) return 0;
  for (const r of run.toQueue) await queueInviteEmail(r);
  return run.toQueue.length;
}

/** For the audit summaries: "invited 2 addresses to the portal (…); 1 left disabled (…)". */
export function invitationSummary(run: InvitationRun | null): string | null {
  if (run === null) return null;
  const created = run.lines.filter((l) => l.outcome === "CREATED");
  const disabled = run.lines.filter((l) => l.outcome === "LEFT_DISABLED");
  const none = run.lines.filter(
    (l) => l.outcome === "NO_ADDRESS" || l.outcome === "INVALID_ADDRESS",
  );
  const parts: string[] = [];
  const list = (ls: InvitationLine[]) =>
    ls.map((l) => (l.email ? `${l.name} at ${l.email}` : l.name)).join(", ");
  if (created.length > 0) {
    parts.push(
      `invited ${created.length} ${created.length === 1 ? "address" : "addresses"} to the investor portal (${list(created)})`,
    );
  }
  if (disabled.length > 0) {
    parts.push(`portal access left disabled for ${list(disabled)}`);
  }
  if (none.length > 0) {
    parts.push(`not invited, no valid notice address: ${list(none)}`);
  }
  return parts.length > 0 ? parts.join("; ") : null;
}
