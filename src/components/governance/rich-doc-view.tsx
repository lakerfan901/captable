import type { ReactNode } from "react";
import {
  type DocNode,
  type Inline,
  type RichDoc,
  safeHref,
} from "../../lib/governance/rich-doc";

function renderInline(inline: Inline, key: number): ReactNode {
  let node: ReactNode = inline.text;
  if (inline.code) node = <code>{node}</code>;
  if (inline.strike) node = <s>{node}</s>;
  if (inline.underline) node = <u>{node}</u>;
  if (inline.italic) node = <em>{node}</em>;
  if (inline.bold) node = <strong>{node}</strong>;
  // Defence in depth: re-check the scheme even for documents that bypassed normalizeBlocks.
  const href = inline.href === undefined ? null : safeHref(inline.href);
  if (href !== null) {
    node = (
      <a href={href} target="_blank" rel="noopener noreferrer nofollow">
        {node}
      </a>
    );
  }
  return <span key={key}>{node}</span>;
}

function renderInlines(inlines: Inline[]): ReactNode[] {
  return inlines.map(renderInline);
}

function listMarker(node: Extract<DocNode, { t: "li" }>): string {
  if (node.marker === "number") return `${node.number ?? 1}.`;
  if (node.marker === "check") return node.checked ? "☑" : "☐";
  return "•";
}

function renderNode(node: DocNode, key: number): ReactNode {
  switch (node.t) {
    case "p":
      return (
        <p key={key} style={{ paddingLeft: `${node.indent * 1.5}rem` }}>
          {renderInlines(node.inlines)}
        </p>
      );
    case "h":
      if (node.level === 1)
        return <h2 key={key}>{renderInlines(node.inlines)}</h2>;
      if (node.level === 2)
        return <h3 key={key}>{renderInlines(node.inlines)}</h3>;
      return <h4 key={key}>{renderInlines(node.inlines)}</h4>;
    case "li":
      return (
        <div
          key={key}
          className="flex gap-2"
          style={{ paddingLeft: `${node.indent * 1.5}rem` }}
        >
          <span>{listMarker(node)}</span>
          <span>{renderInlines(node.inlines)}</span>
        </div>
      );
    case "quote":
      return <blockquote key={key}>{renderInlines(node.inlines)}</blockquote>;
    case "hr":
      return <hr key={key} />;
    default:
      return null;
  }
}

/** Renders a normalised RichDoc. Text only ever reaches the DOM as React text children. */
export function RichDocView({ doc }: { doc: RichDoc }) {
  return <div className="prose max-w-none">{doc.map(renderNode)}</div>;
}
