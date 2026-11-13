import {
  Document,
  Page,
  renderToBuffer,
  StyleSheet,
  Text,
  View,
} from "@react-pdf/renderer";
import { formatDateOnly } from "../../lib/date-only";
import type { ReportFigures } from "../../lib/governance/report-figures";
import type { RichDoc } from "../../lib/governance/rich-doc";
import { formatCents } from "../../lib/money";
import { RichDocPdf } from "./rich-doc-pdf";

// Member report PDF (03-governance.md G13). Same content and order as
// `src/components/governance/report-view.tsx`. Built-in fonts only (no
// Font.register, no network access at render time). Only files visible to
// EVERY recipient are listed: a private file (a holder's Schedule K-1) is
// never named here, because the filed PDF is part of the books and records.

export interface ReportPdfData {
  companyName: string;
  title: string;
  /** "Quarterly report", "Annual financial statements", … */
  typeLabel: string;
  type: "QUARTERLY" | "ANNUAL" | "TAX_K1" | "NOTICE";
  periodStart: string | null;
  periodEnd: string | null;
  fiscalQuarter: number | null;
  fiscalYear: number | null;
  /** Pre-formatted send time in the company time zone. */
  sent: string;
  /** QUARTERLY / ANNUAL only. */
  figures: ReportFigures | null;
  doc: RichDoc;
  /** Names of the attachments with no holder (visible to all recipients). */
  sharedAttachmentNames: string[];
  /** Full sha256 hex of the frozen content; the footer prints the first 16. */
  frozenHash: string;
}

const MARGIN = 54;

const styles = StyleSheet.create({
  page: {
    fontFamily: "Helvetica",
    fontSize: 10,
    paddingTop: MARGIN,
    paddingBottom: MARGIN + 18,
    paddingHorizontal: MARGIN,
  },
  // No lineHeight on the Page: inherited by the fixed render-prop footer it
  // makes react-pdf 4.9 drop that footer.
  content: {},
  company: { fontFamily: "Helvetica-Bold", fontSize: 13, textAlign: "center" },
  title: {
    fontFamily: "Helvetica-Bold",
    fontSize: 12,
    textAlign: "center",
    marginTop: 6,
  },
  period: { textAlign: "center", marginTop: 3, color: "#3f3f46" },
  sent: {
    textAlign: "center",
    marginTop: 2,
    marginBottom: 12,
    color: "#52525b",
  },
  section: {
    fontFamily: "Helvetica-Bold",
    fontSize: 11,
    marginTop: 12,
    marginBottom: 5,
  },
  row: {
    flexDirection: "row",
    borderBottomWidth: 0.5,
    borderBottomColor: "#d4d4d8",
    paddingVertical: 2.5,
  },
  label: { width: "65%" },
  labelIndent: { width: "65%", paddingLeft: 14, color: "#3f3f46" },
  value: { width: "35%", textAlign: "right" },
  bold: { fontFamily: "Helvetica-Bold" },
  note: { color: "#52525b", fontSize: 9, marginTop: 2, marginBottom: 4 },
  cell: { paddingHorizontal: 2 },
  right: { textAlign: "right" },
  muted: { color: "#52525b" },
  footerText: { marginTop: 14, fontSize: 9, color: "#3f3f46" },
  footer: {
    position: "absolute",
    bottom: MARGIN - 24,
    left: MARGIN,
    right: MARGIN,
    fontSize: 8,
    textAlign: "center",
    color: "#52525b",
  },
});

/** Basis points as "82.50%" (integer arithmetic only). */
export function formatBpsPercent(bps: number | null): string {
  if (bps === null) return "—";
  const whole = Math.trunc(bps / 100);
  const frac = String(Math.abs(bps % 100)).padStart(2, "0");
  return `${whole}.${frac}%`;
}

function money(cents: number | null): string {
  return cents === null ? "—" : formatCents(cents);
}

/** "SOME_CATEGORY" → "Some category"; other text unchanged. */
export function humanizeCategory(category: string): string {
  if (!/^[A-Z0-9_]+$/.test(category)) return category;
  const words = category.toLowerCase().replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

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

function Row({
  label,
  value,
  indent,
  bold,
}: {
  label: string;
  value: string;
  indent?: boolean;
  bold?: boolean;
}) {
  return (
    <View style={styles.row} wrap={false}>
      <Text
        style={[
          indent ? styles.labelIndent : styles.label,
          bold ? styles.bold : {},
        ]}
      >
        {label}
      </Text>
      <Text style={[styles.value, bold ? styles.bold : {}]}>{value}</Text>
    </View>
  );
}

function Note({ text }: { text: string }) {
  return text.trim() === "" ? null : <Text style={styles.note}>{text}</Text>;
}

type Col = { label: string; width: string; right?: boolean };

function TableRow({
  cols,
  cells,
  head,
}: {
  cols: Col[];
  cells: string[];
  head?: boolean;
}) {
  return (
    <View style={styles.row} wrap={false}>
      {cols.map((col, i) => (
        <Text
          key={col.label}
          style={[
            styles.cell,
            { width: col.width },
            col.right ? styles.right : {},
            head ? styles.bold : {},
          ]}
        >
          {cells[i] ?? ""}
        </Text>
      ))}
    </View>
  );
}

const PAYMENT_COLS: Col[] = [
  { label: "Date", width: "14%" },
  { label: "Payee", width: "24%" },
  { label: "Purpose", width: "34%" },
  { label: "Flow", width: "12%" },
  { label: "Amount", width: "16%", right: true },
];

const INSIDER_DIST_COLS: Col[] = [
  { label: "Name", width: "50%" },
  { label: "Date", width: "25%" },
  { label: "Net amount", width: "25%", right: true },
];

const INSIDER_LOAN_COLS: Col[] = [
  { label: "Name", width: "40%" },
  { label: "Date", width: "20%" },
  { label: "Principal", width: "20%", right: true },
  { label: "Interest", width: "20%", right: true },
];

function Figures({
  figures,
  type,
}: {
  figures: ReportFigures;
  type: ReportPdfData["type"];
}) {
  const f = figures;
  const mp = f.managerPayments;
  const hasPayments =
    mp.lines.length +
      mp.insiderDistributions.length +
      mp.insiderLoanPayments.length >
    0;
  return (
    <View>
      <Text style={styles.section}>Figures</Text>
      <Row label="Revenue" value={money(f.revenue.amountCents)} />
      <Note text={f.revenue.note} />
      <Row label="Utilization" value={formatBpsPercent(f.utilization.bps)} />
      <Note text={f.utilization.note} />
      <Row label="Expenses" value={money(f.expenses.totalCents)} />
      {f.expenses.lines.map((l, i) => (
        <Row
          // biome-ignore lint/suspicious/noArrayIndexKey: frozen content, never reordered
          key={i}
          indent
          label={humanizeCategory(l.category)}
          value={money(l.amountCents)}
        />
      ))}
      <Note text={f.expenses.note} />
      <Row
        label="Management Fee accrued"
        value={money(f.managementFee.accruedCents)}
      />
      <Row indent label="Paid" value={money(f.managementFee.paidCents)} />
      {f.managementFee.unpaidAtEndCents !== null ? (
        <Row
          indent
          label="Unpaid at period end"
          value={money(f.managementFee.unpaidAtEndCents)}
        />
      ) : null}
      <Note text={f.managementFee.note} />
      <Row label="Reserve balance" value={money(f.reserves.balanceCents)} />
      {f.reserves.minimumRequiredCents !== null ? (
        <Row
          indent
          label="Minimum required"
          value={money(f.reserves.minimumRequiredCents)}
        />
      ) : null}
      <Note text={f.reserves.note} />
      {f.distributions.none ? (
        <Row
          label="Distributions"
          value={
            type === "QUARTERLY"
              ? "No distribution this quarter"
              : "No distribution this period"
          }
        />
      ) : (
        <View>
          <Row
            label="Distributions"
            value={money(f.distributions.totalCents)}
          />
          <Row
            indent
            label="Preferred Return"
            value={money(f.distributions.preferredReturnCents)}
          />
          <Row
            indent
            label="Return of capital"
            value={money(f.distributions.returnOfCapitalCents)}
          />
          <Row
            indent
            label="Residual"
            value={money(f.distributions.residualCents)}
          />
        </View>
      )}
      <Note text={f.distributions.note} />

      <Text style={styles.section}>
        Amounts paid to or through the Manager and its Affiliates
      </Text>
      {!hasPayments ? (
        <Text>None in this period</Text>
      ) : (
        <View>
          {mp.lines.length > 0 ? (
            <View>
              <TableRow
                head
                cols={PAYMENT_COLS}
                cells={PAYMENT_COLS.map((c) => c.label)}
              />
              {mp.lines.map((l, i) => (
                <TableRow
                  // biome-ignore lint/suspicious/noArrayIndexKey: frozen content, never reordered
                  key={i}
                  cols={PAYMENT_COLS}
                  cells={[
                    formatDateOnly(l.paidOn),
                    l.payee,
                    `${humanizeCategory(l.category)}${l.memo ? ` — ${l.memo}` : ""}`,
                    l.flow === "TO" ? "To" : "Through",
                    formatCents(l.amountCents),
                  ]}
                />
              ))}
            </View>
          ) : null}
          {mp.insiderDistributions.length > 0 ? (
            <View>
              <Text style={[styles.bold, { marginTop: 8, marginBottom: 3 }]}>
                Distributions to the Manager, its Affiliates and related holders
              </Text>
              <TableRow
                head
                cols={INSIDER_DIST_COLS}
                cells={INSIDER_DIST_COLS.map((c) => c.label)}
              />
              {mp.insiderDistributions.map((d, i) => (
                <TableRow
                  // biome-ignore lint/suspicious/noArrayIndexKey: frozen content, never reordered
                  key={i}
                  cols={INSIDER_DIST_COLS}
                  cells={[
                    d.name,
                    formatDateOnly(d.paymentDate),
                    formatCents(d.netCents),
                  ]}
                />
              ))}
            </View>
          ) : null}
          {mp.insiderLoanPayments.length > 0 ? (
            <View>
              <Text style={[styles.bold, { marginTop: 8, marginBottom: 3 }]}>
                Loan repayments to them
              </Text>
              <TableRow
                head
                cols={INSIDER_LOAN_COLS}
                cells={INSIDER_LOAN_COLS.map((c) => c.label)}
              />
              {mp.insiderLoanPayments.map((l, i) => (
                <TableRow
                  // biome-ignore lint/suspicious/noArrayIndexKey: frozen content, never reordered
                  key={i}
                  cols={INSIDER_LOAN_COLS}
                  cells={[
                    l.name,
                    formatDateOnly(l.paidOn),
                    formatCents(l.principalCents),
                    formatCents(l.interestCents),
                  ]}
                />
              ))}
            </View>
          ) : null}
          {mp.grandTotalCents !== null ? (
            <View style={{ marginTop: 4 }}>
              <Row bold label="Total" value={formatCents(mp.grandTotalCents)} />
            </View>
          ) : null}
        </View>
      )}
    </View>
  );
}

export function ReportPdf({ data }: { data: ReportPdfData }) {
  const hashPrefix = data.frozenHash.slice(0, 16);
  const period = reportPeriodLine(data);
  return (
    <Document title={data.title}>
      <Page size="LETTER" style={styles.page}>
        <View style={styles.content}>
          <Text style={styles.company}>{data.companyName}</Text>
          <Text style={styles.title}>{data.title}</Text>
          <Text style={styles.period}>
            {period ? `${data.typeLabel} · ${period}` : data.typeLabel}
          </Text>
          <Text style={styles.sent}>{`Sent ${data.sent}`}</Text>

          {data.figures &&
          (data.type === "QUARTERLY" || data.type === "ANNUAL") ? (
            <Figures figures={data.figures} type={data.type} />
          ) : null}

          {data.doc.length > 0 ? (
            <View style={{ marginTop: 12 }}>
              <RichDocPdf doc={data.doc} />
            </View>
          ) : null}

          {data.sharedAttachmentNames.length > 0 ? (
            <View>
              <Text style={styles.section}>Documents</Text>
              {data.sharedAttachmentNames.map((name, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: names may repeat
                <Text key={i}>{`• ${name}`}</Text>
              ))}
            </View>
          ) : null}

          <Text style={styles.footerText}>
            {`Confidential. Provided to Members of ${data.companyName} under Section 8.3 of the Operating Agreement.`}
          </Text>
        </View>

        <Text
          style={styles.footer}
          fixed
          render={({ pageNumber, totalPages }) =>
            `${data.companyName} · ${data.title} · document hash ${hashPrefix} · page ${pageNumber} of ${totalPages}`
          }
        />
      </Page>
    </Document>
  );
}

export async function renderReportPdf(data: ReportPdfData): Promise<Buffer> {
  return await renderToBuffer(<ReportPdf data={data} />);
}
