// Content types a browser may show inline from the storage origin. Pure:
// relative imports only (unit-tested under vitest).
//
// Private objects used to be stored as `application/octet-stream`, so a
// report attachment opened in a new tab was downloaded and left a blank tab
// behind. Only these types are ever stored or served with their real type
// (and `Content-Disposition: inline`): PDF and raster images render without
// running script. Anything else (HTML, SVG, XML, office files, archives)
// stays `application/octet-stream` and is served as an attachment, so no
// uploaded file can run script on the storage origin.

const INLINE_TYPES: ReadonlySet<string> = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

/** The bare, lower-case media type ("Application/PDF; x=1" → "application/pdf"). */
function bareType(mimeType: string | null | undefined): string {
  return (mimeType ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
}

/** True when `mimeType` may be shown inline (see the list above). */
export function isInlineContentType(
  mimeType: string | null | undefined,
): boolean {
  return INLINE_TYPES.has(bareType(mimeType));
}

/** The Content-Type to store a private object with. */
export function storedContentType(mimeType: string | null | undefined): string {
  const bare = bareType(mimeType);
  return INLINE_TYPES.has(bare) ? bare : "application/octet-stream";
}

/** `attachment; filename="…"` with a header-safe ASCII name (quotes, CR/LF and non-ASCII replaced). */
export function attachmentDisposition(fileName: string): string {
  const safe =
    fileName
      .replace(/[^\x20-\x7e]/g, "_")
      .replace(/["\\]/g, "_")
      .trim()
      .slice(0, 150) || "download";
  return `attachment; filename="${safe}"`;
}
