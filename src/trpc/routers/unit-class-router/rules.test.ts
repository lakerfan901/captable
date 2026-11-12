import { describe, expect, it } from "vitest";
import {
  LOCKED_TERMS_MESSAGE,
  type UnitClassCurrent,
  type UnitClassUpdate,
  validateUnitClassUpdate,
} from "./rules";

const preferred: UnitClassCurrent = {
  kind: "PREFERRED",
  name: "Preferred Units",
  pricePerUnitCents: 100000,
  authorizedUnits: null,
  fractionalUnitsAllowed: true,
  votesPerUnit: "1.000000",
  prefReturnBps: 800,
  balanceReturnStartRule: "LATER_OF_RECEIPT_AND_DUE",
  residualSplitBps: 7000,
  minCommitmentCents: 10000000,
  minCommitmentFloorCents: 5000000,
  offeringCapCents: 200000000,
  initialInstallmentBps: 4000,
  finalClosingDate: null,
  balanceOutsideDate: null,
  acceptanceBusinessDays: 10,
  refundBusinessDays: 5,
  issuedUnits: "0.000000",
  termsLocked: false,
};

const common: UnitClassCurrent = {
  ...preferred,
  kind: "COMMON",
  name: "Common Units",
  pricePerUnitCents: null,
  authorizedUnits: "100.000000",
  votesPerUnit: "0.000000",
  prefReturnBps: 0,
  residualSplitBps: 3000,
  minCommitmentCents: null,
  minCommitmentFloorCents: null,
  offeringCapCents: null,
  issuedUnits: "100.000000",
};

function update(
  current: UnitClassCurrent,
  patch: Partial<UnitClassUpdate>,
): UnitClassUpdate {
  const { kind: _k, issuedUnits: _i, termsLocked: _t, ...terms } = current;
  return { ...terms, ...patch };
}

describe("validateUnitClassUpdate", () => {
  it("accepts floor 5,000,000 / min 10,000,000 / cap 200,000,000", () => {
    expect(
      validateUnitClassUpdate(
        preferred,
        update(preferred, {
          minCommitmentFloorCents: 5000000,
          minCommitmentCents: 10000000,
          offeringCapCents: 200000000,
        }),
      ),
    ).toBeNull();
  });

  it("rejects floor 10,000,001 above min 10,000,000", () => {
    expect(
      validateUnitClassUpdate(
        preferred,
        update(preferred, {
          minCommitmentFloorCents: 10000001,
          minCommitmentCents: 10000000,
        }),
      ),
    ).not.toBeNull();
  });

  it("accepts closing 2026-11-30 with outside 2027-03-31", () => {
    expect(
      validateUnitClassUpdate(
        preferred,
        update(preferred, {
          finalClosingDate: "2026-11-30",
          balanceOutsideDate: "2027-03-31",
        }),
      ),
    ).toBeNull();
  });

  it("rejects closing 2027-04-01 after outside 2027-03-31", () => {
    expect(
      validateUnitClassUpdate(
        preferred,
        update(preferred, {
          finalClosingDate: "2027-04-01",
          balanceOutsideDate: "2027-03-31",
        }),
      ),
    ).not.toBeNull();
  });

  describe("locked terms", () => {
    const locked: UnitClassCurrent = { ...preferred, termsLocked: true };

    it("rejects prefReturnBps 800 → 900 without confirmation", () => {
      expect(
        validateUnitClassUpdate(locked, update(locked, { prefReturnBps: 900 })),
      ).toBe(LOCKED_TERMS_MESSAGE);
    });

    it("accepts prefReturnBps 800 → 900 with confirmation and a 10-character reason", () => {
      expect(
        validateUnitClassUpdate(
          locked,
          update(locked, {
            prefReturnBps: 900,
            confirmAmendment: true,
            amendmentReason: "1234567890",
          }),
        ),
      ).toBeNull();
    });

    it("accepts a name change only", () => {
      expect(
        validateUnitClassUpdate(
          locked,
          update(locked, { name: "Series P Units" }),
        ),
      ).toBeNull();
    });
  });

  it("rejects COMMON with pricePerUnitCents 100000", () => {
    expect(
      validateUnitClassUpdate(
        common,
        update(common, { pricePerUnitCents: 100000 }),
      ),
    ).not.toBeNull();
  });

  it('rejects COMMON authorizedUnits "50" with issued "100.000000"', () => {
    expect(
      validateUnitClassUpdate(
        common,
        update(common, { authorizedUnits: "50" }),
      ),
    ).toBe("Cannot authorize fewer units than are issued");
  });
});
