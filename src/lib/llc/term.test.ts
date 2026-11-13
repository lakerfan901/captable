import { describe, expect, it } from "vitest";
import { OA_DEFAULTS } from "./config";
import { LlcMathError } from "./money";
import {
  computeTermClock,
  consentDeemedAgainstOn,
  distributionDeadline,
  isBeforeTargetSaleDate,
  quarterlyDeadlines,
} from "./term";

const cfg = OA_DEFAULTS;

describe("computeTermClock", () => {
  it("TC-1", () => {
    const c = computeTermClock(
      {
        operationsCommencementDate: "2027-02-15",
        extensionsApproved: 0,
        loiExtensionDays: 0,
      },
      cfg,
    );
    expect(c.ocdNoticeDueOn).toBe("2027-03-01");
    expect(c.baseTargetSaleDate).toBe("2032-02-15");
    expect(c.extendedTargetSaleDate).toBe("2032-02-15");
    expect(c.effectiveTargetSaleDate).toBe("2032-02-15");
    expect(c.extensionRequestDueOn).toBe("2031-05-15");
    expect(c.loiExtensionMaxDate).toBe("2032-08-13");
    expect(c.dissolutionElectionAvailableAfter).toBe("2032-08-13");
    expect(c.nextExtensionTargetSaleDate).toBe("2033-02-15");
  });

  it("TC-2", () => {
    const c = computeTermClock(
      {
        operationsCommencementDate: "2027-02-15",
        extensionsApproved: 1,
        loiExtensionDays: 0,
      },
      cfg,
    );
    expect(c.extendedTargetSaleDate).toBe("2033-02-15");
    expect(c.extensionRequestDueOn).toBe("2032-05-15");
  });

  it("TC-3", () => {
    const c = computeTermClock(
      {
        operationsCommencementDate: "2027-02-15",
        extensionsApproved: 0,
        loiExtensionDays: 120,
      },
      cfg,
    );
    expect(c.effectiveTargetSaleDate).toBe("2032-06-14");
    expect(c.dissolutionElectionAvailableAfter).toBe("2032-12-11");
    expect(c.extensionRequestDueOn).toBe("2031-05-15");
  });

  it("TC-4", () => {
    const c = computeTermClock(
      {
        operationsCommencementDate: "2028-02-29",
        extensionsApproved: 0,
        loiExtensionDays: 0,
      },
      cfg,
    );
    expect(c.baseTargetSaleDate).toBe("2033-02-28");
  });

  it("TC-5", () => {
    const c = computeTermClock(
      {
        operationsCommencementDate: null,
        extensionsApproved: 0,
        loiExtensionDays: 0,
      },
      cfg,
    );
    const { extensionsApproved, ...dates } = c;
    expect(extensionsApproved).toBe(0);
    for (const v of Object.values(dates)) expect(v).toBeNull();
  });

  it("LOI days outside 0..max throws", () => {
    for (const loiExtensionDays of [-1, 181]) {
      expect(() =>
        computeTermClock(
          {
            operationsCommencementDate: "2027-02-15",
            extensionsApproved: 0,
            loiExtensionDays,
          },
          cfg,
        ),
      ).toThrow(LlcMathError);
    }
  });

  it("TC-6 consentDeemedAgainstOn", () => {
    expect(consentDeemedAgainstOn("2031-05-01", cfg)).toBe("2031-05-31");
  });

  it("isBeforeTargetSaleDate", () => {
    const c = computeTermClock(
      {
        operationsCommencementDate: "2027-02-15",
        extensionsApproved: 0,
        loiExtensionDays: 0,
      },
      cfg,
    );
    expect(isBeforeTargetSaleDate("2032-02-14", c)).toBe(true);
    expect(isBeforeTargetSaleDate("2032-02-15", c)).toBe(false);
    const none = computeTermClock(
      {
        operationsCommencementDate: null,
        extensionsApproved: 0,
        loiExtensionDays: 0,
      },
      cfg,
    );
    expect(isBeforeTargetSaleDate("2030-01-01", none)).toBeNull();
  });
});

describe("deadlines", () => {
  it("DL-1", () => {
    expect(distributionDeadline("2027-03-31", cfg)).toBe("2027-05-15");
    expect(distributionDeadline("2027-06-30", cfg)).toBe("2027-08-14");
    expect(distributionDeadline("2027-09-30", cfg)).toBe("2027-11-14");
    expect(distributionDeadline("2027-12-31", cfg)).toBe("2028-02-14");
  });

  it("DL-2", () => {
    const rows = quarterlyDeadlines("2027-01-01", "2027-12-31", cfg);
    expect(rows.map((r) => r.label)).toEqual([
      "Q1 2027",
      "Q2 2027",
      "Q3 2027",
      "Q4 2027",
    ]);
    expect(rows[0]).toEqual({
      quarterEnd: "2027-03-31",
      deadline: "2027-05-15",
      label: "Q1 2027",
    });
  });
});
