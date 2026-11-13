import {
  INVESTOR_ROLE,
  MANAGER_ROLE,
  packetStageOf,
} from "@/server/llc/admission";
import { withLlcAccessControl } from "@/trpc/api/trpc";

// admission.list (F12): every Exhibit B packet of the company, newest first,
// with its stage and the number of W-9s filed since it was sent. No link,
// token, storage key or download URL is returned.
export const listProcedure = withLlcAccessControl
  .meta({ policies: { commitments: { allow: ["read"] } } })
  .query(async ({ ctx }) => {
    const companyId = ctx.membership.companyId;
    const packets = await ctx.db.template.findMany({
      where: { companyId, workflow: "SUBSCRIPTION", isMaster: false },
      select: {
        id: true,
        publicId: true,
        name: true,
        status: true,
        createdAt: true,
        stakeholderId: true,
        commitmentId: true,
        stakeholder: { select: { name: true } },
        commitment: { select: { status: true } },
        eSignRecipient: {
          select: { role: true, status: true, email: true, name: true },
        },
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });

    const stakeholderIds = [
      ...new Set(
        packets
          .map((p) => p.stakeholderId)
          .filter((id): id is string => id !== null),
      ),
    ];
    const w9s =
      stakeholderIds.length === 0
        ? []
        : await ctx.db.document.findMany({
            where: {
              companyId,
              kind: "w9",
              stakeholderId: { in: stakeholderIds },
            },
            select: { stakeholderId: true, createdAt: true },
          });

    return packets.map((packet) => {
      const investor = packet.eSignRecipient.find(
        (r) => r.role === INVESTOR_ROLE,
      );
      const manager = packet.eSignRecipient.find(
        (r) => r.role === MANAGER_ROLE,
      );
      return {
        publicId: packet.publicId,
        name: packet.name,
        createdAt: packet.createdAt,
        stakeholderId: packet.stakeholderId,
        stakeholderName: packet.stakeholder?.name ?? investor?.name ?? null,
        investorEmail: investor?.email ?? null,
        managerName: manager?.name ?? null,
        stage: packetStageOf(packet),
        w9Count: w9s.filter(
          (doc) =>
            doc.stakeholderId === packet.stakeholderId &&
            doc.createdAt >= packet.createdAt,
        ).length,
        commitmentId: packet.commitmentId,
      };
    });
  });
