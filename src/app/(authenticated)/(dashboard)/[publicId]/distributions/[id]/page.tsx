import type { Metadata } from "next";
import Link from "next/link";
import { IsoDateText, Money, Units } from "@/components/llc/money";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { UnAuthorizedState } from "@/components/ui/un-authorized-state";
import { serverAccessControl } from "@/lib/rbac/access-control";
import { requireLlc } from "@/server/entity";
import { currentMailDelivery } from "@/server/mail-delivery";
import { ZDistributionInputsSchema } from "@/trpc/routers/distribution/schema";
import { api } from "@/trpc/server";
import type { AvailableCashStatement } from "../../financials/components/available-cash-card";
import { AvailableCashCard } from "../../financials/components/available-cash-card";
import { DistributionActions } from "../components/distribution-actions";
import {
  DistributionStatusBadge,
  PeriodText,
  typeLabel,
} from "../components/distribution-table";
import {
  type DistributionInputsValue,
  DistributionWizard,
  type WizardStep,
} from "../components/distribution-wizard";
import {
  type LineRow,
  LinesTable,
  type OffsetRow,
  type StoredLine,
} from "../components/lines-table";
import { ReverseDialog } from "../components/reverse-dialog";
import { TierSummary } from "../components/tier-summary";

export const metadata: Metadata = { title: "Distribution" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const STEPS: WizardStep[] = ["setup", "inputs", "review", "finalize"];

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function num(v: unknown): number {
  return typeof v === "number" ? v : 0;
}

/** The stored snapshot is JSON written by finalize; read what is there and degrade when a part is missing. */
function readSnapshot(snapshot: unknown) {
  const s = isRecord(snapshot) ? snapshot : {};
  const computation = isRecord(s.computation) ? s.computation : null;
  const lines = Array.isArray(computation?.lines) ? computation.lines : [];
  const offsets = new Map<string, OffsetRow[]>();
  let owedC: number | null = computation ? 0 : null;
  for (const l of lines) {
    if (!isRecord(l) || typeof l.stakeholderId !== "string") continue;
    if (owedC !== null) owedC += num(l.unpaidReturnMeasured);
    const apps = Array.isArray(l.offsets) ? l.offsets : [];
    offsets.set(
      l.stakeholderId,
      apps.filter(isRecord).map((o) => ({
        memberDefaultId: String(o.memberDefaultId ?? ""),
        toBalance: num(o.toBalance),
        toInterest: num(o.toInterest),
        toCosts: num(o.toCosts),
      })),
    );
  }
  const availableCash = isRecord(computation?.availableCash)
    ? (computation.availableCash as unknown as AvailableCashStatement)
    : null;
  const positions = isRecord(s.positionsBefore)
    ? Object.entries(s.positionsBefore)
        .filter((e): e is [string, Record<string, unknown>] => isRecord(e[1]))
        .map(([id, p]) => ({
          id,
          preferredUnits:
            typeof p.preferredUnits === "string" ? p.preferredUnits : null,
          contributed: num(p.contributed),
          unreturned: num(p.unreturned),
          accruedReturn: num(p.accruedReturn),
          returnPaid: num(p.returnPaid),
          unpaidReturn: num(p.unpaidReturn),
        }))
    : [];
  return {
    hasComputation: computation !== null,
    offsets: computation ? offsets : null,
    owedC,
    availableCash,
    positions,
  };
}

/** Stored lines; per-default applications come from the snapshot's computation when it has them. */
function rowsFromStored(
  lines: StoredLine[],
  offsetsByStakeholder: Map<string, OffsetRow[]> | null,
): LineRow[] {
  return lines.map((l) => ({
    key: l.id,
    name: l.name,
    preferredUnits: l.preferredUnits,
    commonUnits: l.commonUnits,
    unpaidReturnBefore: l.unpaidReturnBeforeCents,
    unreturnedBefore: l.unreturnedBeforeCents,
    tierC: l.tierCCents,
    tierD: l.tierDCents,
    tierEPreferred: l.tierEPreferredCents,
    tierECommon: l.tierECommonCents,
    gross: l.grossCents,
    defaultOffset:
      l.defaultOffsetBalanceCents +
      l.defaultOffsetInterestCents +
      l.defaultOffsetCostsCents,
    offsets: offsetsByStakeholder?.get(l.stakeholderId) ?? null,
    taxAdvanceOffset: l.taxAdvanceOffsetCents,
    net: l.netCents,
    unpaidReturnAfter: l.unpaidReturnAfterCents,
    unreturnedAfter: l.unreturnedAfterCents,
    paidOn: l.paidOn,
  }));
}

function defaultInputs(type: DistributionInputsValue["type"]) {
  if (type === "OPERATING") return { type } as const;
  if (type === "RETURN_OF_UNUSED_CAPITAL")
    return { type, amountCents: 0 } as const;
  return { type, liquidation: null } as const;
}

export default async function DistributionPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: SearchParams;
}) {
  const entity = await requireLlc();
  const { id } = await params;
  const { allow } = await serverAccessControl();
  const data = await allow(api.distribution.get({ id }), [
    "distributions",
    "read",
  ]);
  if (!data) return <UnAuthorizedState />;
  const canCreate = allow(true, ["distributions", "create"], false);
  const canUpdate = allow(true, ["distributions", "update"], false);
  const canDelete = allow(true, ["distributions", "delete"], false);
  const companyBase = `/${entity.publicId}`;
  const base = `${companyBase}/distributions`;
  const d = data.distribution;

  if (d.status === "DRAFT") {
    const sp = await searchParams;
    const requested = typeof sp.step === "string" ? sp.step : "inputs";
    const step = (STEPS as string[]).includes(requested)
      ? (requested as WizardStep)
      : "inputs";
    const parsed = ZDistributionInputsSchema.safeParse(d.inputs);
    const inputs =
      parsed.success && parsed.data.type === d.type
        ? parsed.data
        : defaultInputs(d.type);
    const list = await api.distribution.list();
    return (
      <div className="flex flex-col gap-y-4">
        <div>
          <Link href={base} className="text-sm text-muted-foreground">
            ← Distributions
          </Link>
          <h3 className="flex items-center gap-2 font-medium">
            Draft {typeLabel(d).toLowerCase()} distribution
            <DistributionStatusBadge status={d.status} isReversal={false} />
          </h3>
        </div>
        <DistributionWizard
          base={base}
          companyBase={companyBase}
          today={list.today}
          draft={{
            id: d.id,
            type: d.type,
            periodStart: d.periodStart,
            periodEnd: d.periodEnd,
            paymentDate: d.paymentDate,
            inputs,
            notes: d.notes,
          }}
          step={parsed.success ? step : "setup"}
          conflict={sp.conflict === "1"}
          canCreate={canCreate}
          canUpdate={canUpdate}
          canDelete={canDelete}
          canReadFinancials={allow(true, ["llc-financials", "read"], false)}
        />
      </div>
    );
  }

  const snap = readSnapshot(data.snapshot);
  const rows = rowsFromStored(data.lines, snap.offsets);
  const names = new Map(data.lines.map((l) => [l.stakeholderId, l.name]));
  const owedD = d.isReversal
    ? null
    : data.lines.reduce((s, l) => s + l.unreturnedBeforeCents, 0);
  const canReverse =
    canDelete &&
    d.status === "FINALIZED" &&
    !d.isReversal &&
    data.reversedBy === null &&
    d.number !== null;

  return (
    <div className="flex flex-col gap-y-4">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <Link href={base} className="text-sm text-muted-foreground">
            ← Distributions
          </Link>
          <h3 className="flex items-center gap-2 font-medium">
            Distribution No. {d.number} — {typeLabel(d)}
            <DistributionStatusBadge
              status={d.status}
              isReversal={d.isReversal}
            />
          </h3>
          <p className="text-sm text-muted-foreground">
            Period{" "}
            <PeriodText periodStart={d.periodStart} periodEnd={d.periodEnd} />,
            payment date <IsoDateText date={d.paymentDate} />. Gross{" "}
            <Money cents={d.amountCents} />, net{" "}
            <Money cents={d.totalNetCents} />
            {d.reserveBalanceCents !== null ? (
              <>
                , reserve balance <Money cents={d.reserveBalanceCents} />
              </>
            ) : null}
            .
          </p>
          {data.reverses ? (
            <p className="text-sm">
              Reverses{" "}
              <Link className="underline" href={`${base}/${data.reverses.id}`}>
                distribution No. {data.reverses.number}
              </Link>
              {d.notes ? `: ${d.notes}` : null}
            </p>
          ) : null}
          {data.reversedBy ? (
            <p className="text-sm">
              Reversed by{" "}
              <Link
                className="underline"
                href={`${base}/${data.reversedBy.id}`}
              >
                distribution No. {data.reversedBy.number}
              </Link>
              {d.reversalReason ? `: ${d.reversalReason}` : null}
            </p>
          ) : null}
        </div>
        <div className="flex flex-wrap gap-2">
          <DistributionActions
            distributionId={d.id}
            status={d.status}
            canUpdate={canUpdate}
            mailDelivery={currentMailDelivery("DISTRIBUTION_NOTICES")}
          />
          {canReverse && d.number !== null ? (
            <ReverseDialog id={d.id} number={d.number} />
          ) : null}
        </div>
      </div>

      <TierSummary
        t={{
          tierC: d.tierCCents ?? 0,
          tierD: d.tierDCents ?? 0,
          tierEPreferred: d.tierEPreferredCents ?? 0,
          tierECommon: d.tierECommonCents ?? 0,
          owedC: d.isReversal ? null : snap.owedC,
          owedD,
        }}
      />

      <LinesTable rows={rows} />

      {snap.hasComputation ? (
        <Accordion type="multiple" className="rounded-md border px-4">
          {snap.availableCash ? (
            <AccordionItem value="available-cash">
              <AccordionTrigger>
                How Available Cash was computed
              </AccordionTrigger>
              <AccordionContent>
                <AvailableCashCard
                  className="max-w-2xl"
                  availableCash={snap.availableCash}
                />
              </AccordionContent>
            </AccordionItem>
          ) : null}
          <AccordionItem value="positions">
            <AccordionTrigger>Positions before</AccordionTrigger>
            <AccordionContent>
              <div className="overflow-x-auto">
                <Table className="text-xs">
                  <TableHeader>
                    <TableRow>
                      <TableHead>Member</TableHead>
                      <TableHead className="text-right">
                        Preferred Units
                      </TableHead>
                      <TableHead className="text-right">Contributed</TableHead>
                      <TableHead className="text-right">
                        Unreturned Capital
                      </TableHead>
                      <TableHead className="text-right">
                        Preferred Return accrued
                      </TableHead>
                      <TableHead className="text-right">
                        Preferred Return paid
                      </TableHead>
                      <TableHead className="text-right">
                        Unpaid Preferred Return
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {snap.positions.map((p) => (
                      <TableRow key={p.id}>
                        <TableCell>{names.get(p.id) ?? p.id}</TableCell>
                        <TableCell className="text-right">
                          <Units micro={p.preferredUnits} />
                        </TableCell>
                        <TableCell className="text-right">
                          <Money cents={p.contributed} />
                        </TableCell>
                        <TableCell className="text-right">
                          <Money cents={p.unreturned} />
                        </TableCell>
                        <TableCell className="text-right">
                          <Money cents={p.accruedReturn} />
                        </TableCell>
                        <TableCell className="text-right">
                          <Money cents={p.returnPaid} />
                        </TableCell>
                        <TableCell className="text-right">
                          <Money cents={p.unpaidReturn} />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </AccordionContent>
          </AccordionItem>
        </Accordion>
      ) : null}
    </div>
  );
}
