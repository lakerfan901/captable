/**
 * Member Schedule (Exhibit A) as CSV. Pure. RFC 4180 quoting; cells that a
 * spreadsheet would read as a formula are prefixed with `'`.
 */
import { trimUnits as units } from "../../server/llc/serialize";
import type { MemberScheduleDTO } from "./member-schedule";

export const COMMON_HEADER =
  "Common Member,Capital Contribution,Common Units,Common Unit Percentage Interest";
export const PREFERRED_HEADER =
  "Preferred Members,Capital Contribution Committed,Paid to Date,Preferred Units,Preferred Unit Percentage Interest,Date Admitted,Notice Address and Email";

/** 10000000 → "100000.00". Integer math only. */
function money(cents: number): string {
  const v = BigInt(cents);
  const neg = v < 0n;
  const abs = neg ? -v : v;
  return `${neg ? "-" : ""}${abs / 100n}.${(abs % 100n).toString().padStart(2, "0")}`;
}

export function csvCell(value: string): string {
  let v = value;
  if (/^[=+\-@]/.test(v)) v = `'${v}`;
  if (/[",\r\n]/.test(v)) v = `"${v.replace(/"/g, '""')}"`;
  return v;
}

const line = (cells: string[]) => cells.map(csvCell).join(",");

export function toMemberScheduleCsv(schedule: MemberScheduleDTO): string {
  const out: string[] = [COMMON_HEADER];
  for (const r of schedule.common.rows) {
    out.push(
      line([
        r.name,
        money(r.capitalContributionCents),
        units(r.units),
        `${r.percent}%`,
      ]),
    );
  }
  out.push("");
  out.push(PREFERRED_HEADER);
  for (const r of schedule.preferred.rows) {
    out.push(
      line([
        r.name,
        money(r.committedCents),
        money(r.paidCents),
        units(r.units),
        `${r.percent}%`,
        r.admittedOn ?? "",
        `${r.noticeAddress}; ${r.noticeEmail}`,
      ]),
    );
  }
  const t = schedule.preferred.totals;
  out.push(
    line([
      "Total",
      money(t.committedCents),
      money(t.paidCents),
      units(t.units),
      `${t.percent}%`,
      "",
      "",
    ]),
  );
  return `${out.join("\r\n")}\r\n`;
}
