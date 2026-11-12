import { RiHandCoinLine } from "@remixicon/react";
import type { Metadata } from "next";
import EmptyState from "@/components/common/empty-state";
import { CommitmentTable } from "@/components/llc/commitment/commitment-table";
import { IssueCommonUnitsDialog } from "@/components/llc/commitment/issue-common-units-dialog";
import { NewCommitmentDialog } from "@/components/llc/commitment/new-commitment-dialog";
import { ReceiptTable } from "@/components/llc/commitment/receipt-table";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { UnAuthorizedState } from "@/components/ui/un-authorized-state";
import { serverAccessControl } from "@/lib/rbac/access-control";
import { requireLlc } from "@/server/entity";
import { api } from "@/trpc/server";

export const metadata: Metadata = {
  title: "Commitments",
};

export default async function CommitmentsPage() {
  await requireLlc();
  const { allow } = await serverAccessControl();
  const data = await allow(
    Promise.all([
      api.commitment.list({}),
      api.commitment.receipts({}),
      api.unitClass.list(),
      api.stakeholder.getStakeholders(),
    ]),
    ["commitments", "read"],
  );

  if (!data) {
    return <UnAuthorizedState />;
  }

  const [commitments, receipts, { classes }, stakeholders] = data;
  const preferred = classes.find((c) => c.kind === "PREFERRED") ?? null;
  const acceptedTotalCents = commitments
    .filter(
      (c) =>
        c.unitClassId === preferred?.id &&
        (c.status === "ACCEPTED" || c.status === "REDUCED"),
    )
    .reduce((sum, c) => sum + c.acceptedCents, 0);

  const common = classes.find((c) => c.kind === "COMMON") ?? null;
  const memberOptions = stakeholders.map((s) => ({ id: s.id, name: s.name }));

  const newCommitment = allow(
    <>
      <NewCommitmentDialog
        trigger={<Button>New commitment</Button>}
        stakeholders={memberOptions}
        unitClass={preferred}
        acceptedTotalCents={acceptedTotalCents}
      />
      <IssueCommonUnitsDialog
        trigger={<Button variant="outline">Issue common units</Button>}
        stakeholders={memberOptions}
        unitClass={common}
      />
    </>,
    ["commitments", "create"],
    null,
  );

  if (commitments.length === 0) {
    return (
      <EmptyState
        icon={<RiHandCoinLine />}
        title="No commitments yet."
        subtitle="Create one here or send a subscription from Admissions."
      >
        {newCommitment}
      </EmptyState>
    );
  }

  return (
    <div className="flex flex-col gap-y-3">
      <div className="flex items-center justify-between gap-y-3">
        <div className="gap-y-3">
          <h3 className="font-medium">Commitments</h3>
          <p className="text-sm text-muted-foreground">
            Subscriptions, capital received and units issued
          </p>
        </div>
        <div className="flex gap-2">{newCommitment}</div>
      </div>

      <Tabs defaultValue="commitments">
        <TabsList>
          <TabsTrigger value="commitments">Commitments</TabsTrigger>
          <TabsTrigger value="receipts">Receipts</TabsTrigger>
        </TabsList>
        <TabsContent value="commitments">
          <Card className="mx-auto mt-3 w-md sm:w-152 md:w-full">
            <CommitmentTable
              commitments={commitments}
              unitClass={preferred}
              acceptedTotalCents={acceptedTotalCents}
            />
          </Card>
        </TabsContent>
        <TabsContent value="receipts">
          <Card className="mx-auto mt-3 w-md sm:w-152 md:w-full">
            <ReceiptTable receipts={receipts} />
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
