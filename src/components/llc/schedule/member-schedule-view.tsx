import Link from "next/link";
import { Card } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { MemberScheduleDTO } from "@/lib/admission/member-schedule";
import { formatDateOnly } from "@/lib/date-only";
import { formatCents } from "@/lib/money";
import { trimUnits } from "@/server/llc/serialize";

const FINANCIAL_INTEREST_NOTE =
  "holds a Financial Interest only (Section 7.9.2)";

/** 4000 → "40%". */
export function bpsToPercentLabel(bps: number): string {
  return `${bps / 100}%`;
}

/** The two Exhibit A footer sentences, from the DTO only. */
export function scheduleFooterLines(schedule: MemberScheduleDTO): {
  manager: string;
  terms: string;
} {
  const manager = `Manager (for notices): ${
    schedule.managerNotice.length === 0
      ? "Not set"
      : schedule.managerNotice
          .map((m) =>
            [m.name, m.address, m.email].filter((p) => p !== "").join(", "),
          )
          .join("; ")
  }`;
  const price = schedule.indicators.pricePerUnitCents;
  const installment = `Initial Installment under Section 4.9: ${bpsToPercentLabel(
    schedule.indicators.initialInstallmentBps,
  )}.`;
  const terms =
    price === null
      ? installment
      : `One Preferred Unit for each ${formatCents(price)} of Capital Contribution actually paid. ${installment}`;
  return { manager, terms };
}

export function MemberScheduleView({
  schedule,
  publicId,
}: {
  schedule: MemberScheduleDTO;
  publicId: string;
}) {
  const memberHref = (id: string) => `/${publicId}/stakeholders/${id}`;
  const hasFio = schedule.preferred.rows.some(
    (r) => r.memberStatus === "FINANCIAL_INTEREST_ONLY",
  );
  const footer = scheduleFooterLines(schedule);
  const t = schedule.preferred.totals;

  return (
    <div className="flex flex-col gap-y-4">
      <Card className="p-0">
        <div className="px-4 pt-4">
          <h4 className="font-medium">
            {schedule.common.className || "Common Units"}
          </h4>
        </div>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Common Member</TableHead>
              <TableHead className="text-right">Capital Contribution</TableHead>
              <TableHead className="text-right">Common Units</TableHead>
              <TableHead className="text-right">
                Common Unit Percentage Interest
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {schedule.common.rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={4} className="text-muted-foreground">
                  No Common Members.
                </TableCell>
              </TableRow>
            ) : (
              schedule.common.rows.map((r) => (
                <TableRow key={r.stakeholderId}>
                  <TableCell>
                    <Link
                      href={memberHref(r.stakeholderId)}
                      className="hover:underline"
                    >
                      {r.name}
                    </Link>
                  </TableCell>
                  <TableCell className="text-right">
                    {formatCents(r.capitalContributionCents)}
                  </TableCell>
                  <TableCell className="text-right">
                    {trimUnits(r.units)}
                  </TableCell>
                  <TableCell className="text-right">{r.percent}%</TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </Card>

      <Card className="p-0">
        <div className="px-4 pt-4">
          <h4 className="font-medium">
            {schedule.preferred.className || "Preferred Units"}
          </h4>
        </div>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Preferred Members</TableHead>
              <TableHead className="text-right">
                Capital Contribution Committed
              </TableHead>
              <TableHead className="text-right">Paid to Date</TableHead>
              <TableHead className="text-right">Preferred Units</TableHead>
              <TableHead className="text-right">
                Preferred Unit Percentage Interest
              </TableHead>
              <TableHead>Date Admitted</TableHead>
              <TableHead>Notice Address and Email</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {schedule.preferred.rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="text-muted-foreground">
                  No Preferred Members.
                </TableCell>
              </TableRow>
            ) : (
              schedule.preferred.rows.map((r) => (
                <TableRow key={r.stakeholderId}>
                  <TableCell>
                    <Link
                      href={memberHref(r.stakeholderId)}
                      className="hover:underline"
                    >
                      {r.name}
                    </Link>
                    {r.memberStatus === "FINANCIAL_INTEREST_ONLY" ? (
                      <sup title={FINANCIAL_INTEREST_NOTE}>*</sup>
                    ) : null}
                  </TableCell>
                  <TableCell className="text-right">
                    {formatCents(r.committedCents)}
                  </TableCell>
                  <TableCell className="text-right">
                    {formatCents(r.paidCents)}
                  </TableCell>
                  <TableCell className="text-right">
                    {trimUnits(r.units)}
                  </TableCell>
                  <TableCell className="text-right">{r.percent}%</TableCell>
                  <TableCell>
                    {r.admittedOn ? formatDateOnly(r.admittedOn) : ""}
                  </TableCell>
                  <TableCell>
                    <div>{r.noticeAddress}</div>
                    <div className="text-muted-foreground">{r.noticeEmail}</div>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
          <TableFooter>
            <TableRow>
              <TableCell className="font-medium">Total</TableCell>
              <TableCell className="text-right">
                {formatCents(t.committedCents)}
              </TableCell>
              <TableCell className="text-right">
                {formatCents(t.paidCents)}
              </TableCell>
              <TableCell className="text-right">{trimUnits(t.units)}</TableCell>
              <TableCell className="text-right">{t.percent}%</TableCell>
              <TableCell />
              <TableCell />
            </TableRow>
          </TableFooter>
        </Table>
        {hasFio ? (
          <p className="px-4 pb-3 text-xs text-muted-foreground">
            * {FINANCIAL_INTEREST_NOTE}
          </p>
        ) : null}
      </Card>

      <div className="flex flex-col gap-y-1 text-sm text-muted-foreground">
        <p>{footer.manager}</p>
        <p>{footer.terms}</p>
      </div>
    </div>
  );
}
