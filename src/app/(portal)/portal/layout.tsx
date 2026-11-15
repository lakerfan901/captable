import type { Metadata } from "next";
import type { ReactNode } from "react";

// Every page of the investor portal (04-investor-portal.md 6.1; package
// P8a). The tab reads "Investor portal", never the team app's
// "… | Captable, Inc.", and no portal page is indexed. Portal pages inherit
// the root layout's providers; portal components use the tRPC React client
// but never `useSession` or anything from `@/providers/next-auth`.
//
// No portal page is cached or prerendered: each reads the portal cookie
// (directly or through `portal.me` on the RSC caller), or calls
// `connection()`, which makes it dynamic, and Next answers a dynamic page
// with `Cache-Control: private, no-cache, no-store`.

export const metadata: Metadata = {
  title: { absolute: "Investor portal" },
  robots: { index: false, follow: false },
};

export default function PortalLayout(props: { children: ReactNode }) {
  return props.children;
}
