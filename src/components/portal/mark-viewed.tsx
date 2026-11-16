"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";
import { refusalAction, trpcErrorCode } from "@/lib/portal/portal-files-view";
import { api } from "@/trpc/react";

// Records that the holder opened a report (04-investor-portal.md 5.4, P31;
// package P8b): `portal.reports.markViewed` once per page load, from the
// browser, so the access log stores the client's address and not the RSC
// caller's 127.0.0.1 (2.2). The ref absorbs React's double effect in
// development. If the report is no longer visible by the time the call
// arrives, the page is re-rendered and shows "not available".

export function MarkReportViewed(props: { access: string; reportId: string }) {
  const router = useRouter();
  const markViewed = api.portal.reports.markViewed.useMutation();
  const done = useRef<string | null>(null);
  const { access, reportId } = props;
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per report; the mutation object changes identity on every render
  useEffect(() => {
    const key = `${access}/${reportId}`;
    if (done.current === key) return;
    done.current = key;
    markViewed.mutateAsync({ access, reportId }).catch((error: unknown) => {
      if (refusalAction(trpcErrorCode(error)) === "reload") router.refresh();
      // Otherwise best effort: the page works without it.
    });
  }, [access, reportId]);
  return null;
}
