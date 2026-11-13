import type { Stakeholder } from "@prisma/client";
import { TRPCError } from "@trpc/server";
import type { z } from "zod";
import { formatCents } from "@/lib/money";
import { Audit } from "@/server/audit";
import type { PrismaTransactionalClient } from "@/server/db";
import { guardedUpdate } from "@/server/guarded-write";
import {
  createCommitment,
  type LedgerActor,
  updatePendingCommitment,
} from "@/server/llc/commitments";
import { actorFrom } from "@/server/llc/economics/scope";
import { withLlcAccessControl } from "@/trpc/api/trpc";
import { loadPacketView, lockPacket, wrongStage } from "../packet";
import { ZodConfirmDetailsSchema } from "../schema";

export type ConfirmDetailsInput = z.infer<typeof ZodConfirmDetailsSchema>;

export const STALE_PACKET =
  "This subscription was changed by someone else since you opened it. Reload the page, check the details and confirm again.";
export const STALE_MEMBER =
  "The member record was changed since you opened this page. Reload the page, check the details and confirm again.";
export const MEMBER_RECORD_CHOICE =
  "This person is already a Member. Choose whether the confirmed details replace the member record.";

const conflict = (message: string) =>
  new TRPCError({ code: "CONFLICT", message });

type MemberFields = Pick<
  Stakeholder,
  | "name"
  | "holderType"
  | "residenceState"
  | "accreditationBasis"
  | "streetAddress"
  | "city"
  | "state"
  | "zipcode"
  | "noticeEmail"
  | "signerName"
  | "signerTitle"
  | "phone"
  | "isInsider"
>;

const FIELD_LABEL: Record<keyof MemberFields, string> = {
  name: "name",
  holderType: "holder type",
  residenceState: "state of residence",
  accreditationBasis: "accreditation basis",
  streetAddress: "street",
  city: "city",
  state: "state",
  zipcode: "ZIP",
  noticeEmail: "notice email",
  signerName: "signer name",
  signerTitle: "signer title",
  phone: "phone",
  isInsider: "insider",
};

/** `undefined` keeps the stored value; `null` or "" clears it. */
const optional = (value: string | null | undefined, stored: string | null) =>
  value === undefined ? stored : value === null || value === "" ? null : value;

/** The member record after applying the confirmed details. */
function nextMemberFields(
  stored: Stakeholder,
  input: ConfirmDetailsInput["stakeholder"],
): MemberFields {
  const noticeEmail = optional(input.noticeEmail, stored.noticeEmail);
  return {
    name: input.name,
    holderType: input.holderType,
    residenceState: input.residenceState,
    accreditationBasis: input.accreditationBasis,
    streetAddress: input.streetAddress,
    city: input.city,
    state: input.state,
    zipcode: input.zipcode,
    // The login / record email is never changed here; a different address
    // the investor gave becomes the notice email. The same address as the
    // record email is not stored twice.
    noticeEmail:
      noticeEmail !== null && noticeEmail === stored.email.toLowerCase()
        ? null
        : noticeEmail,
    signerName: optional(input.signerName, stored.signerName),
    signerTitle: optional(input.signerTitle, stored.signerTitle),
    phone: optional(input.phone, stored.phone),
    isInsider: input.isInsider,
  };
}

function memberChanges(stored: Stakeholder, next: MemberFields): string[] {
  const show = (v: string | boolean | null) =>
    v === null ? "none" : typeof v === "boolean" ? (v ? "yes" : "no") : v;
  return (Object.keys(FIELD_LABEL) as (keyof MemberFields)[])
    .filter((key) => stored[key] !== next[key])
    .map(
      (key) => `${FIELD_LABEL[key]} ${show(stored[key])} → ${show(next[key])}`,
    );
}

/**
 * admission.confirmDetails (F13), inside the caller's transaction: writes the
 * details the Manager confirmed to the member record (show-and-confirm: the
 * values come from the input, never from the packet) and creates or updates
 * the packet's PENDING commitment through the F6 services.
 */
export async function confirmPacketDetails(
  tx: PrismaTransactionalClient,
  companyId: string,
  input: ConfirmDetailsInput,
  actor: LedgerActor,
): Promise<{ commitmentId: string; created: boolean; changes: string[] }> {
  const { packet, stage } = await lockPacket(tx, companyId, input.publicId, {
    ledger: true,
  });
  if (stage !== "AWAITING_REVIEW") {
    throw wrongStage(
      "The details can only be confirmed after the investor has signed and before the decision.",
      stage,
    );
  }
  if (packet.commitmentId !== input.expected.commitmentId) {
    throw conflict(STALE_PACKET);
  }
  const stored = packet.stakeholderId
    ? await tx.stakeholder.findFirst({
        where: { id: packet.stakeholderId, companyId },
      })
    : null;
  if (!stored) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "The subscription's member was not found.",
    });
  }
  if (stored.updatedAt.toISOString() !== input.expected.stakeholderVersion) {
    throw conflict(STALE_MEMBER);
  }

  // A prospect's record is the Exhibit B; an admitted Member's register entry
  // (or a Financial Interest holder's) changes only on an explicit choice.
  const isProspect = stored.memberStatus === "PROSPECT";
  if (!isProspect && input.updateMemberRecord === undefined) {
    throw new TRPCError({ code: "BAD_REQUEST", message: MEMBER_RECORD_CHOICE });
  }
  const writeMember = isProspect || input.updateMemberRecord === true;

  let changes: string[] = [];
  if (writeMember) {
    const next = nextMemberFields(stored, input.stakeholder);
    if (
      (next.holderType === "TRUST" || next.holderType === "ENTITY") &&
      !next.signerName
    ) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "Signer name is required for trusts and entities.",
      });
    }
    changes = memberChanges(stored, next);
    if (changes.length > 0) {
      // Guarded on the version the Manager saw: a concurrent member edit
      // makes this a CONFLICT instead of being overwritten.
      const updated = await guardedUpdate(() =>
        tx.stakeholder.update({
          where: { id: stored.id, companyId, updatedAt: stored.updatedAt },
          data: next,
          select: { id: true },
        }),
      );
      if (updated === null) throw conflict(STALE_MEMBER);
    }
  }

  const committedCents = BigInt(input.commitment.committedCents);
  let commitmentId: string;
  let created = false;
  if (packet.commitmentId === null) {
    const preferred = await tx.unitClass.findFirst({
      where: { companyId, kind: "PREFERRED" },
      select: { id: true },
    });
    if (!preferred) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "The company has no Preferred unit class.",
      });
    }
    const commitment = await createCommitment(
      tx,
      {
        companyId,
        stakeholderId: stored.id,
        unitClassId: preferred.id,
        committedCents,
        signedOn: input.commitment.signedOn,
        investmentSummaryDate: input.commitment.investmentSummaryDate,
        accreditationBasis: input.stakeholder.accreditationBasis,
      },
      actor,
    );
    // Guarded single-row write (we hold the template lock, so this only
    // fails if the packet is no longer PENDING without a commitment).
    const linked = await guardedUpdate(() =>
      tx.template.update({
        where: {
          id: packet.id,
          companyId,
          status: "PENDING",
          AND: [{ commitmentId: null }],
        },
        data: { commitmentId: commitment.id },
        select: { id: true },
      }),
    );
    if (linked === null) throw conflict(STALE_PACKET);
    commitmentId = commitment.id;
    created = true;
  } else {
    const commitment = await updatePendingCommitment(
      tx,
      {
        companyId,
        commitmentId: packet.commitmentId,
        committedCents,
        signedOn: input.commitment.signedOn,
        investmentSummaryDate: input.commitment.investmentSummaryDate,
        accreditationBasis: input.stakeholder.accreditationBasis,
      },
      actor,
    );
    commitmentId = commitment.id;
  }

  await Audit.create(
    {
      action: "admission.confirmed",
      companyId,
      actor: { type: "user", id: actor.userId },
      context: { requestIp: actor.requestIp, userAgent: actor.userAgent },
      target: [
        { type: "template", id: packet.id },
        { type: "stakeholder", id: stored.id },
        { type: "commitment", id: commitmentId },
      ],
      summary: `${actor.name} confirmed the Exhibit B details of ${input.stakeholder.name}: ${formatCents(committedCents)} committed, signed ${input.commitment.signedOn}; member record ${
        !writeMember
          ? "kept unchanged"
          : changes.length > 0
            ? `updated (${changes.join("; ")})`
            : "unchanged (no differences)"
      }${created ? "; commitment created" : "; commitment updated"}.`,
    },
    tx,
  );

  return { commitmentId, created, changes };
}

export const confirmDetailsProcedure = withLlcAccessControl
  .meta({
    policies: {
      commitments: { allow: ["update"] },
      stakeholder: { allow: ["update"] },
    },
  })
  .input(ZodConfirmDetailsSchema)
  .mutation(({ ctx, input }) => {
    const companyId = ctx.membership.companyId;
    const actor = actorFrom(ctx);
    return ctx.db.$transaction(async (tx) => {
      await confirmPacketDetails(tx, companyId, input, actor);
      return loadPacketView(
        tx,
        ctx.company,
        input.publicId,
        ctx.membership.memberId,
      );
    });
  });
