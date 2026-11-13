/**
 * G16b: the transfer fold-in of `getMemberPositions` (`foldTransfers`, pure).
 * The database-bound checks are in
 * src/server/llc/__integration__/transfers.integration.ts.
 */
import { describe, expect, it } from "vitest";
import {
  type FoldTransfer,
  foldTransfers,
  type MemberPosition,
} from "./positions";

const P = "class-preferred";
const C = "class-common";

function pos(
  stakeholderId: string,
  units: string,
  capitalCents: bigint,
  extra: Partial<MemberPosition> = {},
): MemberPosition {
  return {
    stakeholderId,
    unitClassId: P,
    kind: "PREFERRED",
    committedCents: capitalCents,
    pendingCommittedCents: 0n,
    heldCents: 0n,
    cashAppliedCents: capitalCents,
    capitalCents,
    units,
    outstandingBalanceCents: 0n,
    firstAcceptedOn: "2026-11-16",
    ...extra,
  };
}

function transfer(
  id: string,
  from: string,
  to: string,
  units: string,
  effectiveOn: string,
  completedAt = "2026-12-01T12:00:00Z",
  unitClassId = P,
): FoldTransfer {
  return {
    id,
    fromStakeholderId: from,
    toStakeholderId: to,
    unitClassId,
    units,
    effectiveOn,
    completedAt: new Date(completedAt),
  };
}

const usd = (dollars: number) => BigInt(Math.round(dollars * 100));
const find = (rows: MemberPosition[], id: string, cls = P) =>
  rows.find((r) => r.stakeholderId === id && r.unitClassId === cls);

describe("foldTransfers", () => {
  const carol = pos("carol", "150.000000", usd(150_000), {
    committedCents: usd(250_000),
    outstandingBalanceCents: usd(100_000),
  });
  const base = () => [carol];
  const t1 = transfer("t1", "carol", "dave", "50.000000", "2027-07-01");

  it("returns the positions untouched without transfers in scope", () => {
    const rows = [carol];
    expect(foldTransfers(rows, [], base, "2027-12-31")).toBe(rows);
    // as of 2027-06-30 the transfer effective 2027-07-01 does not count
    const before = foldTransfers(rows, [t1], base, "2027-06-30");
    expect(before).toBe(rows);
    expect(find(before, "carol")?.units).toBe("150.000000");
    expect(find(before, "dave")).toBeUndefined();
  });

  it("moves 50 of carol's 150 units effective 2027-07-01 (plan example)", () => {
    const rows = foldTransfers([carol], [t1], base, "2027-07-01");
    const c = find(rows, "carol");
    const d = find(rows, "dave");
    expect(c?.units).toBe("100.000000");
    expect(c?.capitalCents).toBe(usd(100_000));
    expect(c?.cashAppliedCents).toBe(usd(100_000));
    // committed and the outstanding Balance stay with the transferor (7.9.2)
    expect(c?.committedCents).toBe(usd(250_000));
    expect(c?.outstandingBalanceCents).toBe(usd(100_000));
    expect(d).toEqual({
      stakeholderId: "dave",
      unitClassId: P,
      kind: "PREFERRED",
      committedCents: 0n,
      pendingCommittedCents: 0n,
      heldCents: 0n,
      cashAppliedCents: usd(50_000),
      capitalCents: usd(50_000),
      units: "50.000000",
      outstandingBalanceCents: 0n,
      firstAcceptedOn: null,
    });
    expect(rows.map((r) => r.stakeholderId)).toEqual(["carol", "dave"]);
  });

  it("a second transfer of 25.5 of carol's remaining 100 leaves 74.5 / $74,500.00", () => {
    const t2 = transfer("t2", "carol", "erin", "25.500000", "2027-08-01");
    const rows = foldTransfers([carol], [t2, t1], base, "2027-08-01");
    expect(find(rows, "carol")?.units).toBe("74.500000");
    expect(find(rows, "carol")?.capitalCents).toBe(usd(74_500));
    expect(find(rows, "dave")?.units).toBe("50.000000");
    expect(find(rows, "erin")?.units).toBe("25.500000");
    expect(find(rows, "erin")?.capitalCents).toBe(usd(25_500));
  });

  it("chained same-day transfers apply by completion time, whatever the input order", () => {
    const a = pos("a", "100.000000", usd(100_000));
    const ab = transfer(
      "zz-ab",
      "a",
      "b",
      "40.000000",
      "2027-01-01",
      "2026-12-02T10:00:00Z",
    );
    const bc = transfer(
      "aa-bc",
      "b",
      "c",
      "15.000000",
      "2027-01-01",
      "2026-12-02T11:00:00Z",
    );
    const one = foldTransfers([a], [ab, bc], () => [a], "2027-01-01");
    const two = foldTransfers([a], [bc, ab], () => [a], "2027-01-01");
    expect(two).toEqual(one);
    expect(find(one, "a")?.units).toBe("60.000000");
    expect(find(one, "b")?.units).toBe("25.000000");
    expect(find(one, "b")?.capitalCents).toBe(usd(25_000));
    expect(find(one, "c")?.units).toBe("15.000000");
    expect(find(one, "c")?.capitalCents).toBe(usd(15_000));
    // B → C completed before A → B: B holds nothing yet
    const early = { ...bc, completedAt: new Date("2026-12-02T09:00:00Z") };
    expect(() =>
      foldTransfers([a], [ab, early], () => [a], "2027-01-01"),
    ).toThrow(/ledger data integrity/);
  });

  it("same date and completion time: id breaks the tie", () => {
    const a = pos("a", "10.000000", usd(10_000));
    const x = transfer("x", "a", "b", "10.000000", "2027-01-01");
    const y = transfer("y", "b", "c", "10.000000", "2027-01-01");
    const rows = foldTransfers([a], [y, x], () => [a], "2027-01-01");
    expect(find(rows, "c")?.units).toBe("10.000000");
    expect(find(rows, "a")?.units).toBe("0.000000");
  });

  it("pro rata on the balances at the transfer, not at asOf (later receipts stay with the transferor)", () => {
    // At the transfer: 3 units / 100 cents. By asOf a later receipt brought
    // 3 more units and 150 cents.
    const atEvent = pos("a", "3.000000", 100n);
    const later = pos("a", "6.000000", 250n);
    const t = transfer("t", "a", "b", "1.000000", "2027-01-01");
    const rows = foldTransfers([later], [t], () => [atEvent], "2027-03-01");
    expect(find(rows, "b")?.capitalCents).toBe(33n); // roundDiv(100 × 1, 3)
    expect(find(rows, "a")?.capitalCents).toBe(217n);
    expect(find(rows, "a")?.units).toBe("5.000000");
  });

  it("rounds half up like ECONOMICS roundDiv", () => {
    const a = pos("a", "3.000000", 101n, { cashAppliedCents: 1n });
    const t = transfer("t", "a", "b", "1.500000", "2027-01-01");
    const rows = foldTransfers([a], [t], () => [a], "2027-01-01");
    expect(find(rows, "b")?.capitalCents).toBe(51n); // 50.5 → 51
    expect(find(rows, "b")?.cashAppliedCents).toBe(1n); // 0.5 → 1
    expect(find(rows, "a")?.capitalCents).toBe(50n);
  });

  it("other classes and holders are untouched", () => {
    const common = pos("a", "5.000000", 0n, {
      unitClassId: C,
      kind: "COMMON",
    });
    const pref = pos("a", "10.000000", usd(10_000));
    const other = pos("z", "7.000000", usd(7_000));
    const t = transfer("t", "a", "b", "10.000000", "2027-01-01");
    const rows = foldTransfers(
      [pref, common, other],
      [t],
      () => [pref, common, other],
      "2027-01-01",
    );
    expect(find(rows, "a", C)).toBe(common);
    expect(find(rows, "z")).toBe(other);
    expect(find(rows, "a")?.units).toBe("0.000000");
    expect(find(rows, "b")?.units).toBe("10.000000");
  });

  it("a Common transfer moves Common units only", () => {
    const common = pos("a", "5.000000", 0n, {
      unitClassId: C,
      kind: "COMMON",
    });
    const t = transfer("t", "a", "b", "2.000000", "2027-01-01", undefined, C);
    const rows = foldTransfers([common], [t], () => [common], "2027-01-01");
    expect(find(rows, "b", C)?.kind).toBe("COMMON");
    expect(find(rows, "b", C)?.units).toBe("2.000000");
    expect(find(rows, "a", C)?.units).toBe("3.000000");
  });

  it("throws when the transferor holds fewer units or none", () => {
    const a = pos("a", "10.000000", usd(10_000));
    expect(() =>
      foldTransfers(
        [a],
        [transfer("t", "a", "b", "10.000001", "2027-01-01")],
        () => [a],
        "2027-01-01",
      ),
    ).toThrow(/holds 10.000000 then/);
    expect(() =>
      foldTransfers(
        [a],
        [transfer("t", "x", "b", "1.000000", "2027-01-01")],
        () => [a],
        "2027-01-01",
      ),
    ).toThrow(/ledger data integrity/);
  });

  it("throws when a later change leaves the transferor below zero at asOf", () => {
    const atEvent = pos("a", "10.000000", usd(10_000));
    const after = pos("a", "4.000000", usd(4_000)); // e.g. a void dated earlier
    expect(() =>
      foldTransfers(
        [after],
        [transfer("t", "a", "b", "6.000000", "2027-01-01")],
        () => [atEvent],
        "2027-02-01",
      ),
    ).toThrow(/negative units/);
  });
});
