import { describe, expect, it } from "vitest";
import { type PacketStageInput, packetStage } from "./packet-stage";

const base: PacketStageInput = {
  templateStatus: "PENDING",
  investorStatus: "SENT",
  managerStatus: "PENDING",
  commitmentStatus: null,
};

describe("packetStage", () => {
  it("CANCELLED: template cancelled, commitment not rejected", () => {
    expect(packetStage({ ...base, templateStatus: "CANCELLED" })).toBe(
      "CANCELLED",
    );
  });

  it("REJECTED: commitment rejected", () => {
    expect(
      packetStage({
        ...base,
        investorStatus: "SIGNED",
        commitmentStatus: "REJECTED",
      }),
    ).toBe("REJECTED");
  });

  it("COMPLETE: template complete", () => {
    expect(
      packetStage({
        templateStatus: "COMPLETE",
        investorStatus: "SIGNED",
        managerStatus: "SIGNED",
        commitmentStatus: "ACCEPTED",
      }),
    ).toBe("COMPLETE");
  });

  it("AWAITING_INVESTOR: investor not signed", () => {
    expect(packetStage(base)).toBe("AWAITING_INVESTOR");
  });

  it("AWAITING_REVIEW: investor signed, no commitment", () => {
    expect(packetStage({ ...base, investorStatus: "SIGNED" })).toBe(
      "AWAITING_REVIEW",
    );
  });

  it("AWAITING_COUNTERSIGN: commitment accepted, manager not signed", () => {
    expect(
      packetStage({
        ...base,
        investorStatus: "SIGNED",
        commitmentStatus: "ACCEPTED",
      }),
    ).toBe("AWAITING_COUNTERSIGN");
  });

  it("FINALISING: manager signed, template still pending", () => {
    expect(
      packetStage({
        templateStatus: "PENDING",
        investorStatus: "SIGNED",
        managerStatus: "SIGNED",
        commitmentStatus: "ACCEPTED",
      }),
    ).toBe("FINALISING");
  });

  it("investor signed + commitment REDUCED + manager SENT → AWAITING_COUNTERSIGN", () => {
    expect(
      packetStage({
        templateStatus: "PENDING",
        investorStatus: "SIGNED",
        managerStatus: "SENT",
        commitmentStatus: "REDUCED",
      }),
    ).toBe("AWAITING_COUNTERSIGN");
  });

  it("template CANCELLED + commitment REJECTED → REJECTED", () => {
    expect(
      packetStage({
        templateStatus: "CANCELLED",
        investorStatus: "SIGNED",
        managerStatus: "PENDING",
        commitmentStatus: "REJECTED",
      }),
    ).toBe("REJECTED");
  });

  it("AWAITING_REVIEW: investor signed, commitment PENDING", () => {
    expect(
      packetStage({
        ...base,
        investorStatus: "SIGNED",
        commitmentStatus: "PENDING",
      }),
    ).toBe("AWAITING_REVIEW");
  });
});
