import "server-only";

import { TRPCError } from "@trpc/server";
import { notFound, redirect } from "next/navigation";

// A portal procedure called from a server page (package P8b). NOT_FOUND
// (an item not visible to this holder, or an access no longer active) is
// the portal's 404, which looks the same for every reason (S3);
// UNAUTHORIZED (the session ended between the layout and the page) is
// sign-in. Anything else is a real error and propagates.

export async function portalPageCall<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof TRPCError) {
      if (error.code === "NOT_FOUND") notFound();
      if (error.code === "UNAUTHORIZED") redirect("/portal/sign-in");
    }
    throw error;
  }
}
