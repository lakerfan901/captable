"use client";

import { Fragment, useState } from "react";
import { IsoDateText, Money, Units } from "@/components/llc/money";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  microUnitsFromDecimal,
  microUnitsToDecimalString,
} from "@/lib/llc/money";
import { pctString } from "@/lib/llc/units";
import type { RouterOutputs } from "@/trpc/shared";

export type Computation = RouterOutputs["distribution"]["compute"];
export type ComputedLineWire = Computation["lines"][number];
export type StoredLine = RouterOutputs["distribution"]["get"]["lines"][number];

export interface OffsetRow {
  memberDefaultId: string;
  toBalance: number;
  toInterest: number;
  toCosts: number;
}

/** One line in a single shape for both a draft computation and a stored distribution (cents as numbers, units as 6-dp strings). */
export interface LineRow {
  key: string;
  name: string;
  preferredUnits: string;
  commonUnits: string;
  unpaidReturnBefore: number;
  unreturnedBefore: number;
  tierC: number;
  tierD: number;
  tierEPreferred: number;
  tierECommon: number;
  gross: number;
  defaultOffset: number;
  offsets: OffsetRow[] | null;
  taxAdvanceOffset: number;
  net: number;
  unpaidReturnAfter: number;
  unreturnedAfter: number;
  /** undefined: not applicable (draft); null: not marked paid */
  paidOn?: string | null;
}

export function rowsFromComputation(lines: ComputedLineWire[]): LineRow[] {
  return lines.map((l) => ({
    key: l.stakeholderId,
    name: l.name,
    preferredUnits: l.preferredUnits,
    commonUnits: l.commonUnits,
    unpaidReturnBefore: l.unpaidReturnBefore,
    unreturnedBefore: l.unreturnedBefore,
    tierC: l.tierC,
    tierD: l.tierD,
    tierEPreferred: l.tierEPreferred,
    tierECommon: l.tierECommon,
    gross: l.gross,
    defaultOffset:
      l.defaultOffsetBalance + l.defaultOffsetInterest + l.defaultOffsetCosts,
    offsets: l.offsets.map((o) => ({
      memberDefaultId: o.memberDefaultId,
      toBalance: o.toBalance,
      toInterest: o.toInterest,
      toCosts: o.toCosts,
    })),
    taxAdvanceOffset: l.taxAdvanceOffset,
    net: l.net,
    unpaidReturnAfter: l.unpaidReturnAfter,
    unreturnedAfter: l.unreturnedAfter,
  }));
}

function micro(s: string): bigint {
  try {
    return microUnitsFromDecimal(s);
  } catch {
    return 0n;
  }
}

function sum(rows: LineRow[], pick: (r: LineRow) => number): number {
  return rows.reduce((s, r) => s + pick(r), 0);
}

export function LinesTable({ rows }: { rows: LineRow[] }) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const totalPreferred = rows.reduce((s, r) => s + micro(r.preferredUnits), 0n);
  const showPaid = rows.some((r) => r.paidOn !== undefined);
  const showCommon = rows.some((r) => micro(r.commonUnits) !== 0n);
  const num = "text-right tabular-nums whitespace-nowrap";

  return (
    <div className="overflow-x-auto rounded-md border">
      <Table className="text-xs">
        <TableHeader>
          <TableRow>
            <TableHead>Member</TableHead>
            <TableHead className={num}>Preferred Units</TableHead>
            {showCommon ? (
              <TableHead className={num}>Common Units</TableHead>
            ) : null}
            <TableHead className={num}>% of Preferred</TableHead>
            <TableHead className={num}>Unpaid return before</TableHead>
            <TableHead className={num}>Unreturned before</TableHead>
            <TableHead className={num}>(c) Preferred Return</TableHead>
            <TableHead className={num}>(d) Return of capital</TableHead>
            <TableHead className={num}>(e) Residual</TableHead>
            <TableHead className={num}>Gross</TableHead>
            <TableHead className={num}>Default offset</TableHead>
            <TableHead className={num}>Tax advance</TableHead>
            <TableHead className={num}>Net</TableHead>
            <TableHead className={num}>Unpaid return after</TableHead>
            <TableHead className={num}>Unreturned after</TableHead>
            {showPaid ? <TableHead>Payment</TableHead> : null}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => {
            const expandable =
              r.defaultOffset > 0 && r.offsets !== null && r.offsets.length > 0;
            const isOpen = open[r.key] === true;
            return (
              <Fragment key={r.key}>
                <TableRow>
                  <TableCell className="whitespace-nowrap font-medium">
                    {r.name}
                  </TableCell>
                  <TableCell className={num}>
                    <Units micro={r.preferredUnits} />
                  </TableCell>
                  {showCommon ? (
                    <TableCell className={num}>
                      <Units micro={r.commonUnits} />
                    </TableCell>
                  ) : null}
                  <TableCell className={num}>
                    {pctString(micro(r.preferredUnits), totalPreferred)}%
                  </TableCell>
                  <TableCell className={num}>
                    <Money cents={r.unpaidReturnBefore} />
                  </TableCell>
                  <TableCell className={num}>
                    <Money cents={r.unreturnedBefore} />
                  </TableCell>
                  <TableCell className={num}>
                    <Money cents={r.tierC} />
                  </TableCell>
                  <TableCell className={num}>
                    <Money cents={r.tierD} />
                  </TableCell>
                  <TableCell className={num}>
                    <Money cents={r.tierEPreferred + r.tierECommon} />
                  </TableCell>
                  <TableCell className={num}>
                    <Money cents={r.gross} />
                  </TableCell>
                  <TableCell className={num}>
                    {expandable ? (
                      <button
                        type="button"
                        className="underline"
                        aria-expanded={isOpen}
                        onClick={() =>
                          setOpen((p) => ({ ...p, [r.key]: !isOpen }))
                        }
                      >
                        <Money cents={r.defaultOffset} />
                      </button>
                    ) : (
                      <Money cents={r.defaultOffset} />
                    )}
                  </TableCell>
                  <TableCell className={num}>
                    <Money cents={r.taxAdvanceOffset} />
                  </TableCell>
                  <TableCell className={`${num} font-semibold`}>
                    <Money cents={r.net} />
                  </TableCell>
                  <TableCell className={num}>
                    <Money cents={r.unpaidReturnAfter} />
                  </TableCell>
                  <TableCell className={num}>
                    <Money cents={r.unreturnedAfter} />
                  </TableCell>
                  {showPaid ? (
                    <TableCell className="whitespace-nowrap">
                      {r.net <= 0 ? (
                        "—"
                      ) : r.paidOn ? (
                        <>
                          Paid <IsoDateText date={r.paidOn} />
                        </>
                      ) : (
                        "Not marked paid"
                      )}
                    </TableCell>
                  ) : null}
                </TableRow>
                {expandable && isOpen
                  ? r.offsets?.map((o) => (
                      <TableRow
                        key={`${r.key}-${o.memberDefaultId}`}
                        className="bg-muted/40"
                      >
                        <TableCell colSpan={showCommon ? 10 : 9}>
                          Applied to default {o.memberDefaultId.slice(-6)}{" "}
                          (Section 4.9(iii)): unpaid Balance{" "}
                          <Money cents={o.toBalance} />, interest{" "}
                          <Money cents={o.toInterest} />, costs{" "}
                          <Money cents={o.toCosts} />
                        </TableCell>
                        <TableCell className={num}>
                          <Money
                            cents={o.toBalance + o.toInterest + o.toCosts}
                          />
                        </TableCell>
                        <TableCell colSpan={showPaid ? 5 : 4} />
                      </TableRow>
                    ))
                  : null}
              </Fragment>
            );
          })}
          <TableRow className="font-semibold">
            <TableCell>Total</TableCell>
            <TableCell className={num}>
              <Units micro={microUnitsToDecimalString(totalPreferred)} />
            </TableCell>
            {showCommon ? <TableCell /> : null}
            <TableCell className={num}>
              {totalPreferred === 0n ? "0.0000" : "100.0000"}%
            </TableCell>
            <TableCell className={num}>
              <Money cents={sum(rows, (r) => r.unpaidReturnBefore)} />
            </TableCell>
            <TableCell className={num}>
              <Money cents={sum(rows, (r) => r.unreturnedBefore)} />
            </TableCell>
            <TableCell className={num}>
              <Money cents={sum(rows, (r) => r.tierC)} />
            </TableCell>
            <TableCell className={num}>
              <Money cents={sum(rows, (r) => r.tierD)} />
            </TableCell>
            <TableCell className={num}>
              <Money
                cents={sum(rows, (r) => r.tierEPreferred + r.tierECommon)}
              />
            </TableCell>
            <TableCell className={num}>
              <Money cents={sum(rows, (r) => r.gross)} />
            </TableCell>
            <TableCell className={num}>
              <Money cents={sum(rows, (r) => r.defaultOffset)} />
            </TableCell>
            <TableCell className={num}>
              <Money cents={sum(rows, (r) => r.taxAdvanceOffset)} />
            </TableCell>
            <TableCell className={num}>
              <Money cents={sum(rows, (r) => r.net)} />
            </TableCell>
            <TableCell className={num}>
              <Money cents={sum(rows, (r) => r.unpaidReturnAfter)} />
            </TableCell>
            <TableCell className={num}>
              <Money cents={sum(rows, (r) => r.unreturnedAfter)} />
            </TableCell>
            {showPaid ? <TableCell /> : null}
          </TableRow>
        </TableBody>
      </Table>
    </div>
  );
}
