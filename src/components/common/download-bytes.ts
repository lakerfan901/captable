// Saves bytes returned by a tRPC mutation as a file (04-investor-portal.md
// 5.7, "Delivery"). The bytes arrive as base64 in JSON, become a Blob, and a
// temporary <a download> with a blob: URL is clicked. No navigation, no new
// window and no script: the app's Content-Security-Policy does not restrict a
// same-document blob download.

export const XLSX_MIME =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/** Decodes base64 to bytes. */
export function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function downloadBytes(
  fileName: string,
  bytes: Uint8Array<ArrayBuffer>,
  mimeType: string,
): void {
  const url = URL.createObjectURL(new Blob([bytes], { type: mimeType }));
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.rel = "noopener";
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoked later: some browsers read the URL after click() returns.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function downloadBase64(
  fileName: string,
  base64: string,
  mimeType: string,
): void {
  downloadBytes(fileName, base64ToBytes(base64), mimeType);
}
