import { RiBankFill } from "@remixicon/react";
import type { Metadata } from "next";
import { Fragment } from "react";
import EmptyState from "@/components/common/empty-state";
import { UnAuthorizedState } from "@/components/ui/un-authorized-state";
import { serverAccessControl } from "@/lib/rbac/access-control";
import { api } from "@/trpc/server";
import CtaButton from "./components/cta-button";
import BankAccountsTable from "./components/table";

export const metadata: Metadata = {
  title: "Bank accounts",
};
const ApiSettingsPage = async () => {
  const { allow } = await serverAccessControl();

  const data = await allow(api.bankAccounts.getAll(), [
    "bank-accounts",
    "read",
  ]);

  if (!data) {
    return <UnAuthorizedState />;
  }

  const canCreate = allow(true, ["bank-accounts", "create"], false);
  const canDelete = allow(true, ["bank-accounts", "delete"], false);

  return (
    <Fragment>
      {data.bankAccounts.length === 0 ? (
        <EmptyState
          bordered={false}
          icon={<RiBankFill />}
          title="Bank accounts"
          subtitle={
            canCreate
              ? "Add a bank account to receive funds"
              : "No bank account has been added yet"
          }
        >
          {canCreate ? <CtaButton /> : null}
        </EmptyState>
      ) : (
        <div className="flex flex-col gap-y-3">
          <div className="flex items-center justify-between gap-y-3 ">
            <div className="gap-y-3">
              <h3 className="font-medium">Bank accounts</h3>
              <p className="text-sm text-muted-foreground">
                Add and manage bank account to receive funds
              </p>
            </div>

            {canCreate ? (
              <div>
                <CtaButton />
              </div>
            ) : null}
          </div>

          <BankAccountsTable
            accounts={data.bankAccounts}
            canDelete={canDelete}
          />
        </div>
      )}
    </Fragment>
  );
};

export default ApiSettingsPage;
