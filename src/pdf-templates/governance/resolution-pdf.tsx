import {
  Document,
  Page,
  renderToBuffer,
  StyleSheet,
  Text,
  View,
} from "@react-pdf/renderer";
import type { RichDoc } from "../../lib/governance/rich-doc";
import { RichDocPdf } from "./rich-doc-pdf";

// Executed resolution PDF (03-governance.md G9). Built-in fonts only: no
// Font.register, no network access at render time. IP addresses and user
// agents are deliberately NOT printed; non-consenting Members are shown as
// aggregates only.

/** Plain serialisable input; every display string is pre-formatted by `buildResolutionPdfData`. */
export interface ResolutionPdfData {
  companyName: string;
  kindLabel: string;
  title: string;
  referenceCode: string;
  /** Full sha256 hex of `frozenContent`; the footer prints the first 16 characters. */
  frozenHash: string;
  facts: {
    reference: string;
    recordDate: string;
    sent: string;
    effective: string;
  };
  doc: RichDoc;
  lockedClauses: string[];
  /** MANAGER_APPROVAL / COMMON_MEMBER_APPROVAL requirements that were signed. */
  approvals: {
    role: string;
    approverName: string;
    approverCapacity: string;
    signedAt: string;
  }[];
  /** "yes" when the resolution has ballots (the Member signature table is printed). */
  hasBallots: "yes" | "no";
  /** Ballots with choice FOR and deemed false, sorted by name. */
  memberSignatures: {
    member: string;
    signedName: string;
    signerCapacity: string;
    preferredUnits: string;
    signedAt: string;
  }[];
  /**
   * One line per ballot whose email was changed after send (H1), printed
   * under the Member signature table. Names only: the PDF goes to every
   * Member, so no address is printed.
   */
  emailChanges?: string[];
  /** One block per UNIT_VOTE requirement, in requirement order. */
  tallies: {
    basisLabel: string;
    section: string;
    outstanding: string;
    requiredUnits: string;
    requiredWording: string;
    forUnits: string;
    forPercent: string;
    against: string;
    abstain: string;
    noResponse: string;
    /** Units deemed Against under Section 2.5; "" when none. */
    deemedAgainst: string;
    result: "Approved" | "Not approved";
  }[];
}

export const RESOLUTION_PDF_CLOSING =
  "Executed electronically under Sections 6.12 and 13.9 of the Operating Agreement. Filed with the books and records of the LLC under Section 8.1(e).";

const MARGIN = 54;

const styles = StyleSheet.create({
  page: {
    fontFamily: "Helvetica",
    fontSize: 10.5,
    paddingTop: MARGIN,
    paddingBottom: MARGIN + 18,
    paddingHorizontal: MARGIN,
  },
  // lineHeight lives on the content View, not the Page: inherited by the
  // fixed render-prop footer it makes react-pdf 4.9 drop that footer.
  content: { lineHeight: 1.35 },
  company: {
    fontFamily: "Helvetica-Bold",
    fontSize: 13,
    textAlign: "center",
  },
  kind: { fontSize: 11, textAlign: "center", marginTop: 4 },
  title: {
    fontFamily: "Helvetica-Bold",
    fontSize: 12,
    textAlign: "center",
    marginTop: 6,
    marginBottom: 10,
  },
  facts: {
    borderTopWidth: 0.75,
    borderBottomWidth: 0.75,
    borderColor: "#a1a1aa",
    paddingVertical: 4,
    marginBottom: 12,
  },
  factRow: { flexDirection: "row", paddingVertical: 1.5 },
  factLabel: { width: "30%", fontFamily: "Helvetica-Bold" },
  factValue: { width: "70%" },
  section: {
    fontFamily: "Helvetica-Bold",
    fontSize: 11.5,
    marginTop: 14,
    marginBottom: 6,
  },
  clause: { flexDirection: "row", marginBottom: 4 },
  clauseNo: { width: 20 },
  clauseText: { flex: 1 },
  signature: { marginBottom: 8 },
  bold: { fontFamily: "Helvetica-Bold" },
  row: {
    flexDirection: "row",
    borderBottomWidth: 0.5,
    borderBottomColor: "#a1a1aa",
    paddingVertical: 3,
  },
  cell: { paddingHorizontal: 3 },
  right: { textAlign: "right" },
  tally: { marginBottom: 10 },
  tallyHead: { fontFamily: "Helvetica-Bold", marginBottom: 3 },
  tallyRow: { flexDirection: "row", paddingVertical: 1 },
  tallyLabel: { width: "45%" },
  tallyValue: { width: "55%" },
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

const BALLOT_COLS = [
  { label: "Member", width: "28%" },
  { label: "Signed by", width: "32%" },
  { label: "Preferred Units", width: "16%", right: true },
  { label: "Signed at", width: "24%" },
] as const;

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.factRow}>
      <Text style={styles.factLabel}>{label}</Text>
      <Text style={styles.factValue}>{value}</Text>
    </View>
  );
}

function TallyLine({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.tallyRow}>
      <Text style={styles.tallyLabel}>{label}</Text>
      <Text style={styles.tallyValue}>{value}</Text>
    </View>
  );
}

function BallotRow({ cells, head }: { cells: string[]; head?: boolean }) {
  return (
    <View style={styles.row} wrap={false}>
      {BALLOT_COLS.map((col, i) => (
        <Text
          key={col.label}
          style={[
            styles.cell,
            { width: col.width },
            "right" in col ? styles.right : {},
            head ? styles.bold : {},
          ]}
        >
          {cells[i]}
        </Text>
      ))}
    </View>
  );
}

export function ResolutionPdf({ data }: { data: ResolutionPdfData }) {
  const hashPrefix = data.frozenHash.slice(0, 16);
  return (
    <Document title={`${data.referenceCode} ${data.title}`}>
      <Page size="LETTER" style={styles.page}>
        <View style={styles.content}>
          {/* 1. Header */}
          <Text style={styles.company}>{data.companyName}</Text>
          <Text style={styles.kind}>{data.kindLabel}</Text>
          <Text style={styles.title}>{data.title}</Text>
          <View style={styles.facts}>
            <Fact label="Reference" value={data.facts.reference} />
            <Fact label="Record date" value={data.facts.recordDate} />
            <Fact label="Sent" value={data.facts.sent} />
            <Fact label="Effective" value={data.facts.effective} />
          </View>

          {/* 2. Body */}
          <RichDocPdf doc={data.doc} />
          {data.lockedClauses.length > 0 ? (
            <View style={{ marginTop: 8 }}>
              {data.lockedClauses.map((clause, i) => (
                <View key={clause} style={styles.clause} wrap={false}>
                  <Text style={styles.clauseNo}>{`${i + 1}.`}</Text>
                  <Text style={styles.clauseText}>{clause}</Text>
                </View>
              ))}
            </View>
          ) : null}

          {/* 3. Signatures */}
          <Text style={styles.section}>Signatures</Text>
          {data.approvals.map((a) => (
            <View
              key={`${a.role}-${a.approverName}-${a.signedAt}`}
              style={styles.signature}
              wrap={false}
            >
              <Text style={styles.bold}>{a.role}</Text>
              <Text>{`${a.approverName}, ${a.approverCapacity}`}</Text>
              <Text>{`Signed at ${a.signedAt}. Signed electronically.`}</Text>
            </View>
          ))}
          {data.hasBallots === "yes" ? (
            <View style={{ marginTop: 6 }}>
              <BallotRow head cells={BALLOT_COLS.map((c) => c.label)} />
              {data.memberSignatures.map((s) => (
                <BallotRow
                  key={`${s.member}-${s.signedAt}`}
                  cells={[
                    s.member,
                    s.signerCapacity
                      ? `${s.signedName}, ${s.signerCapacity}`
                      : s.signedName,
                    s.preferredUnits,
                    s.signedAt,
                  ]}
                />
              ))}
              {(data.emailChanges ?? []).map((line) => (
                <Text key={line} style={{ marginTop: 4 }}>
                  {line}
                </Text>
              ))}
            </View>
          ) : null}

          {/* 4. Tally */}
          {data.tallies.length > 0 ? (
            <View>
              <Text style={styles.section}>Tally</Text>
              {data.tallies.map((t) => (
                <View
                  key={`${t.basisLabel}-${t.section}`}
                  style={styles.tally}
                  wrap={false}
                >
                  <Text style={styles.tallyHead}>
                    {`${t.basisLabel} (Section ${t.section})`}
                  </Text>
                  <TallyLine
                    label="Outstanding units entitled to vote"
                    value={t.outstanding}
                  />
                  <TallyLine
                    label="Required"
                    value={`${t.requiredUnits} units (${t.requiredWording})`}
                  />
                  <TallyLine
                    label="For"
                    value={`${t.forUnits} units (${t.forPercent}%)`}
                  />
                  <TallyLine label="Against" value={t.against} />
                  <TallyLine label="Abstain" value={t.abstain} />
                  <TallyLine label="No response" value={t.noResponse} />
                  {t.deemedAgainst !== "" ? (
                    <TallyLine
                      label="Deemed against (Section 2.5)"
                      value={t.deemedAgainst}
                    />
                  ) : null}
                  <TallyLine label="Result" value={t.result} />
                </View>
              ))}
            </View>
          ) : null}
        </View>

        {/* 5. Footer on every page */}
        <View style={styles.footer} fixed>
          <Text
            render={({ pageNumber, totalPages }) =>
              pageNumber === totalPages ? RESOLUTION_PDF_CLOSING : ""
            }
          />
          <Text
            render={({ pageNumber, totalPages }) =>
              `${data.referenceCode} · document hash ${hashPrefix} · page ${pageNumber} of ${totalPages}`
            }
          />
        </View>
      </Page>
    </Document>
  );
}

export async function renderResolutionPdf(
  data: ResolutionPdfData,
): Promise<Buffer> {
  return await renderToBuffer(<ResolutionPdf data={data} />);
}
