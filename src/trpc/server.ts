import "server-only";

import { cookies } from "next/headers";
import { cache } from "react";

import { appRouter } from "@/trpc/api/root";
import { createCallerFactory, createTRPCContext } from "@/trpc/api/trpc";

/**
 * This wraps the `createTRPCContext` helper and provides the required context for the tRPC API when
 * handling a tRPC call from a React Server Component.
 */
const createContext = cache(async () => {
  return createTRPCContext({
    headers: new Headers({
      cookie: (await cookies()).toString(),
      "x-trpc-source": "rsc",
    }),
  });
});

/**
 * Server-side caller for React Server Components. Procedures are invoked directly (no HTTP); the
 * context is created lazily, once per request.
 *
 * @see https://trpc.io/docs/server/server-side-calls
 */
export const api = createCallerFactory(appRouter)(createContext, {
  onError: ({ path, error }) => {
    console.error(`❌ tRPC (rsc) failed on ${path ?? "<no-path>"}:`, error);
  },
});
