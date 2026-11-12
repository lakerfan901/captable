/**
 * Returns `next` when it is a same-origin path inside company `publicId`
 * (`/<publicId>` or `/<publicId>/...`); otherwise `/<publicId>`.
 */
export function safeNextPath(
  publicId: string,
  next: string | undefined,
): string {
  const root = `/${publicId}`;
  if (typeof next !== "string") return root;
  if (next === root || next.startsWith(`${root}/`)) return next;
  return root;
}
