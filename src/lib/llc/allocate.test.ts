import { describe, expect, it } from "vitest";
import { allocateProRata } from "./allocate";

const w = (pairs: [string, bigint][]) =>
  pairs.map(([key, weight]) => ({ key, weight }));
const obj = (m: Map<string, bigint>) => Object.fromEntries(m);

describe("allocateProRata", () => {
  it("worked examples", () => {
    expect(
      obj(
        allocateProRata(
          100n,
          w([
            ["a", 1n],
            ["b", 1n],
            ["c", 1n],
          ]),
        ),
      ),
    ).toEqual({
      a: 34n,
      b: 33n,
      c: 33n,
    });
    expect(
      obj(
        allocateProRata(
          1000n,
          w([
            ["a", 50n],
            ["b", 30n],
            ["c", 20n],
          ]),
        ),
      ),
    ).toEqual({
      a: 500n,
      b: 300n,
      c: 200n,
    });
    expect(
      obj(
        allocateProRata(
          101n,
          w([
            ["a", 2n],
            ["b", 1n],
            ["c", 1n],
          ]),
        ),
      ),
    ).toEqual({
      a: 51n,
      b: 25n,
      c: 25n,
    });
    expect(
      obj(
        allocateProRata(
          7n,
          w([
            ["b", 1n],
            ["a", 1n],
          ]),
        ),
      ),
    ).toEqual({ a: 4n, b: 3n });
    expect(obj(allocateProRata(0n, w([["a", 1n]])))).toEqual({ a: 0n });
    expect(
      obj(
        allocateProRata(
          5n,
          w([
            ["a", 0n],
            ["b", 1n],
          ]),
        ),
      ),
    ).toEqual({ a: 0n, b: 5n });
  });

  it("equal remainders: the larger weight gets the leftover cent before key order", () => {
    // 2 × 1/4 = 0 r 2, 2 × 3/4 = 1 r 2: remainders tie, so weight decides (b),
    // although key order alone would give the cent to a.
    expect(
      obj(
        allocateProRata(
          2n,
          w([
            ["a", 1n],
            ["b", 3n],
          ]),
        ),
      ),
    ).toEqual({ a: 0n, b: 2n });
  });

  it("errors", () => {
    expect(() => allocateProRata(5n, w([["a", 0n]]))).toThrow(
      expect.objectContaining({ code: "ZERO_WEIGHT" }),
    );
    expect(() => allocateProRata(-1n, w([["a", 1n]]))).toThrow(
      expect.objectContaining({ code: "NEGATIVE" }),
    );
    expect(() => allocateProRata(1n, w([["a", -1n]]))).toThrow(
      expect.objectContaining({ code: "NEGATIVE" }),
    );
    expect(() =>
      allocateProRata(
        1n,
        w([
          ["a", 1n],
          ["a", 2n],
        ]),
      ),
    ).toThrow(expect.objectContaining({ code: "DUPLICATE_KEY" }));
  });

  it("property: 200 pseudo-random cases", () => {
    let seed = 12345n;
    const next = (mod: bigint) => {
      seed = (seed * 6364136223846793005n + 1442695040888963407n) % 2n ** 64n;
      return (seed >> 33n) % mod;
    };
    for (let i = 0; i < 200; i++) {
      const total = next(10_000_000n);
      const count = Number(next(8n)) + 1;
      const items = Array.from({ length: count }, (_, j) => ({
        key: `k${j}`,
        weight: next(1_000_000n),
      }));
      const first = items[0];
      if (first && first.weight === 0n) first.weight = 1n;
      const W = items.reduce((s, x) => s + x.weight, 0n);
      const shares = allocateProRata(total, items);
      let sum = 0n;
      for (const item of items) {
        const share = shares.get(item.key) ?? -1n;
        expect(share >= 0n).toBe(true);
        // |share − total·w/W| < 1  ⇔  |share·W − total·w| < W
        const diff = share * W - total * item.weight;
        expect((diff < 0n ? -diff : diff) < W).toBe(true);
        sum += share;
      }
      expect(sum).toBe(total);
      const reversed = allocateProRata(total, [...items].reverse());
      expect(obj(reversed)).toEqual(obj(shares));
    }
  });
});
