import type { Metadata } from "next";
import { UnAuthorizedState } from "@/components/ui/un-authorized-state";
import { serverAccessControl } from "@/lib/rbac/access-control";
import { requireLlc } from "@/server/entity";
import { economicsToday } from "@/server/llc/economics/clock";
import { FairValueForm } from "./components/fair-value-form";

export const metadata: Metadata = { title: "Fair value" };

export default async function FairValuePage(props: {
  searchParams: Promise<{ stakeholderId?: string | string[] }>;
}) {
  const entity = await requireLlc();
  const { allow } = await serverAccessControl();
  if (!allow(true, ["distributions", "read"], false)) {
    return <UnAuthorizedState />;
  }
  const { stakeholderId } = await props.searchParams;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h3 className="font-medium">Fair value of Units</h3>
        <p className="max-w-3xl text-sm text-muted-foreground">
          Section 7.1(ii) of the Operating Agreement: &ldquo;the fair value of
          the Units, meaning the amount the transferring Member would receive
          under Section 5.6 if the LLC&apos;s assets were sold at their fair
          market value&rdquo;. The calculator subtracts liabilities to creditors
          and, optionally, member loans from the assets and cash, and runs the
          Section 5.6 waterfall on the Members&apos; positions as of the
          valuation date. Nothing is saved.
        </p>
      </div>
      <FairValueForm
        today={economicsToday(entity.timezone)}
        initialStakeholderId={
          typeof stakeholderId === "string" && stakeholderId !== ""
            ? stakeholderId
            : null
        }
      />
    </div>
  );
}
