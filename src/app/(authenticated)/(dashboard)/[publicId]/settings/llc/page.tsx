import type { Metadata } from "next";
import { EntitySettings } from "@/components/llc/settings/entity-settings";
import { UnAuthorizedState } from "@/components/ui/un-authorized-state";
import { serverAccessControl } from "@/lib/rbac/access-control";
import { api } from "@/trpc/server";

export const metadata: Metadata = {
  title: "Entity and LLC terms",
};

const LlcSettingsPage = async () => {
  const { allow } = await serverAccessControl();
  const data = await allow(api.company.getCompany(), ["company", "update"]);

  if (!data?.company) {
    return <UnAuthorizedState />;
  }

  const { entityType, timezone } = data.company;

  return (
    <div className="space-y-8">
      <EntitySettings entityType={entityType} timezone={timezone} />
      {entityType === "LLC" ? (
        <>{/* ECONOMICS: LlcTerm form goes here */}</>
      ) : null}
    </div>
  );
};

export default LlcSettingsPage;
