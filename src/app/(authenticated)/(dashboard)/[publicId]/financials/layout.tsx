import { TRPCError } from "@trpc/server";
import Link from "next/link";
import { PageLayout } from "@/components/dashboard/page-layout";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card } from "@/components/ui/card";
import { serverAccessControl } from "@/lib/rbac/access-control";
import { requireLlc } from "@/server/entity";
import { api } from "@/trpc/server";
import { FinancialsTabs } from "./components/shared";

/**
 * Tab bar for the financials section. Also surfaces the rule violation every
 * financials write (and the summary) fails with until the Preferred unit
 * class has a price per unit.
 */
export default async function FinancialsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const entity = await requireLlc();
  const { allow } = await serverAccessControl();
  let blocker: string | null = null;
  if (allow(true, ["llc-financials", "read"], false)) {
    try {
      await api.llcFinancials.summary({});
    } catch (e) {
      if (e instanceof TRPCError && e.code === "BAD_REQUEST") {
        blocker = e.message;
      } else {
        throw e;
      }
    }
  }

  return (
    <PageLayout
      title="Financials"
      description="Revenue, expenses, Manager payments, reserves, member loans and tax advances behind Available Cash."
    >
      <FinancialsTabs publicId={entity.publicId} />
      {blocker ? (
        <Alert variant="destructive">
          <AlertDescription>
            Financial figures cannot be computed and no entry can be saved until
            this is fixed: {blocker}{" "}
            {blocker.includes("price per unit") ? (
              <Link
                className="underline"
                href={`/${entity.publicId}/unit-classes`}
              >
                Open unit classes
              </Link>
            ) : null}
          </AlertDescription>
        </Alert>
      ) : null}
      <Card className="p-5">{children}</Card>
    </PageLayout>
  );
}
