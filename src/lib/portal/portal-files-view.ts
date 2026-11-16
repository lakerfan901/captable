// View logic of the portal's Reports and Documents pages (04-investor-portal.md
// 6.1; package P8b). Pure, no imports: used by server pages and client
// components alike, and testable without the `@/` alias.

/** Short type labels of the reports table (the report page uses ReportView's). */
const REPORT_TYPE_SHORT: Record<string, string> = {
  QUARTERLY: "Quarterly report",
  ANNUAL: "Annual financial statements",
  TAX_K1: "Schedule K-1",
  NOTICE: "Notice",
};

export function reportTypeShort(type: string): string {
  return REPORT_TYPE_SHORT[type] ?? "Report";
}

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

function parseYmd(s: string): { y: number; m: number; d: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!match) return null;
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  return { y, m, d };
}

/** "Sep 30, 2026" for a `YYYY-MM-DD` date; the input unchanged when it is not one. */
export function formatYmd(s: string): string {
  const p = parseYmd(s);
  if (p === null) return s;
  return `${MONTHS[p.m - 1]} ${p.d}, ${p.y}`;
}

/**
 * The period column of the reports table: "Jul 1 – Sep 30, 2026" within one
 * year, "Dec 1, 2025 – Jan 31, 2026" across years, the single date when only
 * one end is known, and "" (nothing shown) for a report without a period,
 * such as most notices.
 */
export function periodText(start: string | null, end: string | null): string {
  const a = start ? parseYmd(start) : null;
  const b = end ? parseYmd(end) : null;
  if (a && b) {
    if (a.y === b.y) {
      return `${MONTHS[a.m - 1]} ${a.d} – ${formatYmd(end as string)}`;
    }
    return `${formatYmd(start as string)} – ${formatYmd(end as string)}`;
  }
  if (b) return formatYmd(end as string);
  if (a) return formatYmd(start as string);
  return "";
}

/**
 * A date-time as the calendar day in the company's time zone ("Oct 28,
 * 2026"); "" when absent. An invalid zone falls back to UTC.
 */
export function formatDay(
  at: Date | string | null,
  timeZone: string,
  /** "long" ("October 28, 2026") as the emailed report page prints it. */
  style: "medium" | "long" = "medium",
): string {
  if (at === null) return "";
  const d = typeof at === "string" ? new Date(at) : at;
  if (Number.isNaN(d.getTime())) return "";
  const format = (zone: string) =>
    new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      dateStyle: style,
    }).format(d);
  try {
    return format(timeZone);
  } catch {
    return format("UTC");
  }
}

/** "540 KB", "2.4 MB", "820 bytes" (1 KB = 1024 bytes, as file managers show). */
export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return bytes === 1 ? "1 byte" : `${bytes} bytes`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  const text = value >= 10 ? String(Math.round(value)) : value.toFixed(1);
  // 1023.6 KB rounds to "1024 KB": show it as the next unit.
  if (Number(text) >= 1024 && unit < units.length - 1) {
    return `1.0 ${units[unit + 1]}`;
  }
  return `${text.replace(/\.0$/, "")} ${units[unit]}`;
}

/** Books-and-records categories (`BooksRecordCategoryEnum`) as investors read them. */
const CATEGORY_LABEL: Record<string, string> = {
  MEMBER_LIST: "Member list",
  ARTICLES_AND_AGREEMENT: "Governing documents",
  TAX_RETURNS: "Tax returns",
  FINANCIAL_STATEMENTS: "Financial statements",
  CONSENTS_AND_MINUTES: "Consents and minutes",
  OTHER_STATUTORY: "Other records",
};

/** The category column: a label, or "" (nothing shown) for an uncategorised file. */
export function categoryLabel(category: string | null): string {
  if (category === null) return "";
  return CATEGORY_LABEL[category] ?? "";
}

export interface PortalAttachmentLike {
  id: string;
  private: boolean;
}

/**
 * The report page's two file lists: "Your documents" (files private to this
 * holder, such as a K-1) and "Attachments" (shared with every recipient).
 * Order within each list is kept. An empty list is not shown at all.
 */
export function splitAttachments<T extends PortalAttachmentLike>(
  files: readonly T[],
): { own: T[]; shared: T[] } {
  return {
    own: files.filter((f) => f.private),
    shared: files.filter((f) => !f.private),
  };
}

/**
 * A type hint for the file icon (`FileIcon` reads words like "pdf", "image",
 * "sheet") from the file name's extension. The portal lists carry no media
 * type, and the icon is decoration only: it never decides how a file opens.
 */
export function iconTypeHint(name: string): string {
  const ext = /\.([a-z0-9]{1,5})$/i.exec(name.trim())?.[1]?.toLowerCase();
  switch (ext) {
    case "pdf":
      return "pdf";
    case "png":
    case "jpg":
    case "jpeg":
    case "gif":
    case "webp":
      return "image";
    case "xlsx":
    case "xls":
    case "csv":
      return "sheet";
    case "pptx":
    case "ppt":
      return "presentation";
    case "docx":
    case "doc":
      return "word";
    default:
      return "";
  }
}

/** What a file button does: show it in the viewer, or save it. */
export type FileOpenMode = "view" | "download";

export function fileOpenMode(inline: boolean): FileOpenMode {
  return inline ? "view" : "download";
}

/** What the viewer draws, from the Content-Type the storage returned. */
export type ViewerKind = "pdf" | "image" | "none";

export function viewerKind(contentType: string | null | undefined): ViewerKind {
  const bare = (contentType ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  if (bare === "application/pdf") return "pdf";
  if (/^image\/(png|jpeg|gif|webp)$/.test(bare)) return "image";
  return "none";
}

/**
 * How the page reacts to a refused portal call. The item or the access is
 * gone (unpublished, unshared, recipient removed, access turned off) or the
 * session ended: the page is re-rendered by the server, which then shows the
 * portal's "not available" page, the shorter list, `/portal` ("turned off")
 * or sign-in. Anything else is a passing failure: a message, try again.
 */
export function refusalAction(
  code: string | null | undefined,
): "reload" | "retry" {
  return code === "NOT_FOUND" || code === "UNAUTHORIZED" || code === "FORBIDDEN"
    ? "reload"
    : "retry";
}

/** The tRPC error code of a thrown client error, if any. */
export function trpcErrorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const data = (error as { data?: unknown }).data;
  if (typeof data !== "object" || data === null) return null;
  const code = (data as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}
