import Link from "next/link";
import { Card } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { ResolutionType } from "@/lib/governance/presets";
import { formatVoteBps } from "@/lib/llc/voting";
import type { RouterOutputs } from "@/trpc/shared";
import { StatusBadge } from "./status-badge";

// Resolution list table (03-governance.md G10). Server-safe (no hooks).

export type ResolutionRow = RouterOutputs["resolution"]["list"][number];

export const RESOLUTION_TYPE_LABEL: Record<ResolutionType, string> = {
  GENERAL_CONSENT: "General member consent",
  RELATED_PARTY: "Related-party transaction",
  PURCHASE_ORDER: "Purchase-order resolution",
  TERM_EXTENSION: "Term extension election",
  SUCCESSOR_MANAGER: "Successor Manager",
  AMENDMENT: "Amendment",
  AUDIT_CALL: "Call for review or audit",
  MEMBER_LOAN: "Member loan",
};

// Threshold (percent) of each unit-vote label produced by the router's
// `requirementLabel`. Majorities are "more than", the others "at least".
const THRESHOLD_BY_LABEL: Record<string, number> = {
  "Preferred Majority": 50,
  "Preferred Supermajority": 70,
  "Majority of the Disinterested Preferred Units": 50,
  "67% of the Disinterested Preferred Units": 67,
  "70% of the Disinterested Preferred Units": 70,
};

/** "35.5% of 70%" for the first unit vote; "Manager only" when there is none. */
export function progressText(
  summaries: ResolutionRow["requirementSummaries"],
): string {
  const vote = summaries.find((s) => s.label in THRESHOLD_BY_LABEL);
  if (!vote) {
    return summaries.length > 0 ? "Manager only" : "—";
  }
  // Truncated like every vote share (formatVoteBps): never rounded up.
  const pct = formatVoteBps(vote.forBps);
  return `${pct}% of ${THRESHOLD_BY_LABEL[vote.label]}%`;
}

/** An instant shown as a calendar date in the company time zone. */
export function formatInstantDate(
  at: Date | string | null,
  timeZone: string,
): string {
  if (at === null) return "—";
  const d = typeof at === "string" ? new Date(at) : at;
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    dateStyle: "medium",
  }).format(d);
}

export function ResolutionTable({
  rows,
  base,
  timeZone,
}: {
  rows: ResolutionRow[];
  /** `/<companyPublicId>/resolutions` */
  base: string;
  timeZone: string;
}) {
  return (
    <Card>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Reference</TableHead>
            <TableHead>Title</TableHead>
            <TableHead>Type</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Progress</TableHead>
            <TableHead>Respond by</TableHead>
            <TableHead>Effective</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={r.publicId}>
              <TableCell className="whitespace-nowrap font-mono text-xs">
                {r.referenceCode ?? "—"}
              </TableCell>
              <TableCell className="font-medium">
                <Link className="underline" href={`${base}/${r.publicId}`}>
                  {r.title}
                </Link>
              </TableCell>
              <TableCell>
                {RESOLUTION_TYPE_LABEL[r.type as ResolutionType] ?? r.type}
              </TableCell>
              <TableCell>
                <StatusBadge status={r.status} />
              </TableCell>
              <TableCell className="tabular-nums">
                {progressText(r.requirementSummaries)}
              </TableCell>
              <TableCell className="whitespace-nowrap">
                {formatInstantDate(r.closesAt, timeZone)}
              </TableCell>
              <TableCell className="whitespace-nowrap">
                {formatInstantDate(r.effectiveAt, timeZone)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Card>
  );
}
