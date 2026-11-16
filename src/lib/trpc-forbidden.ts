import { TRPCError } from "@trpc/server";

// Server Components that read a procedure the viewer's role may not allow
// (a custom role without `audits: read`, say) must leave that section out,
// not fail the whole page with a 500. The RBAC middleware refuses such a
// call with UNAUTHORIZED and the policy's message (`withAccessControl` in
// src/trpc/api/trpc.ts); some procedures refuse with FORBIDDEN. A page under
// `(authenticated)` always has a session, so on such a page either code
// means "this role may not read it". Any other error (a bug, the database)
// still surfaces.

/** True for the error a procedure throws when the viewer may not read it. */
export function isAccessRefused(error: unknown): boolean {
  return (
    error instanceof TRPCError &&
    (error.code === "FORBIDDEN" || error.code === "UNAUTHORIZED")
  );
}

/** The value of `read()`, or null when the viewer's role may not read it. */
export async function unlessRefused<T>(
  read: () => Promise<T>,
): Promise<T | null> {
  try {
    return await read();
  } catch (error) {
    if (isAccessRefused(error)) return null;
    throw error;
  }
}
