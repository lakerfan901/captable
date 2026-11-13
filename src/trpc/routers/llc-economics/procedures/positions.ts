import { z } from "zod";
import type { Cents, MicroUnits } from "@/lib/llc/money";
import { pctString } from "@/lib/llc/units";
import { economicsToday } from "@/server/llc/economics/clock";
import { getPositions } from "@/server/llc/economics/ledger";
import { getSuspendedUnits } from "@/server/llc/economics/suspension";
import { toWire } from "@/server/llc/economics/wire";
import { withLlcAccessControl } from "@/trpc/api/trpc";
import { zIsoDate } from "@/trpc/routers/llc-shared/schema";

const ZPositionsInput = z.object({ asOf: zIsoDate.optional() });

export const positionsProcedures = {
  positions: withLlcAccessControl
    .meta({ policies: { distributions: { allow: ["read"] } } })
    .input(ZPositionsInput)
    .query(async ({ ctx, input }) => {
      const companyId = ctx.membership.companyId;
      const asOf = input.asOf ?? economicsToday(ctx.company.timezone);
      const { ledger, positions } = await getPositions(ctx.db, companyId, asOf);
      const { suspended } = await getSuspendedUnits(ctx.db, companyId, asOf);
      const suspendedIds = new Set(suspended.map((s) => s.stakeholderId));

      const ids = new Set<string>(positions.holders.keys());
      for (const [id, units] of ledger.commonUnits) {
        if (units !== 0n) ids.add(id);
      }
      const totalPreferred = positions.totals.preferredUnits;
      const rows = [...ids].map((stakeholderId) => {
        const p = positions.holders.get(stakeholderId);
        const holder = ledger.holders.get(stakeholderId);
        const preferredUnits: MicroUnits = p?.preferredUnits ?? 0n;
        return {
          stakeholderId,
          name: holder?.name ?? stakeholderId,
          isInsider: holder?.isInsider ?? false,
          contributed: p?.contributed ?? 0n,
          unreturned: p?.unreturned ?? 0n,
          capitalReturned: p?.capitalReturned ?? 0n,
          forfeited: p?.forfeited ?? 0n,
          preferredUnits,
          commonUnits: ledger.commonUnits.get(stakeholderId) ?? 0n,
          preferredPct: pctString(preferredUnits, totalPreferred),
          accruedReturn: p?.accruedReturn ?? 0n,
          returnPaid: p?.returnPaid ?? 0n,
          unpaidReturn: p?.unpaidReturn ?? 0n,
          suspended: suspendedIds.has(stakeholderId),
        };
      });
      rows.sort((a, b) =>
        a.name === b.name
          ? a.stakeholderId < b.stakeholderId
            ? -1
            : 1
          : a.name < b.name
            ? -1
            : 1,
      );

      const sum = (pick: (r: (typeof rows)[number]) => bigint): bigint =>
        rows.reduce((s, r) => s + pick(r), 0n);
      const totals: {
        contributed: Cents;
        unreturned: Cents;
        capitalReturned: Cents;
        forfeited: Cents;
        preferredUnits: MicroUnits;
        commonUnits: MicroUnits;
        accruedReturn: Cents;
        returnPaid: Cents;
        unpaidReturn: Cents;
      } = {
        contributed: sum((r) => r.contributed),
        unreturned: sum((r) => r.unreturned),
        capitalReturned: sum((r) => r.capitalReturned),
        forfeited: sum((r) => r.forfeited),
        preferredUnits: sum((r) => r.preferredUnits),
        commonUnits: sum((r) => r.commonUnits),
        accruedReturn: sum((r) => r.accruedReturn),
        returnPaid: sum((r) => r.returnPaid),
        unpaidReturn: sum((r) => r.unpaidReturn),
      };

      return toWire({ asOf, rows, totals });
    }),
};
