import { describe, expect, it } from "vitest";
import {
  type CommitmentRow,
  mergePositions,
  type ReceiptGroup,
  sumPositions,
} from "./positions-merge";

const $ = (dollars: number) => BigInt(Math.round(dollars * 100));

const commitment = (over: Partial<CommitmentRow> = {}): CommitmentRow => ({
  id: "c1",
  stakeholderId: "s1",
  unitClassId: "pref",
  classKind: "PREFERRED",
  status: "ACCEPTED",
  committedCents: $(250_000),
  acceptedCents: $(250_000),
  acceptedOn: "2026-11-13",
  ...over,
});

const receipt = (over: Partial<ReceiptGroup> = {}): ReceiptGroup => ({
  commitmentId: "c1",
  kind: "INITIAL",
  amountCents: 0n,
  appliedCents: 0n,
  units: "0.000000",
  ...over,
});

describe("mergePositions", () => {
  it("accepted 250,000 with 100,000 + 150,000 applied", () => {
    const [p, ...rest] = mergePositions(
      [commitment()],
      [
        receipt({
          kind: "INITIAL",
          amountCents: $(100_000),
          appliedCents: $(100_000),
          units: "100.000000",
        }),
        receipt({
          kind: "BALANCE",
          amountCents: $(150_000),
          appliedCents: $(150_000),
          units: "150.000000",
        }),
      ],
    );
    expect(rest).toHaveLength(0);
    expect(p).toEqual({
      stakeholderId: "s1",
      unitClassId: "pref",
      kind: "PREFERRED",
      committedCents: $(250_000),
      pendingCommittedCents: 0n,
      heldCents: 0n,
      cashAppliedCents: $(250_000),
      capitalCents: $(250_000),
      units: "250.000000",
      outstandingBalanceCents: 0n,
      firstAcceptedOn: "2026-11-13",
    });
  });

  it("a CREDIT of 5,000 adds capital and units but not cash applied", () => {
    const [p] = mergePositions(
      [commitment()],
      [
        receipt({
          kind: "INITIAL",
          amountCents: $(100_000),
          appliedCents: $(100_000),
          units: "100.000000",
        }),
        receipt({
          kind: "BALANCE",
          amountCents: $(150_000),
          appliedCents: $(150_000),
          units: "150.000000",
        }),
        receipt({
          kind: "CREDIT",
          appliedCents: $(5_000),
          units: "5.000000",
        }),
      ],
    );
    expect(p?.capitalCents).toBe($(255_000));
    expect(p?.cashAppliedCents).toBe($(250_000));
    expect(p?.outstandingBalanceCents).toBe(0n);
    expect(p?.units).toBe("255.000000");
  });

  it("a FORFEITURE of -20,000 on accepted 100,000 with 40,000 paid", () => {
    const [p] = mergePositions(
      [
        commitment({
          committedCents: $(100_000),
          acceptedCents: $(100_000),
        }),
      ],
      [
        receipt({
          kind: "INITIAL",
          amountCents: $(40_000),
          appliedCents: $(40_000),
          units: "40.000000",
        }),
        receipt({
          kind: "FORFEITURE",
          appliedCents: -$(20_000),
          units: "-20.000000",
        }),
      ],
    );
    expect(p?.capitalCents).toBe($(20_000));
    expect(p?.units).toBe("20.000000");
    expect(p?.outstandingBalanceCents).toBe($(60_000));
    expect(p?.cashAppliedCents).toBe($(40_000));
  });

  it("voided receipts are excluded by the query, so none are passed", () => {
    const [p] = mergePositions([commitment()], []);
    expect(p?.capitalCents).toBe(0n);
    expect(p?.units).toBe("0.000000");
    expect(p?.outstandingBalanceCents).toBe($(250_000));
  });

  it("held cash and pending amounts come from PENDING commitments only", () => {
    const rows = mergePositions(
      [
        commitment({
          id: "p1",
          status: "PENDING",
          acceptedCents: 0n,
          acceptedOn: null,
        }),
        commitment({
          id: "r1",
          stakeholderId: "s2",
          status: "REJECTED",
          committedCents: $(100_000),
          acceptedCents: 0n,
          acceptedOn: "2026-11-14",
        }),
      ],
      [
        receipt({ commitmentId: "p1", amountCents: $(100_000) }),
        receipt({ commitmentId: "r1", amountCents: $(40_000) }),
      ],
    );
    expect(rows).toHaveLength(2);
    const [pending, rejected] = rows;
    expect(pending?.pendingCommittedCents).toBe($(250_000));
    expect(pending?.heldCents).toBe($(100_000));
    expect(pending?.committedCents).toBe(0n);
    expect(pending?.firstAcceptedOn).toBeNull();
    expect(rejected?.heldCents).toBe(0n);
    expect(rejected?.committedCents).toBe(0n);
    expect(rejected?.outstandingBalanceCents).toBe(0n);
  });

  it("asOf drops commitments accepted later and never counts rejected ones", () => {
    const rows = mergePositions(
      [
        commitment({ acceptedOn: "2026-11-20" }),
        commitment({
          id: "r1",
          stakeholderId: "s2",
          status: "REJECTED",
          acceptedCents: 0n,
          acceptedOn: "2026-11-10",
        }),
      ],
      [],
      { asOf: "2026-11-15" },
    );
    expect(rows).toHaveLength(0);
  });

  it("sums fractional units exactly and totals a class", () => {
    const rows = mergePositions(
      [
        commitment(),
        commitment({
          id: "c2",
          stakeholderId: "s2",
          committedCents: $(100_000),
          acceptedCents: $(100_000),
          acceptedOn: "2026-11-12",
        }),
      ],
      [
        receipt({
          appliedCents: 4_020_000n,
          amountCents: 4_020_000n,
          units: "40.200000",
        }),
        receipt({
          appliedCents: 1n,
          amountCents: 1n,
          units: "0.000010",
        }),
        receipt({
          commitmentId: "c2",
          appliedCents: $(40_000),
          amountCents: $(40_000),
          units: "40.000000",
        }),
      ],
    );
    expect(rows[0]?.units).toBe("40.200010");
    expect(sumPositions(rows)).toEqual({
      committedCents: $(350_000),
      pendingCommittedCents: 0n,
      cashAppliedCents: 8_020_001n,
      capitalCents: 8_020_001n,
      units: "80.200010",
      outstandingBalanceCents: $(350_000) - 8_020_001n,
    });
  });

  it("throws when a receipt group has no loaded commitment", () => {
    expect(() => mergePositions([], [receipt()])).toThrow();
  });
});
