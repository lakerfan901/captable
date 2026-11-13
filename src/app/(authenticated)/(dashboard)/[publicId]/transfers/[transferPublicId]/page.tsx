import { TRPCError } from "@trpc/server";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import {
  TransferDetail,
  type TransferMemberOption,
  type TransferResolutionOption,
} from "@/components/governance/transfer-detail";
import { UnAuthorizedState } from "@/components/ui/un-authorized-state";
import { GOVERNANCE_TIME_ZONE } from "@/lib/governance/dates";
import { COMMON_TRANSFER_MATTER } from "@/lib/governance/transfer-core";
import { serverAccessControl } from "@/lib/rbac/access-control";
import { requireLlc } from "@/server/entity";
import { api } from "@/trpc/server";

export const metadata: Metadata = { title: "Transfer" };

// Unit transfer (03-governance.md G17 page 3). The transferee select comes
// from `stakeholder.getStakeholders` and the approving-resolution select of a
// Common Unit transfer from `resolution.options` (matter
// COMMON_TRANSFER_OR_CONTROL; only an EFFECTIVE one allows completion).

export default async function TransferPage({
  params,
}: {
  params: Promise<{ publicId: string; transferPublicId: string }>;
}) {
  const entity = await requireLlc();
  const { transferPublicId } = await params;
  const { allow } = await serverAccessControl();
  if (!allow(true, ["governance", "read"], false)) {
    return <UnAuthorizedState />;
  }

  let data: Awaited<ReturnType<typeof api.unitTransfer.get>>;
  try {
    data = await api.unitTransfer.get({ publicId: transferPublicId });
  } catch (e) {
    if (e instanceof TRPCError && e.code === "NOT_FOUND") notFound();
    throw e;
  }

  const isOpen = data.status === "OPEN";
  let members: TransferMemberOption[] = [];
  if (isOpen) {
    const stakeholders =
      (await allow(api.stakeholder.getStakeholders(), [
        "stakeholder",
        "read",
      ])) ?? [];
    members = stakeholders
      .map((s) => ({ id: s.id, name: s.name, memberStatus: s.memberStatus }))
      .sort((a, b) => a.name.localeCompare(b.name, "en"));
  }

  let resolutions: TransferResolutionOption[] = [];
  if (isOpen && data.unitClassKind === "COMMON") {
    const rows = await api.resolution.options({
      statuses: ["SENT", "EFFECTIVE"],
    });
    resolutions = rows
      .filter((r) => r.matterKey === COMMON_TRANSFER_MATTER)
      .map((r) => ({
        publicId: r.publicId,
        label: r.referenceCode ? `${r.referenceCode} ${r.title}` : r.title,
        status: r.status,
      }));
  }

  return (
    <TransferDetail
      data={data}
      base={`/${entity.publicId}/transfers`}
      companyPublicId={entity.publicId}
      members={members}
      resolutions={resolutions}
      timeZone={entity.timezone || GOVERNANCE_TIME_ZONE}
    />
  );
}
