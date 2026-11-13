import { TRPCError } from "@trpc/server";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ResolutionDraftEditor } from "@/components/governance/resolution-draft-editor";
import { RichDocView } from "@/components/governance/rich-doc-view";
import { StatusBadge } from "@/components/governance/status-badge";
import { UnAuthorizedState } from "@/components/ui/un-authorized-state";
import type { ResolutionType } from "@/lib/governance/presets";
import { serverAccessControl } from "@/lib/rbac/access-control";
import { withServerComponentSession } from "@/server/auth";
import { requireLlc } from "@/server/entity";
import { api } from "@/trpc/server";

export const metadata: Metadata = { title: "Resolution" };

// Resolution detail (03-governance.md G10 page 3). A DRAFT shows the draft
// editor; any other status shows the sent-resolution view, which G11 provides
// (see `SentResolutionSlot` below).

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

  return <SentResolutionSlot base={base} data={data} />;
}

/**
 * Placeholder for the sent-resolution view. G11 replaces this component's
 * body with `<ResolutionDetail ... />` (03-governance.md G11); until then it
 * shows the title, the status and the frozen document only.
 */
function SentResolutionSlot({
  base,
  data,
}: {
  base: string;
  data: Awaited<ReturnType<typeof api.resolution.get>>;
}) {
  const { resolution, starter } = data;
  return (
    <div className="flex flex-col gap-4" data-slot="sent-resolution">
      <Link href={base} className="text-sm text-muted-foreground">
        ← Resolutions
      </Link>
      <div className="flex flex-wrap items-center gap-3">
        <h3 className="font-medium">{resolution.title}</h3>
        <StatusBadge status={resolution.status} />
        {resolution.referenceCode ? (
          <span className="text-sm text-muted-foreground">
            {resolution.referenceCode}
          </span>
        ) : null}
      </div>
      <p className="rounded border border-dashed p-3 text-sm text-muted-foreground">
        The tally and ballot details for sent resolutions are not available yet.
        The frozen text is shown below.
      </p>
      <div className="rounded border p-4">
        <RichDocView doc={starter.doc} />
        {starter.lockedClauses.length > 0 ? (
          <ol className="mt-4 list-decimal space-y-1 pl-5 text-sm">
            {starter.lockedClauses.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ol>
        ) : null}
      </div>
    </div>
  );
}
