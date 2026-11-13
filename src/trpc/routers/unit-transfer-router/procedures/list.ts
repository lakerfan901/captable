import { utcDateToYmd } from "@/lib/governance/dates";
import { withLlcAccessControl } from "@/trpc/api/trpc";
import { ZUnitTransferListSchema } from "../schema";
import { stakeholderNames } from "./shared";

// unitTransfer.list (03-governance.md G16): the company's transfers, newest
// notice first, with the transferor's and transferee's names.

export const listProcedure = withLlcAccessControl
  .meta({ policies: { governance: { allow: ["read"] } } })
  .input(ZUnitTransferListSchema)
  .query(async ({ ctx, input }) => {
    const companyId = ctx.membership.companyId;
    const rows = await ctx.db.unitTransfer.findMany({
      where: { companyId, ...(input.status ? { status: input.status } : {}) },
      orderBy: [
        { noticeReceivedOn: "desc" },
        { createdAt: "desc" },
        { id: "desc" },
      ],
      select: {
        publicId: true,
        kind: true,
        status: true,
        fromStakeholderId: true,
        toStakeholderId: true,
        unitClassKind: true,
        units: true,
        noticeReceivedOn: true,
        transferNoticeOn: true,
        effectiveOn: true,
        admittedOn: true,
        createdAt: true,
      },
    });
    const names = await stakeholderNames(
      ctx.db,
      companyId,
      rows.flatMap((r) => [r.fromStakeholderId, r.toStakeholderId]),
    );
    return rows.map((r) => ({
      publicId: r.publicId,
      kind: r.kind,
      status: r.status,
      fromStakeholderId: r.fromStakeholderId,
      fromName: names.get(r.fromStakeholderId) ?? "",
      toStakeholderId: r.toStakeholderId,
      toName:
        r.toStakeholderId === null
          ? null
          : (names.get(r.toStakeholderId) ?? ""),
      unitClassKind: r.unitClassKind,
      units: r.units.toFixed(6),
      noticeReceivedOn: utcDateToYmd(r.noticeReceivedOn),
      transferNoticeOn: r.transferNoticeOn
        ? utcDateToYmd(r.transferNoticeOn)
        : null,
      effectiveOn: r.effectiveOn ? utcDateToYmd(r.effectiveOn) : null,
      admittedOn: r.admittedOn ? utcDateToYmd(r.admittedOn) : null,
      createdAt: r.createdAt,
    }));
  });
