import type { ReactNode } from "react";
import { Money } from "@/components/llc/money";
import { formatDateOnly } from "@/lib/date-only";
import {
  isNoticeKind,
  NOTICE_KINDS,
  type ReportFigures,
} from "@/lib/governance/report-figures";
import type { RichDoc } from "@/lib/governance/rich-doc";
import { formatCents } from "@/lib/money";
import { RichDocView } from "./rich-doc-view";

// Member report content (03-governance.md G13). Server-Component-safe (no
// hooks, no client APIs): used by the public report page, the SENT view of
// the Manager's report page, and as the layout reference of the PDF
// (`src/pdf-templates/governance/report-pdf.tsx`, same order; the PDF keeps
// its own copy of the three formatting helpers so this file never loads
// @react-pdf).

export const REPORT_TYPE_LABEL: Record<string, string> = {
  QUARTERLY: "Quarterly report",
  ANNUAL: "Annual financial statements",
  TAX_K1: "Schedule K-1 delivery",
  NOTICE: "Notice",
};

export function reportTypeLabel(type: string, noticeKind?: string | null) {
  if (type === "NOTICE" && isNoticeKind(noticeKind)) {
    const k = NOTICE_KINDS[noticeKind];
    return `${k.label} (Section ${k.section})`;
  }
  return REPORT_TYPE_LABEL[type] ?? type;
}

/** Basis points as "82.50%" (integer arithmetic only). */
export function formatBpsPercent(bps: number | null): string {
  if (bps === null) return "—";
  const whole = Math.trunc(bps / 100);
  const frac = String(Math.abs(bps % 100)).padStart(2, "0");
  return `${whole}.${frac}%`;
}

/** "SOME_CATEGORY" → "Some category"; other text unchanged. */
export function humanizeCategory(category: string): string {
  if (!/^[A-Z0-9_]+$/.test(category)) return category;
  const words = category.toLowerCase().replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** "Q3 2026 (Jul 1, 2026 – Sep 30, 2026)", "Fiscal year 2025 (…)", or the range. */
export function reportPeriodLine(input: {
  type: string;
  periodStart: string | null;
  periodEnd: string | null;
  fiscalQuarter: number | null;
  fiscalYear: number | null;
}): string | null {
  const range =
    input.periodStart && input.periodEnd
      ? `${formatDateOnly(input.periodStart)} – ${formatDateOnly(input.periodEnd)}`
      : null;
  if (input.type === "QUARTERLY" && input.fiscalQuarter && input.fiscalYear) {
    return `Q${input.fiscalQuarter} ${input.fiscalYear}${range ? ` (${range})` : ""}`;
  }
  if (
    (input.type === "ANNUAL" || input.type === "TAX_K1") &&
    input.fiscalYear
  ) {
    return `Fiscal year ${input.fiscalYear}${range ? ` (${range})` : ""}`;
  }
  return range;
}

export interface ReportViewProps {
  companyName: string;
  title: string;
  type: string;
  noticeKind: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  fiscalYear?: number | null;
  fiscalQuarter?: number | null;
  /** Pre-formatted send time, or null. */
  sentText?: string | null;
  figures: ReportFigures | null;
  doc: RichDoc;
  /** Rendered after the commentary (e.g. the public "Documents" list). */
  children?: ReactNode;
}

function Line({
  label,
  value,
  indent,
  strong,
}: {
  label: string;
  value: ReactNode;
  indent?: boolean;
  strong?: boolean;
}) {
  return (
    <tr className="border-b last:border-b-0">
      <td
        className={`py-1.5 pr-4 ${indent ? "pl-6 text-muted-foreground" : ""} ${strong ? "font-semibold" : ""}`}
      >
        {label}
      </td>
      <td
        className={`py-1.5 text-right tabular-nums ${strong ? "font-semibold" : ""}`}
      >
        {value}
      </td>
    </tr>
  );
}

function NoteRow({ note }: { note: string }) {
  if (note.trim() === "") return null;
  return (
    <tr>
      <td
        colSpan={2}
        className="whitespace-pre-wrap break-words pb-2 text-xs text-muted-foreground"
      >
        {note}
      </td>
    </tr>
  );
}

function ManagerPayments({ figures }: { figures: ReportFigures }) {
  const mp = figures.managerPayments;
  const any =
    mp.lines.length +
      mp.insiderDistributions.length +
      mp.insiderLoanPayments.length >
    0;
  return (
    <section className="space-y-3">
      <h2 className="text-base font-semibold">
        Amounts paid to or through the Manager and its Affiliates
      </h2>
      {!any ? (
        <p className="text-sm">None in this period</p>
      ) : (
        <div className="space-y-4 text-sm">
          {mp.lines.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[520px]">
                <thead>
                  <tr className="border-b text-left">
                    <th className="py-1.5 pr-3 font-medium">Date</th>
                    <th className="py-1.5 pr-3 font-medium">Payee</th>
                    <th className="py-1.5 pr-3 font-medium">Purpose</th>
                    <th className="py-1.5 pr-3 font-medium">Flow</th>
                    <th className="py-1.5 text-right font-medium">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {mp.lines.map((l, i) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: report content, never reordered
                    <tr key={i} className="border-b last:border-b-0">
                      <td className="whitespace-nowrap py-1.5 pr-3">
                        {formatDateOnly(l.paidOn)}
                      </td>
                      <td className="py-1.5 pr-3">{l.payee}</td>
                      <td className="py-1.5 pr-3">
                        {humanizeCategory(l.category)}
                        {l.memo ? (
                          <span className="block text-xs text-muted-foreground">
                            {l.memo}
                          </span>
                        ) : null}
                      </td>
                      <td className="py-1.5 pr-3">
                        {l.flow === "TO" ? "To" : "Through"}
                      </td>
                      <td className="py-1.5 text-right tabular-nums">
                        {formatCents(l.amountCents)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
          {mp.insiderDistributions.length > 0 ? (
            <div className="space-y-1">
              <h3 className="font-medium">
                Distributions to the Manager, its Affiliates and related holders
              </h3>
              <table className="w-full">
                <tbody>
                  {mp.insiderDistributions.map((d, i) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: report content, never reordered
                    <tr key={i} className="border-b last:border-b-0">
                      <td className="py-1.5 pr-3">{d.name}</td>
                      <td className="whitespace-nowrap py-1.5 pr-3">
                        {formatDateOnly(d.paymentDate)}
                      </td>
                      <td className="py-1.5 text-right tabular-nums">
                        {formatCents(d.netCents)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
          {mp.insiderLoanPayments.length > 0 ? (
            <div className="space-y-1">
              <h3 className="font-medium">Loan repayments to them</h3>
              <table className="w-full">
                <thead>
                  <tr className="border-b text-left">
                    <th className="py-1.5 pr-3 font-medium">Name</th>
                    <th className="py-1.5 pr-3 font-medium">Date</th>
                    <th className="py-1.5 pr-3 text-right font-medium">
                      Principal
                    </th>
                    <th className="py-1.5 text-right font-medium">Interest</th>
                  </tr>
                </thead>
                <tbody>
                  {mp.insiderLoanPayments.map((l, i) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: report content, never reordered
                    <tr key={i} className="border-b last:border-b-0">
                      <td className="py-1.5 pr-3">{l.name}</td>
                      <td className="whitespace-nowrap py-1.5 pr-3">
                        {formatDateOnly(l.paidOn)}
                      </td>
                      <td className="py-1.5 pr-3 text-right tabular-nums">
                        {formatCents(l.principalCents)}
                      </td>
                      <td className="py-1.5 text-right tabular-nums">
                        {formatCents(l.interestCents)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
          {mp.grandTotalCents !== null ? (
            <p className="flex justify-between border-t pt-2 font-semibold">
              <span>Total</span>
              <span className="tabular-nums">
                {formatCents(mp.grandTotalCents)}
              </span>
            </p>
          ) : null}
        </div>
      )}
    </section>
  );
}

function FiguresTable({
  figures,
  type,
}: {
  figures: ReportFigures;
  type: string;
}) {
  const f = figures;
  return (
    <section className="space-y-2">
      <h2 className="text-base font-semibold">Figures</h2>
      <table className="w-full text-sm">
        <tbody>
          <Line
            label="Revenue"
            value={<Money cents={f.revenue.amountCents} />}
          />
          <NoteRow note={f.revenue.note} />
          <Line
            label="Utilization"
            value={formatBpsPercent(f.utilization.bps)}
          />
          <NoteRow note={f.utilization.note} />
          <Line
            label="Expenses"
            value={<Money cents={f.expenses.totalCents} />}
          />
          {f.expenses.lines.map((l, i) => (
            <Line
              // biome-ignore lint/suspicious/noArrayIndexKey: report content, never reordered
              key={i}
              indent
              label={humanizeCategory(l.category)}
              value={<Money cents={l.amountCents} />}
            />
          ))}
          <NoteRow note={f.expenses.note} />
          <Line
            label="Management Fee accrued"
            value={<Money cents={f.managementFee.accruedCents} />}
          />
          <Line
            indent
            label="Paid"
            value={<Money cents={f.managementFee.paidCents} />}
          />
          {f.managementFee.unpaidAtEndCents !== null ? (
            <Line
              indent
              label="Unpaid at period end"
              value={<Money cents={f.managementFee.unpaidAtEndCents} />}
            />
          ) : null}
          <NoteRow note={f.managementFee.note} />
          <Line
            label="Reserve balance"
            value={<Money cents={f.reserves.balanceCents} />}
          />
          {f.reserves.minimumRequiredCents !== null ? (
            <Line
              indent
              label="Minimum required"
              value={<Money cents={f.reserves.minimumRequiredCents} />}
            />
          ) : null}
          <NoteRow note={f.reserves.note} />
          {f.distributions.none ? (
            <Line
              label="Distributions"
              value={
                type === "QUARTERLY"
                  ? "No distribution this quarter"
                  : "No distribution this period"
              }
            />
          ) : (
            <>
              <Line
                label="Distributions"
                value={<Money cents={f.distributions.totalCents} />}
              />
              <Line
                indent
                label="Preferred Return"
                value={<Money cents={f.distributions.preferredReturnCents} />}
              />
              <Line
                indent
                label="Return of capital"
                value={<Money cents={f.distributions.returnOfCapitalCents} />}
              />
              <Line
                indent
                label="Residual"
                value={<Money cents={f.distributions.residualCents} />}
              />
            </>
          )}
          <NoteRow note={f.distributions.note} />
        </tbody>
      </table>
    </section>
  );
}

export function ReportView({
  companyName,
  title,
  type,
  noticeKind,
  periodStart,
  periodEnd,
  fiscalYear = null,
  fiscalQuarter = null,
  sentText = null,
  figures,
  doc,
  children,
}: ReportViewProps) {
  const period = reportPeriodLine({
    type,
    periodStart,
    periodEnd,
    fiscalQuarter,
    fiscalYear,
  });
  const withFigures = (type === "QUARTERLY" || type === "ANNUAL") && figures;
  return (
    <article className="space-y-6 break-words">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        <p className="text-sm text-muted-foreground">
          {reportTypeLabel(type, noticeKind)}
          {period ? ` · ${period}` : ""}
        </p>
        {sentText ? (
          <p className="text-sm text-muted-foreground">Sent {sentText}</p>
        ) : null}
      </header>

      {withFigures ? (
        <>
          <FiguresTable figures={figures} type={type} />
          <ManagerPayments figures={figures} />
        </>
      ) : null}

      {doc.length > 0 ? (
        <section>
          <RichDocView doc={doc} />
        </section>
      ) : null}

      {children}

      <p className="border-t pt-4 text-xs text-muted-foreground">
        Confidential. Provided to Members of {companyName} under Section 8.3 of
        the Operating Agreement.
      </p>
    </article>
  );
}
