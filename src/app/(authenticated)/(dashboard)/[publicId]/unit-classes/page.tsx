import { RiStackLine } from "@remixicon/react";
import type { Metadata } from "next";
import EmptyState from "@/components/common/empty-state";
import { UnitClassCard } from "@/components/llc/unit-class/unit-class-card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { UnAuthorizedState } from "@/components/ui/un-authorized-state";
import { serverAccessControl } from "@/lib/rbac/access-control";
import { requireLlc } from "@/server/entity";
import { api } from "@/trpc/server";

export const metadata: Metadata = {
  title: "Unit classes",
};

export default async function UnitClassesPage() {
  await requireLlc();
  const { allow } = await serverAccessControl();
  const data = await allow(api.unitClass.list(), ["unit-classes", "read"]);

  if (!data) {
    return <UnAuthorizedState />;
  }

  const { classes, residualSplitTotalBps } = data;

  if (classes.length === 0) {
    return (
      <EmptyState
        icon={<RiStackLine />}
        title="No unit classes."
        subtitle="Switch the company to LLC in Settings."
      />
    );
  }

  const preferred = classes.find((c) => c.kind === "PREFERRED");
  const banners: string[] = [];
  if (preferred && preferred.finalClosingDate === null) {
    banners.push(
      "Final Closing Date is not set. Commitments cannot be accepted until it is.",
    );
  }
  if (preferred && preferred.balanceOutsideDate === null) {
    banners.push(
      "Balance outside date is not set. Balance payments cannot be recorded until it is.",
    );
  }
  if (residualSplitTotalBps !== 10000) {
    banners.push(
      `Residual splits add up to ${(residualSplitTotalBps / 100).toFixed(2)}%, expected 100%.`,
    );
  }

  return (
    <div className="flex flex-col gap-y-3">
      <div className="gap-y-3">
        <h3 className="font-medium">Unit classes</h3>
        <p className="text-sm text-muted-foreground">
          Classes of units and their offering terms
        </p>
      </div>

      {banners.map((text) => (
        <Alert key={text}>
          <AlertDescription>{text}</AlertDescription>
        </Alert>
      ))}

      <div className="flex flex-col gap-4">
        {classes.map((c) => (
          <UnitClassCard key={c.id} unitClass={c} />
        ))}
      </div>
    </div>
  );
}
