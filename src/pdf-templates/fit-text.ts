// Text fitting for react-pdf tables (Exhibit A). Pure: no imports, so it is
// unit-tested.
//
// react-pdf breaks a word that does not fit at hyphenation points and inserts
// a "-" there, which corrupts an email address ("priya.prospect@ex-ample.com").
// `noHyphenation` (passed as a Text's `hyphenationCallback`) keeps every word
// whole; `fitCell` then shrinks a cell whose longest word would not fit its
// column, and only below `minSize` splits that word over lines, without
// inserting any character.

/** Hyphenation callback that never splits a word. */
export function noHyphenation(word: string): string[] {
  return [word];
}

// Helvetica advance widths in em (Adobe AFM), for the characters that differ
// from the 0.556 most lowercase letters and digits have.
const WIDTHS: Record<string, number> = {
  " ": 0.278,
  "!": 0.278,
  ",": 0.278,
  ".": 0.278,
  "/": 0.278,
  ":": 0.278,
  ";": 0.278,
  "-": 0.333,
  "(": 0.333,
  ")": 0.333,
  "'": 0.191,
  "@": 1.015,
  _: 0.556,
  "+": 0.584,
  "#": 0.556,
  "&": 0.667,
  f: 0.278,
  i: 0.222,
  j: 0.222,
  l: 0.222,
  m: 0.833,
  r: 0.333,
  t: 0.278,
  w: 0.722,
  I: 0.278,
  J: 0.5,
  M: 0.833,
  W: 0.944,
};
const UPPER = 0.722;
const DEFAULT = 0.556;
/** Kerning and rounding slack. */
const SAFETY = 1.05;

/** Width of `text` in points at `fontSize` in Helvetica (an upper estimate). */
export function textWidth(text: string, fontSize: number): number {
  let em = 0;
  for (const ch of text) {
    em += WIDTHS[ch] ?? (ch >= "A" && ch <= "Z" ? UPPER : DEFAULT);
  }
  return em * fontSize * SAFETY;
}

/**
 * Font size and text for a cell `widthPt` wide: `baseSize` when its longest
 * word fits, else the size at which it fits (not below `minSize`). A word
 * that does not fit even at `minSize` is split over lines (a line break, no
 * inserted character), after an "@" or "." where possible.
 */
export function fitCell(
  text: string,
  widthPt: number,
  baseSize: number,
  minSize: number,
): { fontSize: number; text: string } {
  const words = text.split(/\s+/).filter((w) => w !== "");
  const longest = words.reduce((m, w) => Math.max(m, textWidth(w, 1)), 0);
  if (longest * baseSize <= widthPt) return { fontSize: baseSize, text };
  const size = Math.max(minSize, Math.floor((widthPt / longest) * 10) / 10);
  if (longest * size <= widthPt) return { fontSize: size, text };
  const lines = text
    .split("\n")
    .map((line) =>
      line
        .split(" ")
        .map((w) => splitWord(w, widthPt, size))
        .join(" "),
    )
    .join("\n");
  return { fontSize: size, text: lines };
}

function splitWord(word: string, widthPt: number, size: number): string {
  if (textWidth(word, size) <= widthPt) return word;
  const parts: string[] = [];
  let rest = word;
  while (textWidth(rest, size) > widthPt) {
    let cut = 1;
    while (
      cut < rest.length &&
      textWidth(rest.slice(0, cut + 1), size) <= widthPt
    ) {
      cut += 1;
    }
    // prefer to break just after an "@" or "." inside the part that fits
    const soft = Math.max(
      rest.lastIndexOf("@", cut - 1),
      rest.lastIndexOf(".", cut - 1),
    );
    if (soft > 0) cut = soft + 1;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  parts.push(rest);
  return parts.join("\n");
}
