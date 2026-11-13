import { StyleSheet, Text, View } from "@react-pdf/renderer";
import type { DocNode, Inline, RichDoc } from "../../lib/governance/rich-doc";
import { safeHref } from "../../lib/governance/rich-doc";

// React-PDF rendering of a normalised RichDoc (03-governance.md G9).
// Built-in fonts only (Helvetica / Helvetica-Bold / Helvetica-Oblique /
// Courier): no Font.register, no network access at render time.

const INDENT_PT = 14;

type Style = {
  fontFamily?: string;
  textDecoration?: "underline" | "line-through" | "underline line-through";
};

const styles = StyleSheet.create({
  p: { marginBottom: 6 },
  h1: {
    fontFamily: "Helvetica-Bold",
    fontSize: 14,
    marginTop: 8,
    marginBottom: 6,
  },
  h2: {
    fontFamily: "Helvetica-Bold",
    fontSize: 12,
    marginTop: 8,
    marginBottom: 5,
  },
  h3: {
    fontFamily: "Helvetica-Bold",
    fontSize: 11,
    marginTop: 6,
    marginBottom: 4,
  },
  li: { flexDirection: "row", marginBottom: 3 },
  marker: { width: 18 },
  liText: { flex: 1 },
  quote: {
    marginBottom: 6,
    paddingLeft: 10,
    borderLeftWidth: 2,
    borderLeftColor: "#a1a1aa",
    fontFamily: "Helvetica-Oblique",
  },
  hr: {
    borderBottomWidth: 0.75,
    borderBottomColor: "#a1a1aa",
    marginVertical: 8,
  },
});

function inlineStyle(inline: Inline): Style {
  const style: Style = {};
  if (inline.code) style.fontFamily = "Courier";
  else if (inline.bold) style.fontFamily = "Helvetica-Bold";
  else if (inline.italic) style.fontFamily = "Helvetica-Oblique";
  if (inline.underline && inline.strike) {
    style.textDecoration = "underline line-through";
  } else if (inline.underline) {
    style.textDecoration = "underline";
  } else if (inline.strike) {
    style.textDecoration = "line-through";
  }
  return style;
}

function renderInlines(inlines: Inline[]) {
  return inlines.map((inline, i) => {
    const href = inline.href === undefined ? null : safeHref(inline.href);
    return (
      // biome-ignore lint/suspicious/noArrayIndexKey: static document, order never changes
      <Text key={i} style={inlineStyle(inline)}>
        {href === null ? inline.text : `${inline.text} (${href})`}
      </Text>
    );
  });
}

function listMarker(node: Extract<DocNode, { t: "li" }>): string {
  if (node.marker === "number") return `${node.number ?? 1}.`;
  if (node.marker === "check") return node.checked ? "[x]" : "[ ]";
  return "•";
}

function renderNode(node: DocNode, key: number) {
  switch (node.t) {
    case "p":
      return (
        <Text
          key={key}
          style={[styles.p, { paddingLeft: node.indent * INDENT_PT }]}
        >
          {renderInlines(node.inlines)}
        </Text>
      );
    case "h": {
      const style =
        node.level === 1 ? styles.h1 : node.level === 2 ? styles.h2 : styles.h3;
      return (
        <Text key={key} style={style}>
          {renderInlines(node.inlines)}
        </Text>
      );
    }
    case "li":
      return (
        <View
          key={key}
          style={[styles.li, { paddingLeft: node.indent * INDENT_PT }]}
          wrap={false}
        >
          <Text style={styles.marker}>{listMarker(node)}</Text>
          <Text style={styles.liText}>{renderInlines(node.inlines)}</Text>
        </View>
      );
    case "quote":
      return (
        <Text key={key} style={styles.quote}>
          {renderInlines(node.inlines)}
        </Text>
      );
    case "hr":
      return <View key={key} style={styles.hr} />;
    default:
      return null;
  }
}

export function RichDocPdf({ doc }: { doc: RichDoc }) {
  return <View>{doc.map(renderNode)}</View>;
}
