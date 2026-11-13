import { RiHandCoinLine } from "@remixicon/react";
import type { Metadata } from "next";
import Link from "next/link";
import EmptyState from "@/components/common/empty-state";
import { IsoDateText } from "@/components/llc/money";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { UnAuthorizedState } from "@/components/ui/un-authorized-state";
import { formatDateOnly } from "@/lib/date-only";
import { serverAccessControl } from "@/lib/rbac/access-control";
import { requireLlc } from "@/server/entity";
import { api } from "@/trpc/server";
import { DistributionTable } from "./components/distribution-table";

export const metadata: Metadata = { title: "Distributions" };

export default async function DistributionsPage() {
  const entity = await requireLlc();
  const { allow } = await serverAccessControl();
  const list = await allow(api.distribution.list(), ["distributions", "read"]);
  if (!list) return <UnAuthorizedState />;
  const canCreate = allow(true, ["distributions", "create"], false);
  const base = `/${entity.publicId}/distributions`;
  const next = list.nextDeadline;

  return (
    <div className="flex flex-col gap-y-4">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h3 className="font-medium">Distributions</h3>
          <p className="max-w-2xl text-sm text-muted-foreground">
            Available Cash is distributed quarterly under Section 5.6: accrued
            Preferred Return first, then Unreturned Capital Contributions, then
            the residual 70% to Preferred and 30% to Common Units.
          </p>
        </div>
        {canCreate ? (
          <Button asChild>
            <Link href={`${base}/new`}>New distribution</Link>
          </Button>
        ) : null}
      </div>

      <Card>
        <CardContent className="p-4 text-sm">
          <p className="font-medium">
            {next.label} distribution and report due{" "}
            {formatDateOnly(next.deadline)}
          </p>
          <p className="text-muted-foreground">
            {next.distributed ? (
              <>
                A distribution for the quarter ending{" "}
                <IsoDateText date={next.quarterEnd} /> has been finalized; the
                quarterly report is still due by the same date.
              </>
            ) : (
              <>
                For the quarter ending <IsoDateText date={next.quarterEnd} />{" "}
                (Sections 5.6(a) and 8.2).
              </>
            )}
          </p>
        </CardContent>
      </Card>

      {list.rows.length === 0 ? (
        <EmptyState
          icon={<RiHandCoinLine />}
          title="No distributions yet"
          subtitle="Create a distribution to pay Available Cash, return unused capital, or distribute sale or liquidation proceeds."
        />
      ) : (
        <DistributionTable rows={list.rows} base={base} />
      )}
    </div>
  );
}
