import { RiQuillPenLine } from "@remixicon/react";
import type { Metadata } from "next";
import Link from "next/link";
import EmptyState from "@/components/common/empty-state";
import { PageLayout } from "@/components/dashboard/page-layout";
import { ResolutionTable } from "@/components/governance/resolution-table";
import { Button } from "@/components/ui/button";
import { UnAuthorizedState } from "@/components/ui/un-authorized-state";
import { serverAccessControl } from "@/lib/rbac/access-control";
import { requireLlc } from "@/server/entity";
import { api } from "@/trpc/server";

export const metadata: Metadata = { title: "Resolutions" };

export default async function ResolutionsPage() {
  const entity = await requireLlc();
  const { allow } = await serverAccessControl();
  const rows = await allow(api.resolution.list({}), ["governance", "read"]);
  if (!rows) return <UnAuthorizedState />;
  const canCreate = allow(true, ["governance", "create"], false);
  const base = `/${entity.publicId}/resolutions`;

  const action = canCreate ? (
    <Button asChild>
      <Link href={`${base}/new`}>New resolution</Link>
    </Button>
  ) : null;

  if (rows.length === 0) {
    return (
      <EmptyState
        icon={<RiQuillPenLine />}
        title="No resolutions yet"
        subtitle="Written consents of the Members and resolutions of the Manager appear here."
      >
        {action}
      </EmptyState>
    );
  }

  return (
    <PageLayout
      title="Resolutions"
      description="Written consents of the Members and resolutions of the Manager"
      action={action}
    >
      <ResolutionTable rows={rows} base={base} timeZone={entity.timezone} />
    </PageLayout>
  );
}
