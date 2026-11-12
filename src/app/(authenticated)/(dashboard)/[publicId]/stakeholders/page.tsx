import { RiGroup2Fill } from "@remixicon/react";
import type { Metadata } from "next";
import EmptyState from "@/components/common/empty-state";
import { MemberFormDialog } from "@/components/llc/member/member-form-dialog";
import { MemberTable } from "@/components/llc/member/member-table";
import StakeholderDropdown from "@/components/stakeholder/stakeholder-dropdown";
import StakeholderTable from "@/components/stakeholder/stakeholder-table";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { UnAuthorizedState } from "@/components/ui/un-authorized-state";
import { serverAccessControl } from "@/lib/rbac/access-control";
import { getSessionEntity } from "@/server/entity";
import { api } from "@/trpc/server";

export const metadata: Metadata = {
  title: "Stakeholders",
};

const MembersPage = async () => {
  const { allow } = await serverAccessControl();
  const members = await allow(api.stakeholder.getStakeholders(), [
    "stakeholder",
    "read",
  ]);

  const addMember = allow(
    <MemberFormDialog trigger={<Button>Add member</Button>} />,
    ["stakeholder", "create"],
    null,
  );

  if (!members) {
    return <UnAuthorizedState />;
  }

  if (members.length === 0) {
    return (
      <EmptyState
        icon={<RiGroup2Fill />}
        title="No members yet."
        subtitle="Add a member or send a subscription from Admissions."
      >
        {addMember}
      </EmptyState>
    );
  }

  return (
    <div className="flex flex-col gap-y-3">
      <div className="flex items-center justify-between gap-y-3">
        <div className="gap-y-3">
          <h3 className="font-medium">Members</h3>
          <p className="text-sm text-muted-foreground">
            Members, prospects and holders of a financial interest
          </p>
        </div>

        <div>{addMember}</div>
      </div>

      <Card className="mx-auto mt-3 w-md sm:w-152 md:w-full">
        <MemberTable stakeholders={members} />
      </Card>
    </div>
  );
};

const StakeholdersPage = async () => {
  const entity = await getSessionEntity();
  if (entity.isLlc) {
    return <MembersPage />;
  }

  const { allow } = await serverAccessControl();
  const stakeholders = await allow(api.stakeholder.getStakeholders(), [
    "stakeholder",
    "read",
  ]);

  const stakeholderDropdown = allow(
    <StakeholderDropdown />,
    ["stakeholder", "create"],
    null,
  );

  if (!stakeholders) {
    return <UnAuthorizedState />;
  }

  if (stakeholders.length === 0) {
    return (
      <EmptyState
        icon={<RiGroup2Fill />}
        title="You do not have any stakeholders!"
        subtitle="Please click the button below to add or import stakeholders."
      >
        {stakeholderDropdown}
      </EmptyState>
    );
  }

  return (
    <div className="flex flex-col gap-y-3">
      <div className="flex items-center justify-between gap-y-3">
        <div className="gap-y-3">
          <h3 className="font-medium">Stakeholders</h3>
          <p className="text-sm text-muted-foreground">
            Manage stakeholders for your company
          </p>
        </div>

        <div>{stakeholderDropdown}</div>
      </div>

      <Card className="mx-auto mt-3 w-md sm:w-152 md:w-full">
        <StakeholderTable stakeholders={stakeholders} />
      </Card>
    </div>
  );
};

export default StakeholdersPage;
