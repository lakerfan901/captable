"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { httpBatchStreamLink, loggerLink } from "@trpc/client";
import { createTRPCReact } from "@trpc/react-query";
import { useState } from "react";

import "@/lib/zod-error-map";
import type { AppRouter } from "@/trpc/api/root";
import { getUrl, transformer } from "./shared";

export const api = createTRPCReact<AppRouter>();

export function TRPCReactProvider(props: {
  children: React.ReactNode;
  cookies: string;
}) {
  const [queryClient] = useState(() => new QueryClient());

  const [trpcClient] = useState(() =>
    api.createClient({
      links: [
        loggerLink({
          enabled: (op) =>
            process.env.NODE_ENV === "development" ||
            (op.direction === "down" && op.result instanceof Error),
          // Outside development a failed call is logged without its input:
          // the input of a public page's call is its emailed token (W-9,
          // ballot, member report, signing link).
          ...(process.env.NODE_ENV !== "development" && {
            logger: (op) => {
              if (op.direction === "down" && op.result instanceof Error) {
                console.error(
                  `tRPC ${op.type} ${op.path} failed: ${op.result.message}`,
                );
              }
            },
          }),
        }),
        httpBatchStreamLink({
          transformer,
          url: getUrl(),
          headers() {
            return {
              cookie: props.cookies,
              "x-trpc-source": "react",
            };
          },
        }),
      ],
    }),
  );

  return (
    <QueryClientProvider client={queryClient}>
      <api.Provider client={trpcClient} queryClient={queryClient}>
        {props.children}
      </api.Provider>
    </QueryClientProvider>
  );
}
