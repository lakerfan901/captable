import { Document, Page, StyleSheet, Text, View } from "@react-pdf/renderer";
import { scheduleFooterLines } from "@/components/llc/schedule/member-schedule-view";
import type { MemberScheduleDTO } from "@/lib/admission/member-schedule";
import { formatDateOnly } from "@/lib/date-only";
import { formatCents } from "@/lib/money";
import { trimUnits } from "@/server/llc/serialize";

// Built-in Helvetica only: no Font.register, no network at render time.
const styles = StyleSheet.create({
  page: {
    fontFamily: "Helvetica",
    fontSize: 8,
    paddingTop: 30,
    paddingBottom: 45,
    paddingHorizontal: 30,
  },
  title: {
    fontFamily: "Helvetica-Bold",
    fontSize: 14,
    textAlign: "center",
  },
  subtitle: { fontSize: 10, textAlign: "center", marginTop: 4 },
  section: {
    fontFamily: "Helvetica-Bold",
    fontSize: 10,
    marginTop: 14,
    marginBottom: 4,
  },
  row: {
    flexDirection: "row",
    borderBottomWidth: 0.5,
    borderBottomColor: "#a1a1aa",
    paddingVertical: 3,
  },
  head: { fontFamily: "Helvetica-Bold" },
  cell: { paddingHorizontal: 3 },
  right: { textAlign: "right" },
  footer: { marginTop: 14, fontSize: 8 },
  note: { marginTop: 4, fontSize: 7 },
  pageNumber: {
    position: "absolute",
    bottom: 20,
    left: 0,
    right: 0,
    textAlign: "center",
    fontSize: 8,
  },
});

const FIO_NOTE = "holds a Financial Interest only (Section 7.9.2)";

type Col = { label: string; width: string; right?: boolean };

const COMMON_COLS: Col[] = [
  { label: "Common Member", width: "40%" },
  { label: "Capital Contribution", width: "20%", right: true },
  { label: "Common Units", width: "20%", right: true },
  { label: "Common Unit Percentage Interest", width: "20%", right: true },
];

const PREFERRED_COLS: Col[] = [
  { label: "Preferred Members", width: "18%" },
  { label: "Capital Contribution Committed", width: "12%", right: true },
  { label: "Paid to Date", width: "11%", right: true },
  { label: "Preferred Units", width: "9%", right: true },
  { label: "Preferred Unit Percentage Interest", width: "11%", right: true },
  { label: "Date Admitted", width: "10%" },
  { label: "Notice Address and Email", width: "29%" },
];

function Row({
  cols,
  cells,
  bold,
}: {
  cols: Col[];
  cells: string[];
  bold?: boolean;
}) {
  return (
    <View style={styles.row} wrap={false}>
      {cols.map((c, i) => (
        <Text
          key={c.label}
          style={[
            styles.cell,
            { width: c.width },
            ...(c.right ? [styles.right] : []),
            ...(bold ? [styles.head] : []),
          ]}
        >
          {cells[i] ?? ""}
        </Text>
      ))}
    </View>
  );
}

export function MemberScheduleTemplate({
  schedule,
}: {
  schedule: MemberScheduleDTO;
}) {
  const t = schedule.preferred.totals;
  const hasFio = schedule.preferred.rows.some(
    (r) => r.memberStatus === "FINANCIAL_INTEREST_ONLY",
  );
  const footer = scheduleFooterLines(schedule);

  return (
    <Document title={`Exhibit A - ${schedule.companyName}`}>
      <Page size="LETTER" orientation="landscape" style={styles.page}>
        <Text style={styles.title}>EXHIBIT A</Text>
        <Text style={styles.subtitle}>{schedule.companyName}</Text>
        <Text style={styles.subtitle}>
          As of {formatDateOnly(schedule.asOf)}
        </Text>

        <Text style={styles.section}>
          {schedule.common.className || "Common Units"}
        </Text>
        <Row cols={COMMON_COLS} cells={COMMON_COLS.map((c) => c.label)} bold />
        {schedule.common.rows.map((r) => (
          <Row
            key={r.stakeholderId}
            cols={COMMON_COLS}
            cells={[
              r.name,
              formatCents(r.capitalContributionCents),
              trimUnits(r.units),
              `${r.percent}%`,
            ]}
          />
        ))}

        <Text style={styles.section}>
          {schedule.preferred.className || "Preferred Units"}
        </Text>
        <Row
          cols={PREFERRED_COLS}
          cells={PREFERRED_COLS.map((c) => c.label)}
          bold
        />
        {schedule.preferred.rows.map((r) => (
          <Row
            key={r.stakeholderId}
            cols={PREFERRED_COLS}
            cells={[
              r.memberStatus === "FINANCIAL_INTEREST_ONLY"
                ? `${r.name} *`
                : r.name,
              formatCents(r.committedCents),
              formatCents(r.paidCents),
              trimUnits(r.units),
              `${r.percent}%`,
              r.admittedOn ? formatDateOnly(r.admittedOn) : "",
              [r.noticeAddress, r.noticeEmail]
                .filter((p) => p !== "")
                .join("; "),
            ]}
          />
        ))}
        <Row
          cols={PREFERRED_COLS}
          bold
          cells={[
            "Total",
            formatCents(t.committedCents),
            formatCents(t.paidCents),
            trimUnits(t.units),
            `${t.percent}%`,
            "",
            "",
          ]}
        />
        {hasFio ? <Text style={styles.note}>* {FIO_NOTE}</Text> : null}

        <View style={styles.footer} wrap={false}>
          <Text>{footer.manager}</Text>
          <Text style={{ marginTop: 3 }}>{footer.terms}</Text>
        </View>

        <Text
          style={styles.pageNumber}
          fixed
          render={({ pageNumber, totalPages }) =>
            `Page ${pageNumber} of ${totalPages}`
          }
        />
      </Page>
    </Document>
  );
}
