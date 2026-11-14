// Placing a signature image in its field on the signed PDF. Pure: the caller
// decodes the PNG; these functions only do the geometry.
//
// The signing pad exports its whole drawing surface (a wide, tall,
// transparent canvas), so the ink is first cropped to its bounds and then
// scaled to fit the field box, keeping its aspect ratio.

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PixelBounds {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * The bounding box of the visible pixels (alpha above `alphaThreshold`) of a
 * raw RGBA image, grown by `margin` pixels and clamped to the image. Null
 * when nothing is visible.
 */
export function inkBounds(
  data: Uint8Array,
  width: number,
  height: number,
  options: { channels?: number; alphaThreshold?: number; margin?: number } = {},
): PixelBounds | null {
  const channels = options.channels ?? 4;
  const threshold = options.alphaThreshold ?? 16;
  const margin = options.margin ?? 2;
  if (channels < 4) return null;

  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    const row = y * width * channels;
    for (let x = 0; x < width; x++) {
      const alpha = data[row + x * channels + 3] ?? 0;
      if (alpha > threshold) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;

  const left = Math.max(0, minX - margin);
  const top = Math.max(0, minY - margin);
  const right = Math.min(width - 1, maxX + margin);
  const bottom = Math.min(height - 1, maxY + margin);
  return { left, top, width: right - left + 1, height: bottom - top + 1 };
}

/**
 * The largest rectangle with the image's aspect ratio that fits inside `box`
 * less `padding` on every side; left-aligned and vertically centred (a
 * signature sits at the start of its line). Coordinates are top-left based,
 * in the box's units.
 */
export function fitSignature(
  box: Rect,
  image: { width: number; height: number },
  padding = Math.min(2, box.height * 0.1),
): Rect {
  const innerW = Math.max(0, box.width - 2 * padding);
  const innerH = Math.max(0, box.height - 2 * padding);
  if (image.width <= 0 || image.height <= 0 || innerW <= 0 || innerH <= 0) {
    return { x: box.x, y: box.y, width: 0, height: 0 };
  }
  const scale = Math.min(innerW / image.width, innerH / image.height);
  const width = image.width * scale;
  const height = image.height * scale;
  return {
    x: box.x + padding,
    y: box.y + padding + (innerH - height) / 2,
    width,
    height,
  };
}
