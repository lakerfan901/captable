import type { Metadata } from "next";
import Link from "next/link";
import { UnAuthorizedState } from "@/components/ui/un-authorized-state";
import { serverAccessControl } from "@/lib/rbac/access-control";
import { requireLlc } from "@/server/entity";
import { api } from "@/trpc/server";
import { DistributionWizard } from "../components/distribution-wizard";

export const metadata: Metadata = { title: "New distribution" };

export default async function NewDistributionPage() {
  const entity = await requireLlc();
  const { allow } = await serverAccessControl();
  const canCreate = allow(true, ["distributions", "create"], false);
  const list = canCreate
    ? await allow(api.distribution.list(), ["distributions", "read"])
    : null;
  if (!canCreate || !list) return <UnAuthorizedState />;
  const companyBase = `/${entity.publicId}`;
  const base = `${companyBase}/distributions`;

  return (
    <div className="flex flex-col gap-y-4">
      <div>
        <Link href={base} className="text-sm text-muted-foreground">
          ← Distributions
        </Link>
        <h3 className="font-medium">New distribution</h3>
        <p className="max-w-2xl text-sm text-muted-foreground">
          Saving creates a draft. Nothing is recorded in the ledger until the
          distribution is finalized.
        </p>
      </div>
      <DistributionWizard
        base={base}
        companyBase={companyBase}
        today={list.today}
        draft={null}
        step="setup"
        conflict={false}
        canCreate={canCreate}
        canUpdate={allow(true, ["distributions", "update"], false)}
        canDelete={allow(true, ["distributions", "delete"], false)}
        canReadFinancials={allow(true, ["llc-financials", "read"], false)}
      />
    </div>
  );
}
