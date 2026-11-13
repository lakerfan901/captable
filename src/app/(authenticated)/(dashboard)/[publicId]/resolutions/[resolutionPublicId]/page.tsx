import { TRPCError } from "@trpc/server";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ResolutionDetail } from "@/components/governance/resolution-detail";
import { ResolutionDraftEditor } from "@/components/governance/resolution-draft-editor";
import { UnAuthorizedState } from "@/components/ui/un-authorized-state";
import type { ResolutionType } from "@/lib/governance/presets";
import { serverAccessControl } from "@/lib/rbac/access-control";
import { withServerComponentSession } from "@/server/auth";
import { requireLlc } from "@/server/entity";
import { api } from "@/trpc/server";

export const metadata: Metadata = { title: "Resolution" };

// Resolution detail (03-governance.md G10 page 3). A DRAFT shows the draft
// editor; any other status shows the sent-resolution view (G11,
// `ResolutionDetail`).

export default async function ResolutionPage({
  params,
}: {
  params: Promise<{ publicId: string; resolutionPublicId: string }>;
}) {
  const entity = await requireLlc();
  const { resolutionPublicId } = await params;
  const { allow } = await serverAccessControl();
  if (!allow(true, ["governance", "read"], false)) {
    return <UnAuthorizedState />;
  }

  let data: Awaited<ReturnType<typeof api.resolution.get>>;
  try {
    data = await api.resolution.get({ publicId: resolutionPublicId });
  } catch (e) {
    if (e instanceof TRPCError && e.code === "NOT_FOUND") notFound();
    throw e;
  }

  const base = `/${entity.publicId}/resolutions`;
  const { resolution } = data;

  if (resolution.status === "DRAFT") {
    const canUpdate = allow(true, ["governance", "update"], false);
    const canDelete = allow(true, ["governance", "delete"], false);
    const mailCatcher = allow(true, ["emails", "read"], false)
      ? (await api.emailLog.deliveryStatus()).mailCatcher
      : false;
    const session = await withServerComponentSession();
    const stakeholders =
      (await allow(api.stakeholder.getStakeholders(), [
        "stakeholder",
        "read",
      ])) ?? [];
    const members = stakeholders
      .map((s) => ({ id: s.id, name: s.name }))
      .sort((a, b) => a.name.localeCompare(b.name, "en"));

    return (
      <ResolutionDraftEditor
        base={base}
        companyName={entity.name}
        publicId={resolution.publicId}
        type={resolution.type as ResolutionType}
        title={resolution.title}
        params={(resolution.params ?? {}) as Record<string, unknown>}
        body={Array.isArray(resolution.body) ? resolution.body : []}
        members={members}
        canEdit={canUpdate}
        canDelete={canDelete}
        mailCatcher={mailCatcher}
        defaultSignerName={session.user.name ?? ""}
      />
    );
  }

  // Sent-resolution view (03-governance.md G11).
  const session = await withServerComponentSession();
  return (
    <ResolutionDetail
      data={data}
      base={base}
      timeZone={entity.timezone}
      canUpdate={allow(true, ["governance", "update"], false)}
      canCreate={allow(true, ["governance", "create"], false)}
      canReadDocuments={allow(true, ["documents", "read"], false)}
      canReadFinancials={allow(true, ["llc-financials", "read"], false)}
      defaultSignerName={session.user.name ?? ""}
    />
  );
}
