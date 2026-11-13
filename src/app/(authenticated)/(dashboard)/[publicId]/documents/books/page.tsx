import type { Metadata } from "next";
import { PageLayout } from "@/components/dashboard/page-layout";
import { BooksOverview } from "@/components/governance/books-overview";
import { UnAuthorizedState } from "@/components/ui/un-authorized-state";
import { GOVERNANCE_TIME_ZONE, todayInZone } from "@/lib/governance/dates";
import { serverAccessControl } from "@/lib/rbac/access-control";
import { requireLlc } from "@/server/entity";
import { api } from "@/trpc/server";

export const metadata: Metadata = {
  title: "Books and records",
};

// Books and records (03-governance.md G18): the six record categories the LLC
// keeps under Section 8.1 of the Operating Agreement, with completeness.

export default async function BooksPage() {
  const entity = await requireLlc();
  const { allow } = await serverAccessControl();
  const overview = await allow(api.books.overview(), ["documents", "read"]);
  if (!overview) return <UnAuthorizedState />;
  const canUpdate = allow(true, ["documents", "update"], false);
  const today = todayInZone(
    new Date(),
    entity.timezone || GOVERNANCE_TIME_ZONE,
  );
  const lastCompletedYear = Number(today.slice(0, 4)) - 1;

  return (
    <PageLayout
      title="Books and records"
      description="Records the LLC keeps under Section 8.1 of the Operating Agreement"
    >
      <div className="mt-4">
        <BooksOverview
          overview={overview}
          companyPublicId={entity.publicId}
          canUpdate={canUpdate}
          lastCompletedYear={lastCompletedYear}
        />
      </div>
    </PageLayout>
  );
}
