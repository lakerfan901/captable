import type { Metadata } from "next";
import Link from "next/link";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { UnAuthorizedState } from "@/components/ui/un-authorized-state";
import { serverAccessControl } from "@/lib/rbac/access-control";
import { requireLlc } from "@/server/entity";
import { api } from "@/trpc/server";
import { DefaultTable } from "./components/default-table";
import { OverdueTable } from "./components/overdue-table";

export const metadata: Metadata = { title: "Defaults" };

export default async function DefaultsPage() {
  const entity = await requireLlc();
  const { allow } = await serverAccessControl();
  const overdue = await allow(api.memberDefault.overdue(), [
    "capital-calls",
    "read",
  ]);
  if (!overdue) return <UnAuthorizedState />;
  const list = await api.memberDefault.list();
  const canCreate = allow(true, ["capital-calls", "create"], false);
  const base = `/${entity.publicId}/capital-calls`;

  return (
    <div className="flex flex-col gap-y-4">
      <div>
        <Link href={base} className="text-sm text-muted-foreground">
          ← Capital calls
        </Link>
        <h3 className="font-medium">Defaults</h3>
        <p className="max-w-2xl text-sm text-muted-foreground">
          Section 4.9. Nothing on this page happens automatically: each default,
          forfeiture, credit and cure is a Manager decision on the figures
          shown.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Overdue, not declared</CardTitle>
          <CardDescription>
            Lines sent and not paid in full by their due date, with no default
            declared.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <OverdueTable lines={overdue.lines} canDeclare={canCreate} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Defaults</CardTitle>
        </CardHeader>
        <CardContent>
          <DefaultTable defaults={list.defaults} base={`${base}/defaults`} />
        </CardContent>
      </Card>
    </div>
  );
}
