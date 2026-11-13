import { describe, expect, it } from "vitest";
import {
  admissionErrors,
  type CompletionContext,
  completionErrors,
  initialFlags,
  type TransferState,
} from "./transfer-core";

// 03-governance.md G16, tests (1)–(10), plus `initialFlags`.

const CONSENT = "The Manager's written consent is required (Section 7.1).";
const ROFR_OUTCOME =
  "Record the outcome of the right of first refusal (Section 7.1).";
const ROFR_EARLY =
  "The 90-day refusal period has not ended. Add a note that every holder of the right waived it in writing.";
const CLOSE_BY =
  "The 180-day period to complete the transfer has ended (Section 7.1). A new Transfer Notice is required.";
const NOTICE_DATE =
  "Enter the date the Manager received written notice of the transfer (Section 7.9.1).";
const OPINION =
  "Record the opinion of counsel or the Manager's waiver (Section 7.6).";
const COMMON =
  "A transfer of Common Units requires the approval of a Preferred Supermajority (Section 7.1).";
const ALREADY_MEMBER =
  "The transferee is already a Member: complete the admission checklist for these Units (Section 7.8) before completing.";

/** (1): a VOLUNTARY transfer with every step in order (dates of G3 test 11). */
function voluntary(overrides: Partial<TransferState> = {}): TransferState {
  return {
    kind: "VOLUNTARY",
    status: "OPEN",
    fromStakeholderId: "carol",
    toStakeholderId: "dave",
    unitClassKind: "PREFERRED",
    units: "50.000000",
    noticeReceivedOn: "2027-03-01",
    noticeCopyDueOn: "2027-03-08",
    managerRofrEndsOn: "2027-04-15",
    memberRofrEndsOn: "2027-05-30",
    closeByOn: "2027-11-26",
    rofrOutcome: "NOT_EXERCISED",
    rofrDecidedOn: "2027-05-31",
    rofrNote: null,
    managerConsent: "GRANTED",
    securitiesOpinion: "WAIVED",
    priceEstablishedOn: null,
    purchaseCloseByOn: null,
    transferNoticeOn: "2027-06-10",
    effectiveOn: "2027-07-01",
    exemptUnder71: false,
    exemptNote: null,
    admissionSignaturePage: false,
    admissionExpensesPaid: false,
    admissionQualified: false,
    admissionManagerConsent: false,
    admittedOn: null,
    ...overrides,
  };
}

function context(
  overrides: Partial<CompletionContext> = {},
): CompletionContext {
  return {
    today: "2027-06-15",
    fromUnits: "150.000000",
    toMemberStatus: "PROSPECT",
    linkedResolution: null,
    ...overrides,
  };
}

/** A transfer with nothing but transferee, units and notice date (no 7.1 steps). */
function bare(
  kind: TransferState["kind"],
  overrides: Partial<TransferState> = {},
): TransferState {
  return voluntary({
    kind,
    ...initialFlags(kind),
    noticeCopyDueOn: null,
    managerRofrEndsOn: null,
    memberRofrEndsOn: null,
    closeByOn: null,
    rofrDecidedOn: null,
    securitiesOpinion: null,
    ...overrides,
  });
}

describe("completionErrors", () => {
  it("(1) a VOLUNTARY transfer fully in order may complete", () => {
    expect(completionErrors(voluntary(), context())).toEqual([]);
  });

  it("(2) without the Manager's consent: one error", () => {
    expect(
      completionErrors(voluntary({ managerConsent: "PENDING" }), context()),
    ).toEqual([CONSENT]);
  });

  it("(3) ROFR decided before the 90 days ended needs the waiver note", () => {
    expect(
      completionErrors(voluntary({ rofrDecidedOn: "2027-04-01" }), context()),
    ).toEqual([ROFR_EARLY]);
    expect(
      completionErrors(
        voluntary({
          rofrDecidedOn: "2027-04-01",
          rofrNote: "Every Preferred Member waived in writing on 2027-03-31.",
        }),
        context(),
      ),
    ).toEqual([]);
  });

  it("(3a) NOT_EXERCISED without a decision date fails closed", () => {
    expect(
      completionErrors(voluntary({ rofrDecidedOn: null }), context()),
    ).toEqual([
      "Enter the date the right of first refusal was decided (Section 7.1).",
    ]);
  });

  it("(4) written notice after the 180-day period", () => {
    expect(
      completionErrors(
        voluntary({
          transferNoticeOn: "2027-12-01",
          effectiveOn: "2028-01-01",
        }),
        context({ today: "2027-12-02" }),
      ),
    ).toEqual([CLOSE_BY]);
  });

  it("(5) more units than the transferor holds", () => {
    expect(
      completionErrors(voluntary({ units: "200.000000" }), context()),
    ).toEqual(["The transferor holds only 150 units."]);
  });

  it("(6) PERMITTED_TRANSFEREE needs no consent and no ROFR, only the opinion", () => {
    const t = bare("PERMITTED_TRANSFEREE", { securitiesOpinion: "RECEIVED" });
    expect(t.managerConsent).toBe("NOT_REQUIRED");
    expect(t.rofrOutcome).toBe("NOT_APPLICABLE");
    expect(completionErrors(t, context())).toEqual([]);
    expect(
      completionErrors(
        bare("PERMITTED_TRANSFEREE", { securitiesOpinion: null }),
        context(),
      ),
    ).toEqual([OPINION]);
  });

  it("(7) DEATH_INCAPACITY with transferee, units and notice date only", () => {
    expect(completionErrors(bare("DEATH_INCAPACITY"), context())).toEqual([]);
  });

  it("(8) COMMON units need a Supermajority resolution or the 7.1 exemption", () => {
    const t = voluntary({ unitClassKind: "COMMON" });
    expect(completionErrors(t, context())).toEqual([COMMON]);
    expect(
      completionErrors(
        t,
        context({
          linkedResolution: {
            status: "EFFECTIVE",
            matterKey: "COMMON_TRANSFER_OR_CONTROL",
          },
        }),
      ),
    ).toEqual([]);
    // Not yet effective, or another matter: still blocked.
    expect(
      completionErrors(
        t,
        context({
          linkedResolution: {
            status: "SENT",
            matterKey: "COMMON_TRANSFER_OR_CONTROL",
          },
        }),
      ),
    ).toEqual([COMMON]);
    expect(
      completionErrors(
        t,
        context({
          linkedResolution: { status: "EFFECTIVE", matterKey: "OTHER" },
        }),
      ),
    ).toEqual([COMMON]);
    // Exemption needs its note.
    expect(completionErrors({ ...t, exemptUnder71: true }, context())).toEqual([
      COMMON,
    ]);
    expect(
      completionErrors(
        { ...t, exemptUnder71: true, exemptNote: "To Isaac Reid." },
        context(),
      ),
    ).toEqual([]);
  });

  it("(9) a transferee who is already a Member needs the admission checklist", () => {
    expect(
      completionErrors(voluntary(), context({ toMemberStatus: "MEMBER" })),
    ).toEqual([ALREADY_MEMBER]);
    expect(
      completionErrors(
        voluntary({
          admissionSignaturePage: true,
          admissionExpensesPaid: true,
          admissionQualified: true,
          admissionManagerConsent: true,
        }),
        context({ toMemberStatus: "MEMBER" }),
      ),
    ).toEqual([]);
  });

  it("a fresh VOLUNTARY transfer reports consent, ROFR, notice date and opinion together", () => {
    const fresh = voluntary({
      ...initialFlags("VOLUNTARY"),
      rofrDecidedOn: null,
      securitiesOpinion: null,
      transferNoticeOn: null,
      effectiveOn: null,
    });
    expect(completionErrors(fresh, context())).toEqual([
      NOTICE_DATE,
      CONSENT,
      ROFR_OUTCOME,
      OPINION,
    ]);
  });

  it("closed, missing transferee, same party, future notice date", () => {
    expect(
      completionErrors(voluntary({ status: "COMPLETED" }), context()),
    ).toEqual(["This transfer is closed."]);
    expect(
      completionErrors(voluntary({ toStakeholderId: null }), context()),
    ).toEqual(["Select the transferee."]);
    expect(
      completionErrors(voluntary({ toStakeholderId: "carol" }), context()),
    ).toEqual(["Transferor and transferee must differ."]);
    expect(
      completionErrors(voluntary(), context({ today: "2027-06-09" })),
    ).toEqual(["The notice date cannot be in the future."]);
  });
});

describe("admissionErrors", () => {
  it("(10) PERMITTED_TRANSFEREE ignores the Manager's consent (7.1)", () => {
    const base = {
      admissionSignaturePage: true,
      admissionExpensesPaid: true,
      admissionQualified: true,
      admissionManagerConsent: false,
    };
    expect(admissionErrors(bare("PERMITTED_TRANSFEREE", base))).toEqual([]);
    expect(admissionErrors(voluntary(base))).toEqual([
      "Manager consent to admission not recorded (7.8(d)).",
    ]);
    expect(admissionErrors(voluntary())).toEqual([
      "Exhibit B signature page not received (7.8(a)).",
      "Admission expenses not paid or waived (7.8(b)).",
      "Qualification not confirmed (7.8(c)).",
      "Manager consent to admission not recorded (7.8(d)).",
    ]);
  });
});

describe("initialFlags", () => {
  it("follows Sections 7.1–7.3", () => {
    expect(initialFlags("VOLUNTARY")).toEqual({
      rofrOutcome: "PENDING",
      managerConsent: "PENDING",
    });
    expect(initialFlags("INVOLUNTARY")).toEqual({
      rofrOutcome: "PENDING",
      managerConsent: "NOT_REQUIRED",
    });
    expect(initialFlags("PERMITTED_TRANSFEREE")).toEqual({
      rofrOutcome: "NOT_APPLICABLE",
      managerConsent: "NOT_REQUIRED",
    });
    expect(initialFlags("DEATH_INCAPACITY")).toEqual({
      rofrOutcome: "NOT_APPLICABLE",
      managerConsent: "NOT_REQUIRED",
    });
  });
});
