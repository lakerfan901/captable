import { describe, expect, it } from "vitest";
import { fitSignature, inkBounds } from "./signature-fit";

function rgba(
  width: number,
  height: number,
  ink: Array<[number, number]>,
): Uint8Array {
  const data = new Uint8Array(width * height * 4);
  for (const [x, y] of ink) {
    data[(y * width + x) * 4 + 3] = 255;
  }
  return data;
}

describe("inkBounds", () => {
  it("finds the box around the visible pixels, with a margin", () => {
    const data = rgba(100, 50, [
      [20, 10],
      [60, 30],
    ]);
    expect(inkBounds(data, 100, 50, { margin: 2 })).toEqual({
      left: 18,
      top: 8,
      width: 45,
      height: 25,
    });
  });

  it("clamps the margin to the image", () => {
    const data = rgba(10, 10, [
      [0, 0],
      [9, 9],
    ]);
    expect(inkBounds(data, 10, 10, { margin: 5 })).toEqual({
      left: 0,
      top: 0,
      width: 10,
      height: 10,
    });
  });

  it("ignores faint pixels and returns null for an empty image", () => {
    const data = new Uint8Array(4 * 4 * 4);
    data[3] = 8; // below the threshold
    expect(inkBounds(data, 4, 4)).toBeNull();
  });
});

describe("fitSignature", () => {
  // A 147 x 13.6 pt field (260 x 24 px on a 1080 px viewport of a Letter page).
  const box = { x: 318, y: 650, width: 147, height: 13.6 };

  it("fills the field height for a wide signature, keeping its aspect", () => {
    const r = fitSignature(box, { width: 240, height: 60 }, 1);
    expect(r.height).toBeCloseTo(11.6);
    expect(r.width).toBeCloseTo(46.4);
    expect(r.width / r.height).toBeCloseTo(4);
    expect(r.x).toBe(319);
    expect(r.y).toBeCloseTo(651);
  });

  it("fills the field width for a very wide signature and centres it", () => {
    const r = fitSignature(box, { width: 1000, height: 20 }, 1);
    expect(r.width).toBeCloseTo(145);
    expect(r.height).toBeCloseTo(2.9);
    expect(r.y + r.height / 2).toBeCloseTo(box.y + box.height / 2);
  });

  it("stays inside the box", () => {
    for (const image of [
      { width: 10, height: 300 },
      { width: 300, height: 10 },
      { width: 50, height: 50 },
    ]) {
      const r = fitSignature(box, image);
      expect(r.x).toBeGreaterThanOrEqual(box.x);
      expect(r.y).toBeGreaterThanOrEqual(box.y);
      expect(r.x + r.width).toBeLessThanOrEqual(box.x + box.width + 1e-9);
      expect(r.y + r.height).toBeLessThanOrEqual(box.y + box.height + 1e-9);
    }
  });

  it("returns an empty rect for an empty image", () => {
    expect(fitSignature(box, { width: 0, height: 10 }).width).toBe(0);
  });
});
