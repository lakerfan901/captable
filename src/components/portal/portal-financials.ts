import "server-only";

import { TRPCError } from "@trpc/server";
import { notFound, redirect } from "next/navigation";
import { cache } from "react";
import { todayInZone } from "@/lib/governance/dates";
import type { ReportSummary } from "@/lib/portal/portal-dashboard";
import { categoryLabel } from "@/lib/portal/portal-files-view";
import { api } from "@/trpc/server";

// The dashboard data of one holder for server pages (04-investor-portal.md
// 6.3; package P15). Through the RSC caller, so the same rules hold as for
// the browser: the portal session (G1), the access resolved against it on
// this request (P10), snapshots only, through the holder's published-through
// date as computed now (P33, P34). `cache` lets the layout (tab row) and the
// page of one request share one read. A page calls `requirePortalHolder`
// first; an access that disappears in between is the same 404.

export type PortalFinancials = Awaited<
  ReturnType<typeof api.portal.financials.get>
>;

async function portalRead<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof TRPCError) {
      if (error.code === "NOT_FOUND") notFound();
      if (error.code === "UNAUTHORIZED") redirect("/portal/sign-in");
    }
    throw error;
  }
}

/** `portal.financials.get` of the access, once per request. */
export const loadPortalFinancials = cache(
  (access: string): Promise<PortalFinancials> =>
    portalRead(() => api.portal.financials.get({ access })),
);

/** The visible reports, as the dashboard pages need them (fields picked, G4). */
export const loadPortalReportSummaries = cache(
  async (access: string): Promise<ReportSummary[]> => {
    const [list, { timeZone }] = await Promise.all([
      portalRead(() => api.portal.reports.list({ access })),
      loadPortalFinancials(access),
    ]);
    return list.map((r) => ({
      id: r.id,
      title: r.title,
      // the day in the company's time zone, as the restatement dates (P35)
      releasedOn: r.releasedAt ? todayInZone(r.releasedAt, timeZone) : null,
    }));
  },
);

export interface DocumentSummary {
  /** `Document.publicId`: what the Overview's file button asks a URL for (as on the Documents page). */
  id: string;
  name: string;
  /** PDF or image: opens in the viewer; anything else downloads. */
  inline: boolean;
  /** The investor-facing category label (`categoryLabel`, as on the Documents page), or "". */
  category: string;
  /** "YYYY-MM-DD" */
  sharedOn: string;
}

/** The documents shared with the holder, as the Overview's "Newest documents" card shows them. */
export const loadPortalDocumentSummaries = cache(
  async (
    access: string,
  ): Promise<{ sharedAt: Date; doc: DocumentSummary }[]> => {
    const [list, { timeZone }] = await Promise.all([
      portalRead(() => api.portal.documents.list({ access })),
      loadPortalFinancials(access),
    ]);
    return list.map((d) => ({
      sharedAt: d.sharedAt,
      doc: {
        id: d.id,
        name: d.name,
        inline: d.inline,
        category: categoryLabel(d.category),
        sharedOn: todayInZone(d.sharedAt, timeZone),
      },
    }));
  },
);
