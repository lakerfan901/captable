import sanitizeHtml from "sanitize-html";

/**
 * Allowlist for HTML produced by the BlockNote editor
 * (`editor.blocksToHTMLLossy`) for investor updates.
 *
 * Investor updates are rendered on a public page, so the stored HTML must
 * never be trusted: it is sanitized when saved and again when rendered.
 */

// rgb()/rgba(), hex, or a bare keyword. Anchored, so `url(`, `expression(`
// and anything else unexpected is rejected.
const COLOR = [
  /^#[0-9a-f]{3,8}$/i,
  /^rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(,\s*(0|1|0?\.\d+)\s*)?\)$/i,
  /^[a-z]+$/i,
];

const UPDATE_HTML_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "p",
    "br",
    "hr",
    "span",
    "strong",
    "b",
    "em",
    "i",
    "u",
    "s",
    "del",
    "code",
    "pre",
    "blockquote",
    "a",
    "ul",
    "ol",
    "li",
    "input",
    "table",
    "colgroup",
    "col",
    "thead",
    "tbody",
    "tfoot",
    "tr",
    "th",
    "td",
    "figure",
    "figcaption",
    "img",
    "video",
    "audio",
  ],
  allowedAttributes: {
    "*": ["style", "data-*"],
    a: ["href", "target", "rel", "classname"],
    img: ["src", "alt", "title", "width", "height"],
    video: ["src", "width", "height", "controls"],
    audio: ["src", "controls"],
    // BlockNote check list items render a checkbox.
    input: [
      { name: "type", multiple: false, values: ["checkbox"] },
      "checked",
      "disabled",
    ],
    td: ["colspan", "rowspan", "colwidth"],
    th: ["colspan", "rowspan", "colwidth"],
    col: ["span", "width"],
    ol: ["start"],
  },
  allowedClasses: {
    "*": ["bn-*", "language-*"],
  },
  allowedStyles: {
    "*": {
      color: COLOR,
      "background-color": COLOR,
      "text-align": [/^(left|right|center|justify|start|end)$/i],
    },
  },
  allowedSchemes: ["http", "https", "mailto", "tel"],
  allowedSchemesByTag: {
    img: ["http", "https"],
    video: ["http", "https"],
    audio: ["http", "https"],
  },
  allowedSchemesAppliedToAttributes: ["href", "src", "cite"],
  allowProtocolRelative: false,
  // Remove disallowed tags but keep their text; script/style/textarea
  // content is always dropped by sanitize-html.
  disallowedTagsMode: "discard",
  transformTags: {
    a: (tagName, attribs) => {
      // Links that open a new tab must not get a handle on the opener.
      if (attribs.target) {
        return {
          tagName,
          attribs: {
            ...attribs,
            target: "_blank",
            rel: "noopener noreferrer nofollow",
          },
        };
      }
      return { tagName, attribs };
    },
  },
};

export function sanitizeUpdateHtml(html: string | null | undefined): string {
  if (!html) {
    return "";
  }

  return sanitizeHtml(html, UPDATE_HTML_OPTIONS);
}
