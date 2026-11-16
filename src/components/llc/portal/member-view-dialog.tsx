"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { useAllowed } from "@/hooks/use-allowed";
import {
  accessNote,
  documentReason,
  financialsLine,
  previewHref,
  reportReason,
  reportSubtitle,
} from "@/lib/portal/member-view";
import { categoryLabel } from "@/lib/portal/portal-files-view";
import { plural } from "@/lib/portal/share-dialog-view";
import { useEntity } from "@/providers/entity-provider";
import { api } from "@/trpc/react";

/**
 * "See what this member sees" (04-investor-portal.md 6.2; package P9b): the
 * reports and documents one holder can see in the investor portal now, and
 * why, from `portalAdmin.holderView` (the portal's own visibility modules,
 * so the lists are exactly the portal's). The dashboard is not repeated
 * here: the dialog links to the team dashboard's "Preview as investor" on
 * this holder. Rendered only for a role with `portal: read` (the member
 * card and the Investor portal page are themselves behind it); the preview
 * link also needs `llc-financials: read`, and is absent without it.
 */
export function MemberViewDialog({
  stakeholderId,
  holderName,
  variant = "button",
}: {
  stakeholderId: string;
  holderName: string;
  /** `button`: an outline button (member card); `link`: a small text link (People table). */
  variant?: "button" | "link";
}) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {variant === "link" ? (
          <Button
            variant="link"
            size="sm"
            className="h-auto px-0"
            data-testid="member-view-open"
            aria-label={`See what ${holderName} sees`}
          >
            See what they see
          </Button>
        ) : (
          <Button variant="outline" size="sm" data-testid="member-view-open">
            See what this member sees
          </Button>
        )}
      </DialogTrigger>
      <DialogContent
        className="max-h-[90vh] overflow-y-auto sm:max-w-2xl"
        data-testid="member-view-dialog"
      >
        <DialogHeader>
          <DialogTitle className="pr-8 leading-snug">
            What {holderName} sees in the investor portal
          </DialogTitle>
          <DialogDescription>
            The reports and documents visible to this member right now, and why.
            Computed with the same rules as the portal itself.
          </DialogDescription>
        </DialogHeader>
        {open ? <MemberViewBody stakeholderId={stakeholderId} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function MemberViewBody({ stakeholderId }: { stakeholderId: string }) {
  const { timezone } = useEntity();
  const { publicId } = useParams<{ publicId: string }>();
  const { isAllowed: canFinancials } = useAllowed({
    subject: "llc-financials",
    action: "read",
  });
  // Always fresh: a share or unpublish a moment ago must show.
  const query = api.portalAdmin.holderView.useQuery(
    { stakeholderId },
    { staleTime: 0, refetchOnMount: "always" },
  );

  if (query.isLoading) {
    return <p className="text-sm text-muted-foreground">Loading…</p>;
  }
  if (query.error || !query.data) {
    return (
      <p className="text-sm text-destructive">
        {query.error?.message ?? "Could not load what this member sees."}
      </p>
    );
  }
  const v = query.data;
  const preview = canFinancials
    ? previewHref(publicId, stakeholderId, v.previewable)
    : null;

  return (
    <div className="flex flex-col gap-6 text-sm">
      <Alert>
        <AlertDescription data-testid="member-view-access">
          {accessNote(v.activeAccesses)}
        </AlertDescription>
      </Alert>

      <section className="flex flex-col gap-2" aria-labelledby="mv-reports">
        <h3 id="mv-reports" className="font-medium">
          Reports{" "}
          <span className="font-normal text-muted-foreground">
            ({v.reports.length})
          </span>
        </h3>
        {v.reports.length === 0 ? (
          <p
            className="text-muted-foreground"
            data-testid="member-view-no-reports"
          >
            No report is visible to this member. A report shows here once it is
            released to them and published in the portal.
          </p>
        ) : (
          <ul
            className="divide-y rounded-md border"
            data-testid="member-view-reports"
          >
            {v.reports.map((r) => (
              <li
                key={r.id}
                className="flex flex-col gap-0.5 px-3 py-2"
                data-testid="member-view-report"
                data-report={r.id}
              >
                <span className="break-words font-medium">{r.title}</span>
                <span className="text-xs text-muted-foreground">
                  {reportSubtitle(r)}
                </span>
                <span className="text-xs">{reportReason(r, timezone)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-2" aria-labelledby="mv-documents">
        <h3 id="mv-documents" className="font-medium">
          Documents{" "}
          <span className="font-normal text-muted-foreground">
            ({v.documents.length})
          </span>
        </h3>
        {v.documents.length === 0 ? (
          <p
            className="text-muted-foreground"
            data-testid="member-view-no-documents"
          >
            No document is shared with this member. Use “Share with investors”
            in Documents to share one.
          </p>
        ) : (
          <ul
            className="divide-y rounded-md border"
            data-testid="member-view-documents"
          >
            {v.documents.map((d) => {
              const category = categoryLabel(d.category);
              return (
                <li
                  key={d.id}
                  className="flex flex-col gap-0.5 px-3 py-2"
                  data-testid="member-view-document"
                  data-document={d.id}
                >
                  <span className="break-all font-medium">{d.name}</span>
                  {category ? (
                    <span className="text-xs text-muted-foreground">
                      {category}
                    </span>
                  ) : null}
                  <span className="text-xs">{documentReason(d, timezone)}</span>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-2" aria-labelledby="mv-financials">
        <h3 id="mv-financials" className="font-medium">
          Financials
        </h3>
        <p data-testid="member-view-financials">
          {financialsLine(v.publishedThrough)}
        </p>
        {preview ? (
          <div>
            <Button asChild variant="outline" size="sm">
              <Link href={preview} data-testid="member-view-preview">
                Open the dashboard as {v.holderName} sees it
              </Link>
            </Button>
          </div>
        ) : null}
      </section>

      <p className="text-xs text-muted-foreground">
        {plural(v.reports.length, "report", "reports")} and{" "}
        {plural(v.documents.length, "document", "documents")} visible now.
      </p>
    </div>
  );
}
