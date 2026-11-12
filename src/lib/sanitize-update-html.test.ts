import { describe, expect, test } from "vitest";
import { sanitizeUpdateHtml } from "./sanitize-update-html";

// Captured from `editor.blocksToHTMLLossy` (@blocknote/core 0.57) for a
// document containing every block and inline style the update editor offers.
const BLOCKNOTE_HTML = [
  "<h1>Heading 1</h1>",
  '<h2 style="text-align: center;" data-level="2" data-text-alignment="center">Heading 2</h2>',
  '<h3 style="background-color: rgb(221, 235, 241); color: rgb(224, 62, 62);" data-level="3" data-text-color="red" data-background-color="blue">Heading 3</h3>',
  '<p style="text-align: right;" data-text-alignment="right"><strong>Bold </strong><em>italic </em><u>underline </u><s>strike </s><code>code </code><span style="color: rgb(224, 62, 62);" data-style-type="textColor" data-value="red" data-editable="">red </span><span style="background-color: rgb(251, 243, 219);" data-style-type="backgroundColor" data-value="yellow" data-editable="">yellowbg </span><a href="https://example.com" target="_blank" rel="noopener noreferrer nofollow" classname="bn-inline-content-section" data-inline-content-type="link">a link</a></p>',
  '<ul><li><p class="bn-inline-content">Bullet 1</p><ul><li data-nesting-level="1"><p class="bn-inline-content">Nested</p></li></ul></li><li><p class="bn-inline-content">Bullet 2</p></li></ul>',
  '<ol><li><p class="bn-inline-content">Number 1</p></li><li><p class="bn-inline-content">Number 2</p></li></ol>',
  '<ul><li data-checked="true"><input type="checkbox" checked=""><p class="bn-inline-content">Checked</p></li><li><input type="checkbox"><p class="bn-inline-content">Unchecked</p></li></ul>',
  '<pre data-language="javascript"><code class="bn-inline-content language-javascript" data-language="javascript">const a = 1;</code></pre>',
  '<table><colgroup><col><col></colgroup><tr><td colspan="1" rowspan="1"><p>A1</p></td><td colspan="1" rowspan="1"><p>B1</p></td></tr><tr><td colspan="1" rowspan="1"><p>A2</p></td><td colspan="1" rowspan="1"><p>B2</p></td></tr></table>',
  '<figure data-url="https://example.com/a.png" data-caption="Cap" data-preview-width="300"><img src="https://example.com/a.png" alt="" width="300"><figcaption>Cap</figcaption></figure>',
  '<img src="https://example.com/b.png" alt="" data-url="https://example.com/b.png">',
  '<video src="https://example.com/a.mp4" data-url="https://example.com/a.mp4"></video>',
  '<audio src="https://example.com/a.mp3" data-url="https://example.com/a.mp3"></audio>',
  '<a href="https://example.com/a.pdf" data-url="https://example.com/a.pdf" data-name="a.pdf">a.pdf</a>',
  "<blockquote>Quoted</blockquote>",
  '<ul><li><details open=""><summary><p class="bn-inline-content">Toggle</p></summary><p data-nesting-level="1">inside</p></details></li></ul>',
  "<hr>",
  '<details open="" data-level="4" data-is-toggleable="true"><summary><h4 class="bn-inline-content">H4</h4></summary></details>',
  '<table><colgroup><col style="width: 120px;"><col></colgroup><tr><th data-text-color="blue" data-background-color="red" data-text-alignment="center" colspan="1" rowspan="1" colwidth="120"><p>H1</p></th><th colspan="1" rowspan="1"><p>H2</p></th></tr><tr><td colspan="1" rowspan="1" colwidth="120"><p>c1</p></td><td colspan="1" rowspan="1"><p>c2</p></td></tr></table>',
].join("");

describe("sanitizeUpdateHtml", () => {
  test("keeps BlockNote output intact", () => {
    const out = sanitizeUpdateHtml(BLOCKNOTE_HTML);

    // Normalise serialisation differences only: void elements (`<input>` vs
    // `<input />`), empty attribute values (`checked=""` vs `checked`) and
    // inline-style whitespace/trailing `;`.
    const normalise = (html: string) =>
      html
        .replace(/\s*\/>/g, ">")
        .replace(/=""/g, "")
        .replace(/style="([^"]*)"/g, (_, css: string) => {
          const decls = css
            .split(";")
            .map((d) => d.trim().replace(/\s*:\s*/, ":"))
            .filter(Boolean);
          return `style="${decls.join(";")}"`;
        });

    expect(normalise(out)).toBe(normalise(BLOCKNOTE_HTML));
  });

  test("is idempotent", () => {
    const once = sanitizeUpdateHtml(BLOCKNOTE_HTML);
    expect(sanitizeUpdateHtml(once)).toBe(once);
  });

  test("handles empty input", () => {
    expect(sanitizeUpdateHtml("")).toBe("");
    expect(sanitizeUpdateHtml(null)).toBe("");
    expect(sanitizeUpdateHtml(undefined)).toBe("");
  });

  const payloads: { name: string; html: string; forbidden: RegExp[] }[] = [
    {
      name: "script tag",
      html: "<p>hi</p><script>alert(1)</script>",
      forbidden: [/<script/i, /alert/],
    },
    {
      name: "event handler attribute",
      html: '<img src="https://x.test/a.png" onerror="alert(1)"><p onclick="alert(1)">x</p>',
      forbidden: [/onerror/i, /onclick/i, /alert/],
    },
    {
      name: "javascript: link",
      html: '<a href="javascript:alert(1)">x</a><a href=" JaVaScRiPt:alert(1)">y</a>',
      forbidden: [/javascript:/i],
    },
    {
      name: "javascript: link obfuscated with control characters and entities",
      html: '<a href="java&#x09;script:alert(1)">x</a><a href="&#106;avascript:alert(1)">y</a>',
      forbidden: [/href/i],
    },
    {
      name: "data: link",
      html: '<a href="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">x</a>',
      forbidden: [/data:/i],
    },
    {
      name: "data: and javascript: image sources",
      html: '<img src="data:image/svg+xml,<svg onload=alert(1)>"><img src="javascript:alert(1)">',
      forbidden: [/data:/i, /javascript:/i, /onload/i],
    },
    {
      name: "protocol-relative URL",
      html: '<a href="//evil.test/x">x</a>',
      forbidden: [/evil\.test/],
    },
    {
      name: "iframe, object, embed",
      html: '<iframe src="https://evil.test"></iframe><object data="https://evil.test"></object><embed src="https://evil.test">',
      forbidden: [/<iframe/i, /<object/i, /<embed/i, /evil\.test/],
    },
    {
      name: "svg and math",
      html: "<svg><script>alert(1)</script></svg><math><mtext><img src=x onerror=alert(1)></mtext></math>",
      forbidden: [/<svg/i, /<math/i, /alert/],
    },
    {
      name: "style tag and css expressions",
      html: '<style>body{background:url(https://evil.test)}</style><p style="background-image: url(https://evil.test); color: expression(alert(1)); width: 9999px">x</p>',
      forbidden: [/<style/i, /url\(/i, /expression/i, /width/i],
    },
    {
      name: "form controls other than checkbox",
      html: '<form action="https://evil.test"><input type="text" name="password"><input type="submit"><input><input type="CHECKBOX " name="x"><button>Go</button></form>',
      forbidden: [/<form/i, /<input/i, /<button/i, /evil\.test/],
    },
    {
      name: "meta refresh and base",
      html: '<meta http-equiv="refresh" content="0;url=https://evil.test"><base href="https://evil.test/">',
      forbidden: [/<meta/i, /<base/i, /evil\.test/],
    },
    {
      name: "srcdoc and formaction attributes",
      html: '<img src="https://x.test/a.png" srcset="javascript:alert(1)" formaction="javascript:alert(1)">',
      forbidden: [/srcset/i, /formaction/i, /javascript:/i],
    },
    {
      name: "attribute breakout",
      html: '<p data-x="&quot;><script>alert(1)</script>">x</p>',
      forbidden: [/<script/i],
    },
    {
      name: "arbitrary class names",
      html: '<p class="bn-inline-content fixed inset-0 z-50">x</p>',
      forbidden: [/fixed/, /inset-0/, /z-50/],
    },
  ];

  test.each(payloads)("strips $name", ({ html, forbidden }) => {
    const out = sanitizeUpdateHtml(html);
    for (const pattern of forbidden) {
      expect(out).not.toMatch(pattern);
    }
  });

  test("forces safe rel on links that open a new tab", () => {
    const out = sanitizeUpdateHtml(
      '<a href="https://example.com" target="_top" rel="opener">x</a>',
    );
    expect(out).toBe(
      '<a href="https://example.com" target="_blank" rel="noopener noreferrer nofollow">x</a>',
    );
  });

  test("keeps safe link schemes", () => {
    const html =
      '<a href="https://example.com">a</a><a href="mailto:a@example.com">b</a><a href="tel:+15555550100">c</a>';
    expect(sanitizeUpdateHtml(html)).toBe(html);
  });
});
