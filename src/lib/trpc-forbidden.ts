import { TRPCError } from "@trpc/server";

// Server Components that read a procedure the viewer's role may not allow
// (a custom role without `audits: read`, say) must leave that section out,
// not fail the whole page with a 500. Only FORBIDDEN is swallowed: any other
// error (a bug, the database) still surfaces.

/** True for the error an RBAC policy throws when the role lacks the subject. */
export function isForbidden(error: unknown): boolean {
  return error instanceof TRPCError && error.code === "FORBIDDEN";
}

/** The value of `read()`, or null when the viewer's role may not read it. */
export async function unlessForbidden<T>(
  read: () => Promise<T>,
): Promise<T | null> {
  try {
    return await read();
  } catch (error) {
    if (isForbidden(error)) return null;
    throw error;
  }
}
