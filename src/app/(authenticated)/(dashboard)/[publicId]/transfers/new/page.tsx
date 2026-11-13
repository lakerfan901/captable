import type { Metadata } from "next";
import Link from "next/link";
import {
  TransferForm,
  type TransferFormClass,
  type TransferFormHoldings,
} from "@/components/governance/transfer-form";
import { UnAuthorizedState } from "@/components/ui/un-authorized-state";
import { GOVERNANCE_TIME_ZONE, todayInZone } from "@/lib/governance/dates";
import { toMicro } from "@/lib/llc/voting";
import { serverAccessControl } from "@/lib/rbac/access-control";
import { requireLlc } from "@/server/entity";
import { api } from "@/trpc/server";

export const metadata: Metadata = { title: "Record a transfer" };

// Record a transfer (03-governance.md G17 page 2). The selects come from the
// existing routers: Members from `stakeholder.getStakeholders`, classes from
// `unitClass.list`, and each Member's units from the Member Schedule (today,
// completed transfers folded in). The units are a hint only: the server
// checks the holding when the transfer is recorded and again on completion.

export default async function NewTransferPage() {
  const entity = await requireLlc();
  const { allow } = await serverAccessControl();
  if (!allow(true, ["governance", "create"], false)) {
    return <UnAuthorizedState />;
  }

  // The form needs the Members and the unit classes.
  if (
    !allow(true, ["stakeholder", "read"], false) ||
    !allow(true, ["unit-classes", "read"], false)
  ) {
    return <UnAuthorizedState />;
  }
  const [stakeholders, unitClasses, schedule] = await Promise.all([
    api.stakeholder.getStakeholders(),
    api.unitClass.list(),
    api.memberSchedule.get({}),
  ]);

  const members = stakeholders
    .map((s) => ({ id: s.id, name: s.name, memberStatus: s.memberStatus }))
    .sort((a, b) => a.name.localeCompare(b.name, "en"));
  const classes: TransferFormClass[] = unitClasses.classes.map((c) => ({
    id: c.id,
    name: c.name,
    kind: c.kind,
  }));

  // The schedule has one table per class kind; its rows carry no class id,
  // so a holding is attributed only when exactly one class has that kind.
  const holdings: TransferFormHoldings = {};
  const tables = [
    { kind: "PREFERRED" as const, rows: schedule.preferred.rows },
    { kind: "COMMON" as const, rows: schedule.common.rows },
  ];
  for (const { kind, rows } of tables) {
    const ofKind = classes.filter((c) => c.kind === kind);
    const only = ofKind.length === 1 ? ofKind[0] : undefined;
    if (!only) continue;
    for (const r of rows) {
      if (toMicro(r.units) <= 0n) continue;
      const byClass = holdings[r.stakeholderId] ?? {};
      byClass[only.id] = r.units;
      holdings[r.stakeholderId] = byClass;
    }
  }

  const base = `/${entity.publicId}/transfers`;
  return (
    <div className="flex flex-col gap-y-4">
      <div className="flex flex-col gap-2">
        <Link href={base} className="text-sm text-muted-foreground">
          ← Transfers
        </Link>
        <div>
          <h3 className="font-medium">Record a transfer</h3>
          <p className="max-w-2xl text-sm text-muted-foreground">
            Record the transfer when the Manager receives the Transfer Notice
            (or notice of the transfer). Consents, the right of first refusal
            and the admission checklist are completed on the transfer's page.
          </p>
        </div>
      </div>
      <TransferForm
        base={base}
        members={members}
        classes={classes}
        holdings={Object.keys(holdings).length > 0 ? holdings : null}
        today={todayInZone(new Date(), entity.timezone || GOVERNANCE_TIME_ZONE)}
      />
    </div>
  );
}
