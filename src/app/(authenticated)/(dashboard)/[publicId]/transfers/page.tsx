import { RiArrowLeftRightLine } from "@remixicon/react";
import type { Metadata } from "next";
import Link from "next/link";
import EmptyState from "@/components/common/empty-state";
import { PageLayout } from "@/components/dashboard/page-layout";
import { TransferTable } from "@/components/governance/transfer-table";
import { Button } from "@/components/ui/button";
import { UnAuthorizedState } from "@/components/ui/un-authorized-state";
import { serverAccessControl } from "@/lib/rbac/access-control";
import { requireLlc } from "@/server/entity";
import { api } from "@/trpc/server";

export const metadata: Metadata = { title: "Transfers" };

// Unit transfers (03-governance.md G17 page 1).

export default async function TransfersPage() {
  const entity = await requireLlc();
  const { allow } = await serverAccessControl();
  const rows = await allow(api.unitTransfer.list({}), ["governance", "read"]);
  if (!rows) return <UnAuthorizedState />;
  const canCreate = allow(true, ["governance", "create"], false);
  const base = `/${entity.publicId}/transfers`;

  const action = canCreate ? (
    <Button asChild>
      <Link href={`${base}/new`}>Record a transfer</Link>
    </Button>
  ) : null;

  return (
    <PageLayout
      title="Transfers"
      description="Transfers of Units under Section 7 of the Operating Agreement"
      action={action}
    >
      {rows.length === 0 ? (
        <EmptyState
          icon={<RiArrowLeftRightLine />}
          title="No transfers recorded."
          subtitle="A transfer is recorded when the Manager receives a Transfer Notice or notice of a transfer."
        />
      ) : (
        <TransferTable rows={rows} base={base} />
      )}
    </PageLayout>
  );
}
