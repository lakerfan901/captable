import "server-only";

import { TRPCError } from "@trpc/server";
import { notFound, redirect } from "next/navigation";
import { cache } from "react";
import {
  BOOKS_CATEGORY_KEYS,
  booksCategoryDef,
} from "@/lib/governance/books-core";
import type { ReportSummary } from "@/lib/portal/portal-dashboard";
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
    const list = await portalRead(() => api.portal.reports.list({ access }));
    return list.map((r) => ({
      id: r.id,
      title: r.title,
      releasedOn: r.releasedAt ? r.releasedAt.toISOString().slice(0, 10) : null,
    }));
  },
);

function categoryLabel(category: string | null): string | null {
  const key = BOOKS_CATEGORY_KEYS.find((k) => k === category);
  return key ? booksCategoryDef(key).label : null;
}

export interface DocumentSummary {
  name: string;
  category: string | null;
  /** "YYYY-MM-DD" */
  sharedOn: string;
}

/** The documents shared with the holder (names and dates only: no id leaves for the Overview). */
export const loadPortalDocumentSummaries = cache(
  async (
    access: string,
  ): Promise<{ sharedAt: Date; doc: DocumentSummary }[]> => {
    const list = await portalRead(() => api.portal.documents.list({ access }));
    return list.map((d) => ({
      sharedAt: d.sharedAt,
      doc: {
        name: d.name,
        category: categoryLabel(d.category),
        sharedOn: d.sharedAt.toISOString().slice(0, 10),
      },
    }));
  },
);
