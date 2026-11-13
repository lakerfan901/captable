import type { Stakeholder } from "@prisma/client";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { dateToWire } from "@/server/llc/serialize";
import { withLlcAccessControl } from "@/trpc/api/trpc";
import type { MemberDTO } from "../member-schema";

/** Stakeholder row → MemberDTO (never includes `taxId`). */
export function toMemberDTO(s: Stakeholder): MemberDTO {
  return {
    id: s.id,
    name: s.name,
    email: s.email,
    noticeEmail: s.noticeEmail,
    effectiveNoticeEmail: s.noticeEmail ?? s.email,
    holderType: s.holderType,
    residenceState: s.residenceState,
    accreditationBasis: s.accreditationBasis,
    admittedOn: dateToWire(s.admittedOn),
    signerName: s.signerName,
    signerTitle: s.signerTitle,
    phone: s.phone,
    streetAddress: s.streetAddress,
    city: s.city,
    state: s.state,
    zipcode: s.zipcode,
    isInsider: s.isInsider,
    memberStatus: s.memberStatus,
    createdAt: s.createdAt.toISOString(),
  };
}

/** Prisma unique-constraint violation (P2002). */
export function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "P2002"
  );
}

export const getMemberProcedure = withLlcAccessControl
  .meta({ policies: { stakeholder: { allow: ["read"] } } })
  .input(z.object({ id: z.string() }))
  .query(async ({ ctx: { db, membership }, input }) => {
    const stakeholder = await db.stakeholder.findFirst({
      where: { id: input.id, companyId: membership.companyId },
    });
    if (!stakeholder) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Member not found." });
    }
    // A prospect with an open subscription is shown as "Committed".
    const pending = await db.commitment.findFirst({
      where: {
        companyId: membership.companyId,
        stakeholderId: stakeholder.id,
        status: "PENDING",
      },
      select: { id: true },
    });
    return {
      ...toMemberDTO(stakeholder),
      hasPendingCommitment: pending !== null,
    };
  });
