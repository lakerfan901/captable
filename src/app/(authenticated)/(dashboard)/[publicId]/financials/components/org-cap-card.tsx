import { IsoDateText, Money } from "@/components/llc/money";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { RouterOutputs } from "@/trpc/shared";

export type OrgCapStatus =
  RouterOutputs["llcFinancials"]["managerPayment"]["capStatus"];

/** §6.21 cap bar: counted vs. limit, with the counted entries when `showEntries`. */
export function OrgCapCard({
  status,
  showEntries = false,
}: {
  status: Omit<OrgCapStatus, "entries"> & {
    entries?: OrgCapStatus["entries"];
  };
  showEntries?: boolean;
}) {
  const pct =
    status.limit > 0
      ? Math.min(100, Math.max(0, (status.counted / status.limit) * 100))
      : 0;
  const over = status.counted > status.limit;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">
          Organizational and offering expense cap (Section 6.21)
        </CardTitle>
        <CardDescription>
          Organizational, offering, formation, legal and filing expenses the LLC
          bears, directly or by reimbursement. Above the cap needs a Preferred
          Supermajority.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-2 text-sm">
        <div className="h-3 w-full overflow-hidden rounded bg-gray-100">
          <div
            className={over ? "h-3 bg-red-500" : "h-3 bg-primary"}
            style={{ width: `${pct}%` }}
          />
        </div>
        <div className="flex flex-wrap justify-between gap-2">
          <span>
            Counted <Money cents={status.counted} /> of{" "}
            <Money cents={status.limit} />
          </span>
          <span className={over ? "text-destructive" : ""}>
            Remaining <Money cents={status.remaining} />
          </span>
        </div>
        {showEntries && status.entries && status.entries.length > 0 ? (
          <ul className="mt-2 divide-y text-xs">
            {status.entries.map((e) => (
              <li key={`${e.source}-${e.id}`} className="flex gap-2 py-1">
                <IsoDateText date={e.on} className="w-24 shrink-0" />
                <span className="flex-1">
                  {e.payee} ({e.category})
                  {e.resolutionId ? " — with resolution" : ""}
                </span>
                <Money cents={e.amount} />
              </li>
            ))}
          </ul>
        ) : null}
      </CardContent>
    </Card>
  );
}
