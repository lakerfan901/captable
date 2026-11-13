import { Money, Units } from "@/components/llc/money";
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { RouterOutputs } from "@/trpc/shared";

export type FairValueOutput = RouterOutputs["llcEconomics"]["fairValue"];

/** Per-member result of the hypothetical liquidation (R43). No hooks. */
export function FairValueTable({ data }: { data: FairValueOutput }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Member</TableHead>
          <TableHead className="text-right">Preferred Units</TableHead>
          <TableHead className="text-right">Common Units</TableHead>
          <TableHead className="text-right">Tier (c)</TableHead>
          <TableHead className="text-right">Tier (d)</TableHead>
          <TableHead className="text-right">Tier (e)</TableHead>
          <TableHead className="text-right">Total</TableHead>
          <TableHead className="text-right">Per Preferred Unit</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {data.lines.length === 0 ? (
          <TableRow>
            <TableCell colSpan={8} className="text-muted-foreground">
              No members hold Units on this date.
            </TableCell>
          </TableRow>
        ) : (
          data.lines.map((l) => (
            <TableRow key={l.holderId}>
              <TableCell>{l.name}</TableCell>
              <TableCell className="text-right">
                <Units micro={l.preferredUnits} />
              </TableCell>
              <TableCell className="text-right">
                <Units micro={l.commonUnits} />
              </TableCell>
              <TableCell className="text-right">
                <Money cents={l.tierC} />
              </TableCell>
              <TableCell className="text-right">
                <Money cents={l.tierD} />
              </TableCell>
              <TableCell className="text-right">
                <Money cents={l.tierEPreferred + l.tierECommon} />
              </TableCell>
              <TableCell className="text-right font-medium">
                <Money cents={l.gross} />
              </TableCell>
              <TableCell className="text-right">
                <Money cents={l.perPreferredUnit} />
              </TableCell>
            </TableRow>
          ))
        )}
      </TableBody>
      <TableFooter>
        <TableRow>
          <TableCell colSpan={3}>Net to Members</TableCell>
          <TableCell className="text-right">
            <Money cents={data.tiers.tierC} />
          </TableCell>
          <TableCell className="text-right">
            <Money cents={data.tiers.tierD} />
          </TableCell>
          <TableCell className="text-right">
            <Money cents={data.tiers.tierEPreferred + data.tiers.tierECommon} />
          </TableCell>
          <TableCell className="text-right">
            <Money cents={data.netToMembers} />
          </TableCell>
          <TableCell />
        </TableRow>
      </TableFooter>
    </Table>
  );
}
