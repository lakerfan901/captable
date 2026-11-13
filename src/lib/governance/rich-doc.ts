import { z } from "zod";

export interface Inline {
  text: string;
  bold?: true;
  italic?: true;
  underline?: true;
  strike?: true;
  code?: true;
  href?: string; // only http:, https:, mailto:
}

export type DocNode =
  | { t: "p"; indent: 0 | 1 | 2; inlines: Inline[] }
  | { t: "h"; level: 1 | 2 | 3; inlines: Inline[] }
  | {
      t: "li";
      indent: 0 | 1 | 2;
      marker: "bullet" | "number" | "check";
      number?: number;
      checked?: boolean;
      inlines: Inline[];
    }
  | { t: "quote"; inlines: Inline[] }
  | { t: "hr" };

export type RichDoc = DocNode[];

export const MAX_DOC_NODES = 2000;
export const MAX_DOC_CHARS = 200_000;

const ALLOWED_SCHEMES = new Set(["http:", "https:", "mailto:"]);
const STYLE_KEYS = ["bold", "italic", "underline", "strike", "code"] as const;
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

/** Returns the normalised href when its scheme is http:, https: or mailto:, else null. */
export function safeHref(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  try {
    const url = new URL(raw);
    if (!ALLOWED_SCHEMES.has(url.protocol.toLowerCase())) return null;
    return url.href;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cleanText(value: unknown): string {
  return typeof value === "string" ? value.replace(CONTROL_CHARS, "") : "";
}

function makeInline(
  text: unknown,
  styles: unknown,
  href: string | null,
): Inline | null {
  const cleaned = cleanText(text);
  if (cleaned === "") return null;
  const inline: Inline = { text: cleaned };
  if (isRecord(styles)) {
    for (const key of STYLE_KEYS) {
      if (styles[key] === true) inline[key] = true;
    }
  }
  if (href !== null) inline.href = href;
  return inline;
}

function mapInlines(content: unknown, errors: string[]): Inline[] {
  if (content === undefined || content === null) return [];
  if (typeof content === "string") {
    const inline = makeInline(content, undefined, null);
    return inline ? [inline] : [];
  }
  if (!Array.isArray(content)) {
    errors.push("Invalid block content");
    return [];
  }
  const out: Inline[] = [];
  for (const item of content) {
    if (!isRecord(item)) {
      errors.push("Invalid inline content");
      continue;
    }
    if (item.type === "text") {
      const inline = makeInline(item.text, item.styles, null);
      if (inline) out.push(inline);
    } else if (item.type === "link") {
      const href = safeHref(item.href);
      const parts = Array.isArray(item.content) ? item.content : [];
      for (const part of parts) {
        if (!isRecord(part) || part.type !== "text") {
          errors.push(
            `Unsupported inline content: ${isRecord(part) ? String(part.type) : typeof part}`,
          );
          continue;
        }
        const inline = makeInline(part.text, part.styles, href);
        if (inline) out.push(inline);
      }
    } else {
      errors.push(`Unsupported inline content: ${String(item.type)}`);
    }
  }
  return out;
}

function clampIndent(depth: number): 0 | 1 | 2 {
  return depth >= 2 ? 2 : depth === 1 ? 1 : 0;
}

function headingLevel(level: unknown): 1 | 2 | 3 {
  if (level === 1 || level === 2 || level === 3) return level;
  if (level === 4 || level === 5 || level === 6) return 3;
  return 1;
}

export function normalizeBlocks(
  blocks: unknown,
): { ok: true; doc: RichDoc } | { ok: false; errors: string[] } {
  if (!Array.isArray(blocks)) {
    return { ok: false, errors: ["Document must be an array of blocks"] };
  }
  const errors: string[] = [];
  const doc: RichDoc = [];
  // counters[i] = last number used by the current numbered run at indent i
  const counters: (number | undefined)[] = [undefined, undefined, undefined];

  const resetFrom = (indent: number) => {
    for (let i = indent; i < counters.length; i++) counters[i] = undefined;
  };

  const visit = (list: unknown[], depth: number) => {
    for (const block of list) {
      if (!isRecord(block)) {
        errors.push("Invalid block");
        continue;
      }
      const type = block.type;
      const props = isRecord(block.props) ? block.props : {};
      const indent = clampIndent(depth);
      let node: DocNode | null = null;

      switch (type) {
        case "paragraph":
          resetFrom(indent);
          node = { t: "p", indent, inlines: mapInlines(block.content, errors) };
          break;
        case "heading":
          resetFrom(0);
          node = {
            t: "h",
            level: headingLevel(props.level),
            inlines: mapInlines(block.content, errors),
          };
          break;
        case "quote":
          resetFrom(0);
          node = { t: "quote", inlines: mapInlines(block.content, errors) };
          break;
        case "divider":
          resetFrom(0);
          node = { t: "hr" };
          break;
        case "bulletListItem":
        case "toggleListItem":
          resetFrom(indent);
          node = {
            t: "li",
            indent,
            marker: "bullet",
            inlines: mapInlines(block.content, errors),
          };
          break;
        case "checkListItem":
          resetFrom(indent);
          node = {
            t: "li",
            indent,
            marker: "check",
            checked: props.checked === true,
            inlines: mapInlines(block.content, errors),
          };
          break;
        case "numberedListItem": {
          resetFrom(indent + 1);
          const previous = counters[indent];
          const start =
            typeof props.start === "number" &&
            Number.isInteger(props.start) &&
            props.start > 0
              ? props.start
              : 1;
          const number = previous === undefined ? start : previous + 1;
          counters[indent] = number;
          node = {
            t: "li",
            indent,
            marker: "number",
            number,
            inlines: mapInlines(block.content, errors),
          };
          break;
        }
        default:
          errors.push(`Unsupported block: ${String(type)}`);
      }

      if (node) doc.push(node);
      if (Array.isArray(block.children) && block.children.length > 0) {
        visit(block.children, depth + 1);
      }
    }
  };

  visit(blocks, 0);

  if (doc.length > MAX_DOC_NODES) {
    errors.push(`Document has more than ${MAX_DOC_NODES} blocks`);
  }
  let chars = 0;
  for (const node of doc) {
    if (node.t === "hr") continue;
    for (const inline of node.inlines) chars += inline.text.length;
  }
  if (chars > MAX_DOC_CHARS) {
    errors.push(`Document has more than ${MAX_DOC_CHARS} characters`);
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, doc };
}

function nodeText(node: DocNode): string {
  if (node.t === "hr") return "";
  return node.inlines.map((inline) => inline.text).join("");
}

/** True when no node has non-whitespace text. */
export function isDocEmpty(doc: RichDoc): boolean {
  return doc.every((node) => nodeText(node).trim() === "");
}

/** One line per node. */
export function docToPlainText(doc: RichDoc): string {
  return doc.map(nodeText).join("\n");
}

/** Deterministic JSON: object keys sorted recursively, arrays in order, no whitespace, undefined dropped. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value)) ?? "null";
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const v = value[key];
      if (v !== undefined) out[key] = sortValue(v);
    }
    return out;
  }
  return value;
}

const indentSchema = z.union([z.literal(0), z.literal(1), z.literal(2)]);

const InlineSchema = z.strictObject({
  text: z.string(),
  bold: z.literal(true).optional(),
  italic: z.literal(true).optional(),
  underline: z.literal(true).optional(),
  strike: z.literal(true).optional(),
  code: z.literal(true).optional(),
  href: z.string().optional(),
});

const DocNodeSchema = z.discriminatedUnion("t", [
  z.strictObject({
    t: z.literal("p"),
    indent: indentSchema,
    inlines: z.array(InlineSchema),
  }),
  z.strictObject({
    t: z.literal("h"),
    level: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    inlines: z.array(InlineSchema),
  }),
  z.strictObject({
    t: z.literal("li"),
    indent: indentSchema,
    marker: z.enum(["bullet", "number", "check"]),
    number: z.number().int().positive().optional(),
    checked: z.boolean().optional(),
    inlines: z.array(InlineSchema),
  }),
  z.strictObject({ t: z.literal("quote"), inlines: z.array(InlineSchema) }),
  z.strictObject({ t: z.literal("hr") }),
]);

/** Strict Zod schema of a RichDoc (no unknown keys or node types); used before rendering stored documents. */
export const RichDocSchema: z.ZodType<RichDoc> = z
  .array(DocNodeSchema)
  .max(MAX_DOC_NODES);
