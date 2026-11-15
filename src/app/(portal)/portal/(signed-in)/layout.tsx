import { headers } from "next/headers";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { DEFAULT_NEXT_PATH, safeNextPath } from "@/lib/portal/next-path";
import { db } from "@/server/db";
import { loadPortalSession } from "@/server/portal/session";

// Signed-in portal pages (04-investor-portal.md 6.1, P8; package P2b): no
// valid portal session, no page. The browser is sent to
// `/portal/sign-in?next=…` with the requested path (from the proxy's
// `x-pathname`, which the proxy always overwrites) through `safeNextPath`.
// Only the portal cookie counts: a team session in the same browser is never
// read (G1). Pages under this layout still resolve the session or the holder
// themselves for their data (a layout is not re-run on every navigation).

export default async function PortalSignedInLayout(props: {
  children: ReactNode;
}) {
  const requestHeaders = await headers();
  const session = await loadPortalSession(db, requestHeaders.get("cookie"));
  if (session === null) {
    const next = safeNextPath(requestHeaders.get("x-pathname") ?? undefined);
    redirect(
      next === DEFAULT_NEXT_PATH
        ? "/portal/sign-in"
        : `/portal/sign-in?next=${encodeURIComponent(next)}`,
    );
  }
  return props.children;
}
