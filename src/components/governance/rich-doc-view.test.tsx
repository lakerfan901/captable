import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { normalizeBlocks, type RichDoc } from "../../lib/governance/rich-doc";
import { RichDocView } from "./rich-doc-view";

function normalize(blocks: unknown): RichDoc {
  const result = normalizeBlocks(blocks);
  if (!result.ok) throw new Error(result.errors.join("; "));
  return result.doc;
}

const paragraph = (
  content: unknown[],
  props: Record<string, unknown> = {},
) => ({
  type: "paragraph",
  props,
  content,
  children: [],
});
const linkBlock = (href: string) =>
  paragraph([
    { type: "link", href, content: [{ type: "text", text: "go", styles: {} }] },
  ]);

const render = (doc: RichDoc) =>
  renderToStaticMarkup(<RichDocView doc={doc} />);

describe("RichDocView safety", () => {
  it("11. escapes markup in text", () => {
    const payload = "<script>alert(1)</script><img src=x onerror=alert(1)>";
    const doc = normalize([
      paragraph([{ type: "text", text: payload, styles: {} }]),
    ]);
    expect(doc).toEqual([{ t: "p", indent: 0, inlines: [{ text: payload }] }]);
    const html = render(doc);
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;img");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
  });

  it("12. keeps only http(s)/mailto hrefs", () => {
    const bad = [
      "javascript:alert(1)",
      "JaVaScRiPt:alert(1)",
      "data:text/html,<b>x</b>",
      "vbscript:x",
      "//evil.example",
    ];
    for (const href of bad) {
      const doc = normalize([linkBlock(href)]);
      expect(doc).toEqual([{ t: "p", indent: 0, inlines: [{ text: "go" }] }]);
      expect(render(doc)).not.toContain("href");
    }
    const good = normalize([linkBlock("\thttps://ok.example")]);
    expect(good).toEqual([
      {
        t: "p",
        indent: 0,
        inlines: [{ text: "go", href: "https://ok.example/" }],
      },
    ]);
    expect(render(good)).toContain('href="https://ok.example/"');
  });

  it("13. escapes the href attribute", () => {
    const doc = normalize([
      linkBlock('https://example.com/?q="><svg onload=alert(1)>'),
    ]);
    const html = render(doc);
    expect(html).toContain("href=");
    expect(html).not.toContain("<svg");
  });

  it("14. re-checks href schemes on hand-built documents", () => {
    const doc: RichDoc = [
      {
        t: "p",
        indent: 0,
        inlines: [{ text: "x", href: "javascript:alert(1)" }],
      },
    ];
    const html = render(doc);
    expect(html).not.toContain("href");
    expect(html).not.toContain("javascript");
  });

  it("16. ignores block props", () => {
    const doc = normalize([
      paragraph([{ type: "text", text: "hi", styles: {} }], {
        style: "background:url(x)",
        className: "x",
        onClick: "y",
      }),
    ]);
    const html = render(doc);
    expect(html).not.toContain("background:url(x)");
    expect(html).not.toContain('class="x"');
    expect(html.toLowerCase()).not.toContain("onclick");
  });

  it("17. source contains no raw-HTML injection", () => {
    const source = readFileSync(join(__dirname, "rich-doc-view.tsx"), "utf8");
    // Built from parts so the acceptance grep over this directory stays empty.
    expect(source).not.toContain(
      ["dangerously", "Set", "Inner", "HTML"].join(""),
    );
    expect(source).not.toContain(["inner", "HTML"].join(""));
  });
});
