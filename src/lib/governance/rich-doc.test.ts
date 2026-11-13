import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  docToPlainText,
  isDocEmpty,
  normalizeBlocks,
  RichDocSchema,
} from "./rich-doc";

const text = (t: string, styles: Record<string, boolean> = {}) => ({
  type: "text",
  text: t,
  styles,
});
const block = (
  type: string,
  content: unknown[] = [],
  extra: Record<string, unknown> = {},
) => ({
  type,
  props: {},
  content,
  children: [],
  ...extra,
});
const link = (href: string, t: string) => ({
  type: "link",
  href,
  content: [text(t)],
});

function ok(blocks: unknown) {
  const result = normalizeBlocks(blocks);
  if (!result.ok) throw new Error(result.errors.join("; "));
  return result.doc;
}

describe("normalizeBlocks", () => {
  it("1. maps bold text and a link", () => {
    const doc = ok([
      block("paragraph", [
        text("Hello ", { bold: true }),
        link("https://example.com", "site"),
      ]),
    ]);
    expect(doc).toEqual([
      {
        t: "p",
        indent: 0,
        inlines: [
          { text: "Hello ", bold: true },
          { text: "site", href: "https://example.com/" },
        ],
      },
    ]);
  });

  it("2. drops a javascript: href and keeps the text", () => {
    const doc = ok([
      block("paragraph", [link("javascript:alert(1)", "click")]),
    ]);
    expect(doc).toEqual([{ t: "p", indent: 0, inlines: [{ text: "click" }] }]);
  });

  it("3. rejects unsupported blocks and collects all errors", () => {
    expect(normalizeBlocks([block("image")])).toEqual({
      ok: false,
      errors: ["Unsupported block: image"],
    });
    expect(normalizeBlocks([block("image"), block("table")])).toEqual({
      ok: false,
      errors: ["Unsupported block: image", "Unsupported block: table"],
    });
  });

  it("4. numbers consecutive numbered items and resets after a paragraph", () => {
    const doc = ok([
      block("numberedListItem", [text("a")]),
      block("numberedListItem", [text("b")]),
      block("numberedListItem", [text("c")]),
      block("paragraph", [text("p")]),
      block("numberedListItem", [text("d")]),
      block("numberedListItem", [text("e")]),
    ]);
    const numbers = doc.flatMap((n) => (n.t === "li" ? [n.number] : []));
    expect(numbers).toEqual([1, 2, 3, 1, 2]);
  });

  it("5. clamps nested bullets at depth 4 to indent 2", () => {
    const leaf = block("bulletListItem", [text("deep")]);
    let tree = leaf;
    for (let i = 0; i < 4; i++) {
      tree = block("bulletListItem", [text(`l${i}`)], { children: [tree] });
    }
    const doc = ok([tree]);
    const last = doc[doc.length - 1];
    expect(last).toEqual({
      t: "li",
      indent: 2,
      marker: "bullet",
      inlines: [{ text: "deep" }],
    });
  });

  it("6. clamps heading level 5 to 3", () => {
    const doc = ok([block("heading", [text("H")], { props: { level: 5 } })]);
    expect(doc).toEqual([{ t: "h", level: 3, inlines: [{ text: "H" }] }]);
  });

  it("9. removes control characters", () => {
    const doc = ok([block("paragraph", [text("a\u0007b")])]);
    expect(doc).toEqual([{ t: "p", indent: 0, inlines: [{ text: "ab" }] }]);
  });

  it("10. rejects non-array input", () => {
    expect(normalizeBlocks({ type: "paragraph" }).ok).toBe(false);
    expect(normalizeBlocks("x").ok).toBe(false);
  });
});

describe("helpers", () => {
  it("7. canonicalJson sorts keys recursively", () => {
    expect(canonicalJson({ b: 1, a: [{ d: 1, c: 2 }] })).toBe(
      '{"a":[{"c":2,"d":1}],"b":1}',
    );
  });

  it("8. isDocEmpty", () => {
    expect(isDocEmpty([{ t: "p", indent: 0, inlines: [] }])).toBe(true);
    expect(isDocEmpty([{ t: "p", indent: 0, inlines: [{ text: "x" }] }])).toBe(
      false,
    );
    expect(
      docToPlainText([
        { t: "p", indent: 0, inlines: [{ text: "x" }] },
        { t: "hr" },
      ]),
    ).toBe("x\n");
  });

  it("15. RichDocSchema rejects extra keys and unknown node types", () => {
    expect(
      RichDocSchema.safeParse([
        { t: "p", indent: 0, inlines: [], html: "<b>x</b>" },
      ]).success,
    ).toBe(false);
    expect(RichDocSchema.safeParse([{ t: "html" }]).success).toBe(false);
    expect(
      RichDocSchema.safeParse([{ t: "p", indent: 0, inlines: [] }]).success,
    ).toBe(true);
  });
});
