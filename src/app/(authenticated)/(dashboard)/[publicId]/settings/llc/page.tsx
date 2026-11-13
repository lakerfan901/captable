import type { Metadata } from "next";
import Link from "next/link";
import { EntitySettings } from "@/components/llc/settings/entity-settings";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">
              Term clock and agreement parameters
            </CardTitle>
            <CardDescription>
              Operations Commencement Date, Target Sale Date, agreement
              parameters and interpretation switches.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild variant="outline">
              <Link href={`/${data.company.publicId}/settings/llc-term`}>
                Open term clock and parameters
              </Link>
            </Button>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
};

export default LlcSettingsPage;
