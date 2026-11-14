import { describe, expect, it } from "vitest";
import {
  buildDistributionCsv,
  csvCell,
  DISTRIBUTION_CSV_HEADER,
  type DistributionCsvRow,
  distributionCsvFilename,
  NOTICE_CLAIM_STALE_MS,
  noticeSkipReason,
  resendSkipReason,
} from "./distribution-export.logic";

const COMPANY = "OCTAGON GPU I LLC";

function row(
  p: Partial<DistributionCsvRow> &
    Pick<DistributionCsvRow, "stakeholderId" | "memberName">,
): DistributionCsvRow {
  return {
    distributionNumber: 1,
    paymentDate: "2027-05-14",
    email: `${p.stakeholderId.toLowerCase()}@example.com`,
    preferredUnits: 0n,
    gross: 0n,
    tierC: 0n,
    tierD: 0n,
    tierE: 0n,
    defaultOffset: 0n,
    taxAdvanceOffset: 0n,
    net: 0n,
    companyName: COMPANY,
    ...p,
  };
}

/** DR-1 (W-1 lines; B has a $2,500.00 tax advance offset). */
const DR1: DistributionCsvRow[] = [
  row({
    stakeholderId: "A",
    memberName: "Holder A",
    preferredUnits: 100_000_000n,
    gross: 288_943n,
    tierC: 288_943n,
    net: 288_943n,
  }),
  row({
    stakeholderId: "B",
    memberName: "Holder B",
    preferredUnits: 250_000_000n,
    gross: 694_108n,
    tierC: 694_108n,
    taxAdvanceOffset: 250_000n,
    net: 444_108n,
  }),
  row({
    stakeholderId: "C",
    memberName: "Holder C",
    preferredUnits: 100_000_000n,
    gross: 216_949n,
    tierC: 216_949n,
    net: 216_949n,
  }),
  row({ stakeholderId: "M", memberName: "Common Member" }),
];

describe("buildDistributionCsv", () => {
  it("DR-1: header, three data rows and the Common Member row", () => {
    const csv = buildDistributionCsv(DR1);
    expect(csv.endsWith("\r\n")).toBe(true);
    const lines = csv.slice(0, -2).split("\r\n");
    expect(lines).toHaveLength(5);
    expect(lines[0]).toBe(
      "distribution_number,payment_date,stakeholder_id,member_name,email,preferred_units,gross,tier_c_preferred_return,tier_d_return_of_capital,tier_e_residual,default_offset,tax_advance_offset,net_payable,reference",
    );
    expect(DISTRIBUTION_CSV_HEADER).toHaveLength(14);
    for (const l of lines) expect(l.split(",")).toHaveLength(14);
    expect(
      lines[2]?.endsWith(
        ",6941.08,6941.08,0.00,0.00,0.00,2500.00,4441.08,OCTAGON GPU I LLC DIST1",
      ),
    ).toBe(true);
    expect(lines[2]?.startsWith("1,2027-05-14,B,Holder B,b@example.com,")).toBe(
      true,
    );
    expect(lines[4]).toContain(
      ",Common Member,m@example.com,0.000000,0.00,0.00,0.00,0.00,0.00,0.00,0.00,",
    );
  });

  it("neutralises formula cells and quotes commas, quotes and line breaks", () => {
    const csv = buildDistributionCsv([
      row({ stakeholderId: "X", memberName: "=cmd" }),
    ]);
    expect(csv.split("\r\n")[1]).toContain(",'=cmd,");
    expect(csvCell("+1")).toBe("'+1");
    expect(csvCell("-1")).toBe("'-1");
    expect(csvCell("@x")).toBe("'@x");
    expect(csvCell("\tx")).toBe("'\tx");
    expect(csvCell("\rx")).toBe('"\'\rx"');
    expect(csvCell('Smith, "J"')).toBe('"Smith, ""J"""');
    expect(csvCell("a\nb")).toBe('"a\nb"');
    expect(csvCell("plain")).toBe("plain");
  });
});

describe("helpers", () => {
  it("filename", () => {
    expect(distributionCsvFilename(1, "2027-05-14")).toBe(
      "distribution-1-2027-05-14.csv",
    );
  });

  it("noticeSkipReason", () => {
    const base = { noticeSentAt: null, grossCents: 100n, email: "a@b.c" };
    expect(noticeSkipReason(base)).toBeNull();
    expect(noticeSkipReason({ ...base, noticeSentAt: new Date(0) })).toBe(
      "ALREADY_SENT",
    );
    expect(noticeSkipReason({ ...base, grossCents: 0n })).toBe(
      "NOTHING_DISTRIBUTED",
    );
    expect(noticeSkipReason({ ...base, email: null })).toBe("NO_EMAIL");
  });
});

describe("resendSkipReason", () => {
  const now = new Date("2027-07-20T12:00:00.000Z");
  const sent = {
    noticeSentAt: new Date("2027-07-16T09:00:00.000Z"),
    noticeEmailLogId: "log1",
    noticeSendCount: 1,
    noticeResendingAt: null,
    grossCents: 100n,
    email: "a@example.com",
  };
  it("a sent line with the count the Manager saw may be re-sent", () => {
    expect(resendSkipReason(sent, 1, now)).toBeNull();
  });
  it("a line never sent is refused (use Send notices)", () => {
    expect(resendSkipReason({ ...sent, noticeSentAt: null }, 1, now)).toBe(
      "NOT_SENT",
    );
  });
  it("a double click: the second request names a count that moved on", () => {
    expect(resendSkipReason({ ...sent, noticeSendCount: 2 }, 1, now)).toBe(
      "ALREADY_RESENT",
    );
  });
  it("a re-send in flight is not raced; a stale claim (crash) may be taken over", () => {
    const claimed = {
      ...sent,
      noticeResendingAt: new Date(now.getTime() - 30_000),
    };
    expect(resendSkipReason(claimed, 1, now)).toBe("RESEND_IN_FLIGHT");
    const stale = {
      ...sent,
      noticeResendingAt: new Date(now.getTime() - NOTICE_CLAIM_STALE_MS),
    };
    expect(resendSkipReason(stale, 1, now)).toBeNull();
  });
  it("a first send still in flight is not raced; one that crashed long ago may be re-sent", () => {
    const claiming = {
      ...sent,
      noticeEmailLogId: null,
      noticeSendCount: 0,
      noticeSentAt: new Date(now.getTime() - 10_000),
    };
    expect(resendSkipReason(claiming, 0, now)).toBe("FIRST_SEND_IN_FLIGHT");
    expect(
      resendSkipReason(
        { ...claiming, noticeSentAt: new Date("2027-07-16T09:00:00.000Z") },
        0,
        now,
      ),
    ).toBeNull();
  });
  it("nothing distributed or no address: refused as for the first send", () => {
    expect(resendSkipReason({ ...sent, grossCents: 0n }, 1, now)).toBe(
      "NOTHING_DISTRIBUTED",
    );
    expect(resendSkipReason({ ...sent, email: null }, 1, now)).toBe("NO_EMAIL");
  });
});
