import "server-only";

import { TRPCError } from "@trpc/server";
import { notFound, redirect } from "next/navigation";
import { connection } from "next/server";
import { cache } from "react";
import { api } from "@/trpc/server";

// The signed-in portal user and their holders for server pages (package
// P8a). Goes through `portal.me` on the RSC caller, so the same rules hold as
// for every portal procedure: the portal cookie only (G1), ACTIVE accesses of
// LLC companies whose holder row exists (P9, P10). `cache` makes the layout
// and the page of one request share one read.
//
// Pages do not import `portal-procedure.ts` (G5: only the portal routers may),
// so the gate for `/portal/[access]` is "the access is one of `portal.me`'s
// holders", which is the same rule `resolveHolder` applies.

export type PortalMe = Awaited<ReturnType<typeof api.portal.me>>;
export type PortalMeHolder = PortalMe["holders"][number];

/** `portal.me`, or null when the portal session is gone (UNAUTHORIZED). */
export const loadPortalMe = cache(async (): Promise<PortalMe | null> => {
  // Per request only (it reads the portal cookie): never prerendered, and
  // the build does not try to.
  await connection();
  try {
    return await api.portal.me();
  } catch (error) {
    if (error instanceof TRPCError && error.code === "UNAUTHORIZED")
      return null;
    throw error;
  }
});

/**
 * `portal.me` for a page that needs a signed-in user with at least one
 * ACTIVE access. No session: sign-in. No access left (the team turned it
 * off while the page was open, P9): `/portal`, which says so (B11).
 */
export async function requirePortalMe(): Promise<PortalMe> {
  const me = await loadPortalMe();
  if (me === null) redirect("/portal/sign-in");
  if (me.holders.length === 0) redirect("/portal");
  return me;
}

/**
 * The holder of `/portal/[access]` (P10, S3): the access must be one of the
 * signed-in user's ACTIVE accesses. Anything else, including another
 * person's access id, an id of a disabled access or a malformed value, is
 * the same 404 as a page that does not exist.
 */
export async function requirePortalHolder(
  access: string,
): Promise<{ me: PortalMe; holder: PortalMeHolder }> {
  const me = await requirePortalMe();
  const holder = me.holders.find((h) => h.access === access);
  if (holder === undefined) notFound();
  return { me, holder };
}
